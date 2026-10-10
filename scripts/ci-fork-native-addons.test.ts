import { describe, expect, it } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	assertNativeSource,
	assertNativeWorkingCopy,
	installNativeAddons,
	parseNativeTarget,
	stageNativeArchive,
} from "./ci-fork-native-addons";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fork-native-test-"));
	try {
		await run(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function archiveFixture(
	dir: string,
	files: readonly string[],
	manifest: unknown = { name: "@oh-my-pi/pi-natives-linux-x64", version: "18.8.9" },
	symlink?: string,
): Promise<string> {
	const packageDir = path.join(dir, "payload/package");
	await fs.mkdir(packageDir, { recursive: true });
	await Bun.write(path.join(packageDir, "package.json"), JSON.stringify(manifest));
	for (const file of files) await Bun.write(path.join(packageDir, file), `archive fixture: ${file}`);
	if (symlink) await fs.symlink("package.json", path.join(packageDir, symlink));
	const archive = path.join(dir, "native.tgz");
	await $`tar --create --gzip --file ${archive} --directory ${path.dirname(packageDir)} package`.quiet();
	return archive;
}

async function archiveIntegrity(archive: string): Promise<string> {
	const hash = new Bun.CryptoHasher("sha512");
	for await (const chunk of Bun.file(archive).stream()) hash.update(chunk);
	return `sha512-${hash.digest("base64")}`;
}

async function gitFixture(dir: string): Promise<void> {
	await fs.mkdir(path.join(dir, "crates/example/src"), { recursive: true });
	await fs.mkdir(path.join(dir, "packages/natives"), { recursive: true });
	await Bun.write(path.join(dir, "crates/example/src/lib.rs"), "pub fn example() {}\n");
	await Bun.write(path.join(dir, "packages/natives/package.json"), '{"version":"18.8.9"}\n');
	await Bun.write(path.join(dir, "Cargo.toml"), "[workspace]\nmembers = []\n");
	await Bun.write(path.join(dir, "Cargo.lock"), "version = 4\n");
	await $`git init --quiet ${dir}`.quiet();
	await $`git -C ${dir} add -- crates packages/natives Cargo.toml Cargo.lock`.quiet();
	await $`git -C ${dir} -c user.name=Fixture -c user.email=fixture@example.invalid commit --quiet -m fixture`.quiet();
}

describe("pinned native archive safety", () => {
	it("rejects tampered streamed bytes before extraction or destination changes, then cleans up", async () => {
		await withTempDir(async dir => {
			const nativeDir = path.join(dir, "native");
			await fs.mkdir(nativeDir);
			const target = parseNativeTarget("linux-x64");
			for (const file of target.files) await Bun.write(path.join(nativeDir, file), "existing addon");
			await Bun.write(path.join(nativeDir, "index.js"), "existing bindings");
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("tampered "));
					controller.enqueue(new TextEncoder().encode("archive bytes"));
					controller.close();
				},
			});
			await expect(installNativeAddons(target, nativeDir, new Response(body))).rejects.toThrow("integrity mismatch");
			for (const file of target.files)
				expect(await Bun.file(path.join(nativeDir, file)).text()).toBe("existing addon");
			expect(await Bun.file(path.join(nativeDir, "index.js")).text()).toBe("existing bindings");
			expect(await fs.readdir(dir)).toEqual(["native"]);
		});
	});

	it("rejects unsuccessful downloads and removes temporary files", async () => {
		await withTempDir(async dir => {
			const nativeDir = path.join(dir, "native");
			await fs.mkdir(nativeDir);
			await expect(
				installNativeAddons(parseNativeTarget("linux-arm64"), nativeDir, new Response(null, { status: 404 })),
			).rejects.toThrow("HTTP 404");
			expect(await fs.readdir(dir)).toEqual(["native"]);
			expect(await fs.readdir(nativeDir)).toEqual([]);
		});
	});

	it("rejects a checksum-valid partial x64 archive without replacing either installed addon", async () => {
		await withTempDir(async dir => {
			const target = parseNativeTarget("linux-x64");
			const archive = await archiveFixture(dir, ["pi_natives.linux-x64-baseline.node"]);
			const nativeDir = path.join(dir, "native");
			await fs.mkdir(nativeDir);
			for (const file of target.files) await Bun.write(path.join(nativeDir, file), "existing addon");
			await expect(
				installNativeAddons(
					{ ...target, integrity: await archiveIntegrity(archive) },
					nativeDir,
					new Response(Bun.file(archive)),
				),
			).rejects.toThrow();
			for (const file of target.files)
				expect(await Bun.file(path.join(nativeDir, file)).text()).toBe("existing addon");
			expect((await fs.readdir(dir)).sort()).toEqual(["native", "native.tgz", "payload"]);
		});
	});

	it("installs only required addons while preserving bindings, not unrelated archive members", async () => {
		await withTempDir(async dir => {
			const target = parseNativeTarget("linux-x64");
			const archive = await archiveFixture(dir, [...target.files, "unrelated.node"]);
			const nativeDir = path.join(dir, "native");
			await fs.mkdir(nativeDir);
			for (const file of target.files) await Bun.write(path.join(nativeDir, file), "existing addon");
			await Bun.write(path.join(nativeDir, "index.js"), "existing bindings");
			await installNativeAddons(
				{ ...target, integrity: await archiveIntegrity(archive) },
				nativeDir,
				new Response(Bun.file(archive)),
			);
			for (const file of target.files) {
				expect(await Bun.file(path.join(nativeDir, file)).text()).toBe(`archive fixture: ${file}`);
			}
			expect(await Bun.file(path.join(nativeDir, "index.js")).text()).toBe("existing bindings");
			expect((await fs.readdir(nativeDir)).sort()).toEqual(["index.js", ...target.files].sort());
			expect((await fs.readdir(dir)).sort()).toEqual(["native", "native.tgz", "payload"]);
		});
	});

	it.each([
		{ name: "@oh-my-pi/pi-natives-linux-arm64", version: "18.8.9" },
		{ name: "@oh-my-pi/pi-natives-linux-x64", version: "18.8.8" },
	])("rejects wrong package identity %j", async manifest => {
		await withTempDir(async dir => {
			const target = parseNativeTarget("linux-x64");
			const archive = await archiveFixture(dir, target.files, manifest);
			await expect(stageNativeArchive(target, archive, path.join(dir, "staged"))).rejects.toThrow(
				"package identity",
			);
		});
	});

	it("rejects an addon member that is a symlink instead of a regular file", async () => {
		await withTempDir(async dir => {
			const target = parseNativeTarget("linux-x64");
			const archive = await archiveFixture(dir, [target.files[0]], undefined, target.files[1]);
			await expect(stageNativeArchive(target, archive, path.join(dir, "staged"))).rejects.toThrow(
				"Invalid native archive member",
			);
		});
	});
});

describe("native source guards", () => {
	it.each(["18.8.8", 18, null])("rejects manifest version %j before needing a Git checkout", async version => {
		await withTempDir(async dir => {
			await fs.mkdir(path.join(dir, "packages/natives"), { recursive: true });
			await Bun.write(path.join(dir, "packages/natives/package.json"), JSON.stringify({ version }));
			await expect(assertNativeSource(dir)).rejects.toThrow("must have version 18.8.9");
		});
	});

	it("rejects a different committed Rust source tree even when the native version matches", async () => {
		await withTempDir(async dir => {
			await gitFixture(dir);
			await expect(assertNativeSource(dir)).rejects.toThrow("Native source changed: crates");
		});
	});

	it("checks tracked source content without inspecting unrelated working-copy files", async () => {
		await withTempDir(async dir => {
			await gitFixture(dir);
			await Bun.write(path.join(dir, "unrelated"), "untracked changes outside native sources");
			await assertNativeWorkingCopy(dir, ["-C", dir], "HEAD");
			await Bun.write(path.join(dir, "crates/example/src/lib.rs"), "pub fn changed() {}\n");
			await expect(assertNativeWorkingCopy(dir, ["-C", dir], "HEAD")).rejects.toThrow(
				"Native working-copy source changed: crates/example/src/lib.rs",
			);
		});
	});

	it.each(["Cargo.toml", "Cargo.lock"])("rejects working-copy dependency graph changes to %s", async file => {
		await withTempDir(async dir => {
			await gitFixture(dir);
			await Bun.write(path.join(dir, file), "changed dependency graph\n");
			await expect(assertNativeWorkingCopy(dir, ["-C", dir], "HEAD")).rejects.toThrow(
				`Native working-copy source changed: ${file}`,
			);
		});
	});

	it("rejects a tracked source replaced by a symlink", async () => {
		await withTempDir(async dir => {
			await gitFixture(dir);
			const source = path.join(dir, "crates/example/src/lib.rs");
			await fs.unlink(source);
			await fs.symlink("../../../packages/natives/package.json", source);
			await expect(assertNativeWorkingCopy(dir, ["-C", dir], "HEAD")).rejects.toThrow(
				"Native working-copy source changed: crates/example/src/lib.rs",
			);
		});
	});
});
