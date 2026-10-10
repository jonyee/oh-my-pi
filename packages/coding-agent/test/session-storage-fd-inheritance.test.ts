/**
 * Descriptors omp holds for its own lifetime — session/advisor transcripts and
 * the rotating log — must not reach the commands the bash tool runs.
 *
 * The bash tool executes through the natives brush shell, which `fork`/`exec`s
 * external commands and therefore hands every inheritable descriptor to them
 * (the same property pinned by `config-value-fd-inheritance.test.ts`). Bun's
 * `fs.open*` omits `O_CLOEXEC` where libuv adds it, so before #13224 a command
 * — or any daemon it started — held a writable handle to the session it was
 * launched from for its whole life.
 *
 * Oracle: run the production writer/log and native shell in a fresh Bun child.
 * Its launcher explicitly maps the control descriptor to FD 3, independent of
 * fs.open defaults and neighboring tests' process-wide mocks. The same shell
 * child must inherit that control but not the transcript or log. /proc makes
 * this Linux-only; flag handling is covered by packages/utils/test/fs-open.test.ts.
 */
import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils/temp";

const ROOTS: string[] = [];

afterAll(async () => {
	for (const root of ROOTS) await removeWithRetries(root).catch(() => {});
});

test.skipIf(process.platform !== "linux")("bash tool children never inherit session or log descriptors", async () => {
	const root = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-fd-"));
	ROOTS.push(root);

	const control = path.join(root, "control.jsonl");
	const controlFd = fs.openSync(control, "a");
	const script = `
import * as fs from "node:fs";
import { Shell } from ${JSON.stringify(import.meta.resolve("@oh-my-pi/pi-natives"))};
import { RotatingFileSink } from ${JSON.stringify(import.meta.resolve("@oh-my-pi/pi-utils/logger/rotating-file"))};
import { FileSessionStorage } from ${JSON.stringify(new URL("../src/session/session-storage.ts", import.meta.url).href)};
const root = ${JSON.stringify(root)};
const transcript = root + "/session.jsonl";
const writer = new FileSessionStorage().openWriter(transcript);
await writer.append('{"type":"session_start"}\\n');
fs.mkdirSync(root + "/logs");
const logSink = new RotatingFileSink({
  directory: root + "/logs", filenamePrefix: "omp", filenameSuffix: String(process.pid),
  maxBytes: 1 << 20, maxFiles: 2,
});
logSink.write("entry");
let output = "";
const errors = [];
try {
  const flags = /^flags:\\s+(\\d+)$/m.exec(fs.readFileSync("/proc/self/fdinfo/3", "utf8"));
  if (!flags || (Number.parseInt(flags[1], 8) & 0o2000000)) throw new Error("control FD 3 is not inheritable");
  const result = await new Shell().run({ command: "sh -c 'ls -l /proc/$$/fd'", cwd: root, timeoutMs: 5000 }, (error, chunk) => {
    if (error) errors.push(String(error));
    output += chunk;
  });
  console.log(JSON.stringify({ result, errors, output }));
} finally {
  logSink.close();
  await writer.close();
}
`;
	let stdout: string;
	try {
		const child = Bun.spawn({
			cmd: [process.execPath, "--eval", script],
			cwd: process.cwd(),
			stdio: ["ignore", "pipe", "pipe", controlFd],
			timeout: 15_000,
		});
		const [out, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		stdout = out;
	} finally {
		fs.closeSync(controlFd);
	}
	const { result, errors, output } = JSON.parse(stdout) as {
		result: { exitCode: number; cancelled: boolean; timedOut: boolean };
		errors: string[];
		output: string;
	};
	expect(result).toMatchObject({ exitCode: 0, cancelled: false, timedOut: false });
	expect(errors).toEqual([]);
	const inherited = output.split("\n").filter(line => line.includes(root));
	expect(inherited.join("\n"), `control: FD 3 must reach the shell child; output: ${output}`).toContain(control);
	expect(inherited.join("\n")).not.toContain(path.join(root, "session.jsonl"));
	expect(inherited.join("\n")).not.toMatch(/omp\.[\d-]+\.\d+\.log/);
});
