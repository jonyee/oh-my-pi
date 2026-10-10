#!/usr/bin/env bun
/** Stage pinned upstream Linux addons without compiling or publishing native code. */
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const NATIVE_VERSION = "18.8.9";
const SOURCE_OBJECTS = {
	crates: "4df7de053dcc11c608be7f98eb44740765f7b162",
	"packages/natives": "4dffd0dfd3248cde0c9ca9ae75892b39b01e340b",
	"Cargo.toml": "f4e1613580c19ca211b287763b3f1948970118aa",
	"Cargo.lock": "8d345931a67a9121bf19eab7ba1d6e2cd9176cc1",
};

export interface NativeTarget {
	id: "linux-arm64" | "linux-x64";
	url: string;
	integrity: string;
	files: readonly string[];
}

const TARGETS: readonly NativeTarget[] = [
	{
		id: "linux-arm64",
		url: "https://registry.npmjs.org/@oh-my-pi/pi-natives-linux-arm64/-/pi-natives-linux-arm64-18.8.9.tgz",
		integrity: "sha512-xfARj/W2pYKmh1wOQyItWopltw+yM0hAu2O76MFqOvQ48NCL0NuHXh7f+D9+fxPVPhK/4r6rqed53Y2gXZRR2Q==",
		files: ["pi_natives.linux-arm64.node"],
	},
	{
		id: "linux-x64",
		url: "https://registry.npmjs.org/@oh-my-pi/pi-natives-linux-x64/-/pi-natives-linux-x64-18.8.9.tgz",
		integrity: "sha512-8EtejfmJCAEOKNmsrCl2Kbe4bFZFY7rA5/6s8E7EwaOXRxTQCnzU5qk5mxz50k6q3aKdPGsq/FmfZg2iSwis/Q==",
		files: ["pi_natives.linux-x64-baseline.node", "pi_natives.linux-x64-modern.node"],
	},
];

export function parseNativeTarget(value: string | undefined): NativeTarget {
	const target = TARGETS.find(candidate => candidate.id === value);
	if (!target) throw new Error("Expected native target linux-arm64 or linux-x64");
	return target;
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/** Check only HEAD's known native-source inventory, not the whole repository or its history. */
export async function assertNativeWorkingCopy(
	repoRoot: string,
	gitArgs: readonly string[],
	ref: string,
): Promise<void> {
	const inventory = (
		await $`git ${gitArgs} ls-tree -r -z ${ref} -- ${Object.keys(SOURCE_OBJECTS)}`.cwd(repoRoot).quiet()
	).text();
	const regularFiles: { file: string; oid: string }[] = [];
	for (const entry of inventory.split("\0").filter(Boolean)) {
		const match = /^(100644|100755|120000) blob ([a-f0-9]{40})\t(.+)$/s.exec(entry);
		if (!match) throw new Error(`Unsupported native source entry: ${entry}`);
		const [, mode, oid, file] = match;
		const absolute = path.join(repoRoot, file);
		const stat = await fs.lstat(absolute);
		if (mode === "120000") {
			if (!stat.isSymbolicLink()) throw new Error(`Native working-copy source changed: ${file}`);
			const link = await fs.readlink(absolute);
			const hash = new Bun.CryptoHasher("sha1");
			hash.update(`blob ${Buffer.byteLength(link)}\0`);
			hash.update(link);
			if (hash.digest("hex") !== oid) throw new Error(`Native working-copy source changed: ${file}`);
		} else {
			if (!stat.isFile() || Boolean(stat.mode & 0o111) !== (mode === "100755")) {
				throw new Error(`Native working-copy source changed: ${file}`);
			}
			if (/[\r\n]/.test(file) || file.startsWith('"'))
				throw new Error(`Unsupported native source filename: ${file}`);
			regularFiles.push({ file, oid });
		}
	}
	if (regularFiles.length === 0) throw new Error("Native source inventory is empty");
	// Git applies the checkout's attributes/clean filters, including mandated CRLF files.
	const input = Buffer.from(`${regularFiles.map(entry => entry.file).join("\n")}\n`);
	const hashes = (await $`git ${gitArgs} hash-object --stdin-paths < ${input}`.cwd(repoRoot).quiet())
		.text()
		.trim()
		.split("\n");
	if (hashes.length !== regularFiles.length) throw new Error("Incomplete native working-copy source hashes");
	for (let index = 0; index < regularFiles.length; index++) {
		if (hashes[index] !== regularFiles[index].oid) {
			throw new Error(`Native working-copy source changed: ${regularFiles[index].file}`);
		}
	}
}

export async function assertNativeSource(repoRoot: string): Promise<void> {
	const manifest: unknown = await Bun.file(path.join(repoRoot, "packages/natives/package.json")).json();
	if (
		typeof manifest !== "object" ||
		manifest === null ||
		!("version" in manifest) ||
		manifest.version !== NATIVE_VERSION
	) {
		throw new Error(`packages/natives/package.json must have version ${NATIVE_VERSION}`);
	}
	let gitArgs: string[];
	let ref = "HEAD";
	if (await exists(path.join(repoRoot, ".git"))) {
		gitArgs = ["-C", repoRoot];
	} else {
		const gitDir = path.join(repoRoot, ".jj/repo/store/git");
		if (!(await exists(gitDir))) throw new Error("Expected a Git checkout or local Jujutsu Git backend");
		gitArgs = [`--git-dir=${gitDir}`, `--work-tree=${repoRoot}`];
		// Jujutsu's backend HEAD can be unborn. Read only the current commit, without snapshotting the working copy.
		ref = (await $`jj --ignore-working-copy log --no-graph -r @ -T commit_id`.cwd(repoRoot).text()).trim();
		if (!/^[a-f0-9]{40}$/.test(ref)) throw new Error("Could not resolve the Jujutsu working-copy commit");
	}
	const sourcePaths = Object.keys(SOURCE_OBJECTS);
	const objects = (
		await $`git ${gitArgs} rev-parse ${sourcePaths.map(source => `${ref}:${source}`)}`.cwd(repoRoot).text()
	)
		.trim()
		.split("\n");
	for (const [index, [source, expected]] of Object.entries(SOURCE_OBJECTS).entries()) {
		if (objects[index] !== expected)
			throw new Error(`Native source changed: ${source}; pinned addons require ${expected}`);
	}
	await assertNativeWorkingCopy(repoRoot, gitArgs, ref);
}

async function downloadVerifiedArchive(response: Response, archive: string, integrity: string): Promise<void> {
	if (!response.ok || !response.body) throw new Error(`Native addon download failed: HTTP ${response.status}`);
	const hash = new Bun.CryptoHasher("sha512");
	const writer = Bun.file(archive).writer();
	try {
		for await (const chunk of response.body) {
			hash.update(chunk);
			writer.write(chunk);
			await writer.flush();
		}
	} finally {
		await writer.end();
	}
	if (`sha512-${hash.digest("base64")}` !== integrity) {
		throw new Error("Native addon archive integrity mismatch; no addons installed");
	}
}

/** Extract only the pinned target's explicit addon members and its identity metadata. */
export async function stageNativeArchive(target: NativeTarget, archive: string, stagingDir: string): Promise<void> {
	await fs.mkdir(stagingDir);
	const members = ["package/package.json", ...target.files.map(file => `package/${file}`)];
	await $`tar --extract --gzip --file ${archive} --directory ${stagingDir} --no-same-owner --no-same-permissions -- ${members}`.quiet();
	const packageDir = path.join(stagingDir, "package");
	for (const file of ["package.json", ...target.files]) {
		const stat = await fs.lstat(path.join(packageDir, file));
		if (!stat.isFile() || stat.size === 0 || (file === "package.json" && stat.size > 64 * 1024)) {
			throw new Error(`Invalid native archive member: ${file}`);
		}
	}
	const manifest: unknown = await Bun.file(path.join(packageDir, "package.json")).json();
	if (
		typeof manifest !== "object" ||
		manifest === null ||
		!("name" in manifest) ||
		manifest.name !== `@oh-my-pi/pi-natives-${target.id}` ||
		!("version" in manifest) ||
		manifest.version !== NATIVE_VERSION
	) {
		throw new Error(`Native archive package identity must be @oh-my-pi/pi-natives-${target.id}@${NATIVE_VERSION}`);
	}
}

/** Validate the whole payload before atomic per-addon replacements; keep the existing JS bindings. */
export async function installNativeAddons(target: NativeTarget, nativeDir: string, response?: Response): Promise<void> {
	const temp = await fs.mkdtemp(path.join(path.dirname(nativeDir), ".fork-native-"));
	try {
		const archive = path.join(temp, "native.tgz");
		await downloadVerifiedArchive(response ?? (await fetch(target.url)), archive, target.integrity);
		const stagingDir = path.join(temp, "extracted");
		await stageNativeArchive(target, archive, stagingDir);
		await fs.mkdir(nativeDir, { recursive: true });
		for (const file of target.files) {
			await fs.rename(path.join(stagingDir, "package", file), path.join(nativeDir, file));
		}
	} finally {
		await fs.rm(temp, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	if (process.argv.length !== 3) throw new Error("usage: ci-fork-native-addons.ts <linux-arm64|linux-x64>");
	const target = parseNativeTarget(process.argv[2]);
	const repoRoot = path.resolve(import.meta.dir, "..");
	await assertNativeSource(repoRoot);
	await installNativeAddons(target, path.join(repoRoot, "packages/natives/native"));
	console.log(`Installed pinned native addons ${NATIVE_VERSION} for ${target.id}`);
}

if (import.meta.main) {
	await main();
}
