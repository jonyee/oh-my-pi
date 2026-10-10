#!/usr/bin/env bun
/** Run the supplied Linux executable against an isolated, credential-free loopback provider. */
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";

const PROVIDER = "fork-binary-smoke";
const MODEL = "primary";
const PRIMARY_TEXT = "FORK_BINARY_PRIMARY_OK";
const TIMEOUT_MS = 60_000;
const OUTPUT_LIMIT = 1024 * 1024;
const FINDING_TEXT = "Native advisor finding reaches the display without another primary call.";
const ACCEPT_TEXT = "The advisor was requested but had no findings.";
const CANNOT_TELL_TEXT = "The advisor was requested but could not determine whether a correction is needed.";
const CARDS = [
	{
		customType: "advisor",
		content: "UNRENDERED_FINDING_PAYLOAD",
		display: true,
		attribution: "agent",
		details: { notes: [{ note: FINDING_TEXT, severity: "concern", advisor: "Fork smoke", turn: 0 }] },
	},
	{
		customType: "advisor",
		content: "UNRENDERED_ACCEPT_PAYLOAD",
		display: true,
		attribution: "agent",
		details: { notes: [], status: "accept" },
	},
	{
		customType: "advisor",
		content: "UNRENDERED_CANNOT_TELL_PAYLOAD",
		display: true,
		attribution: "agent",
		details: { notes: [], status: "cannot_tell" },
	},
] as const;

type Message = {
	role?: string;
	customType?: string;
	content?: unknown;
	display?: boolean;
	attribution?: string;
	details?: unknown;
	stopReason?: string;
	provider?: string;
	model?: string;
};
type Event = { type: string; message?: Message; isTerminal?: boolean; yielded?: boolean };

function requireCondition(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function killProcessGroup(child: ChildProcess): void {
	if (child.pid === undefined) return;
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
	}
}

async function runBinary(binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
	const child = spawn(binary, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	let outputBytes = 0;
	try {
		return await new Promise<string>((resolve, reject) => {
			const fail = (error: Error): void => {
				clearTimeout(timer);
				killProcessGroup(child);
				child.stdout?.destroy();
				child.stderr?.destroy();
				reject(error);
			};
			const timer = setTimeout(() => fail(new Error(`executable exceeded ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS);
			const append = (channel: "stdout" | "stderr", chunk: string): void => {
				outputBytes += Buffer.byteLength(chunk);
				if (outputBytes > OUTPUT_LIMIT) {
					fail(new Error("executable exceeded the 1 MiB output limit"));
					return;
				}
				if (channel === "stdout") stdout += chunk;
				else stderr += chunk;
			};
			child.stdout?.setEncoding("utf8");
			child.stderr?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => append("stdout", chunk));
			child.stderr?.on("data", (chunk: string) => append("stderr", chunk));
			child.stdout?.on("error", fail);
			child.stderr?.on("error", fail);
			child.once("error", error => {
				clearTimeout(timer);
				fail(error);
			});
			child.once("close", (code, signal) => {
				clearTimeout(timer);
				if (code !== 0) {
					reject(new Error(`executable exited ${code ?? signal}: ${stderr.slice(0, 4000)}`));
				} else if (/Extension error|Extension (?:sendMessage|sendUserMessage) failed/.test(stderr)) {
					reject(new Error(`extension failed: ${stderr.slice(0, 4000)}`));
				} else resolve(stdout);
			});
			child.stdin?.on("error", () => {});
			child.stdin?.end();
		});
	} finally {
		killProcessGroup(child);
	}
}

function extensionSource(baseUrl: string): string {
	// No renderer or provider registration: the executable owns delivery and presentation.
	return `export default function (pi) {
  const cards = ${JSON.stringify(CARDS)};
  let sentTurnEnd = false;
  let sentSessionStop = false;
  pi.on("turn_end", () => {
    if (sentTurnEnd) return;
    sentTurnEnd = true;
    for (const card of cards) pi.sendMessage(card, { triggerTurn: false });
  });
  pi.on("session_stop", async (event) => {
    if (sentSessionStop) return;
    sentSessionStop = true;
    const response = await fetch(${JSON.stringify(`${baseUrl}/gate`)}, { signal: event.signal });
    if (!response.ok || await response.text() !== "release") throw new Error("smoke gate failed");
  });
}
`;
}

function checkJson(stdout: string): void {
	const events = stdout
		.trim()
		.split(/\r?\n/)
		.map((line, index): Event => {
			const event = JSON.parse(line) as Event;
			requireCondition(event && typeof event.type === "string", `JSON line ${index + 1} is not an event`);
			return event;
		});
	const indices = (type: string): number[] => events.flatMap((event, index) => (event.type === type ? [index] : []));
	for (const type of ["agent_start", "turn_start", "turn_end", "agent_end"]) {
		requireCondition(indices(type).length === 1, `expected one ${type}, saw ${indices(type).length}`);
	}
	const assistantEnds = events.flatMap((event, index) =>
		event.type === "message_end" && event.message?.role === "assistant" ? [index] : [],
	);
	requireCondition(assistantEnds.length === 1, "expected one completed primary assistant message");
	const assistant = events[assistantEnds[0]]!.message!;
	requireCondition(assistant.stopReason === "stop", "primary did not stop normally");
	requireCondition(
		assistant.provider === PROVIDER && assistant.model === MODEL,
		"primary used the wrong provider/model",
	);
	requireCondition(
		isDeepStrictEqual(assistant.content, [{ type: "text", text: PRIMARY_TEXT }]),
		"primary text differs",
	);
	const advisorEvents = events.flatMap((event, index) =>
		(event.type === "message_start" || event.type === "message_end") && event.message?.customType === "advisor"
			? [{ event, index }]
			: [],
	);
	requireCondition(
		advisorEvents.length === CARDS.length * 2,
		`expected three native advisor pairs, saw ${advisorEvents.length} events`,
	);
	let previousIndex = indices("turn_end")[0]!;
	requireCondition(assistantEnds[0]! < previousIndex, "primary message did not precede turn_end");
	for (let cardIndex = 0; cardIndex < CARDS.length; cardIndex++) {
		const card = CARDS[cardIndex]!;
		for (const [offset, type] of ["message_start", "message_end"].entries()) {
			const { event, index } = advisorEvents[cardIndex * 2 + offset]!;
			const message = event.message!;
			requireCondition(event.type === type && index > previousIndex, "advisor pairs are not delivered FIFO");
			requireCondition(
				message.role === "custom" && message.display === true && message.attribution === "agent",
				"advisor is not a native displayable custom message",
			);
			requireCondition(
				message.content === card.content && isDeepStrictEqual(message.details, card.details),
				`advisor card ${cardIndex + 1} has incorrect content/details`,
			);
			previousIndex = index;
		}
	}
	const terminalIndex = indices("agent_end")[0]!;
	requireCondition(previousIndex < terminalIndex, "advisor delivery occurred after terminal agent_end");
	requireCondition(
		events[terminalIndex]!.isTerminal === true && events[terminalIndex]!.yielded === true,
		"agent_end is not terminal",
	);
}

async function runScenario(binary: string, root: string, mode: "json" | "text"): Promise<string> {
	const dir = path.join(root, mode);
	const home = path.join(dir, "home");
	const agentDir = path.join(dir, "agent");
	const cwd = path.join(dir, "work");
	const temp = path.join(dir, "tmp");
	await Promise.all(
		[home, agentDir, cwd, temp, "config", "cache", "data", "state", "runtime"].map(name =>
			mkdir(path.isAbsolute(name) ? name : path.join(dir, name), { recursive: true, mode: 0o700 }),
		),
	);
	let primaryCalls = 0;
	let gateCalls = 0;
	let gateReleased = false;
	let blockedEgress = 0;
	const fixtureErrors: string[] = [];
	const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		// Bun's proxy environment routes background remote catalog requests here, never to the internet.
		if (/^https?:\/\//.test(request.url ?? "")) {
			blockedEgress++;
			response.writeHead(503).end("offline smoke: external requests denied");
			return;
		}
		if (request.method === "GET" && request.url === "/gate") {
			gateCalls++;
			// A real awaited I/O boundary lets turn_end delivery race terminal maintenance as in the regression.
			await new Promise(resolve => setTimeout(resolve, 25));
			gateReleased = true;
			response.writeHead(200, { "Content-Type": "text/plain" }).end("release");
			return;
		}
		requireCondition(
			request.method === "POST" && request.url === "/v1/chat/completions",
			`unexpected fixture request: ${request.method} ${request.url}`,
		);
		primaryCalls++;
		requireCondition(
			!request.headers.authorization && !request.headers["x-api-key"],
			"fixture received API credentials",
		);
		let body = "";
		for await (const chunk of request) {
			body += chunk.toString();
			requireCondition(Buffer.byteLength(body) <= OUTPUT_LIMIT, "fixture request exceeds 1 MiB");
		}
		const payload = JSON.parse(body);
		requireCondition(
			payload.model === MODEL && payload.stream === true,
			"fixture received wrong model or non-streaming request",
		);
		requireCondition(
			Array.isArray(payload.messages) && payload.messages.some((message: Message) => message.role === "user"),
			"primary request has no user prompt",
		);
		requireCondition(!payload.tools || payload.tools.length === 0, "primary request unexpectedly enables tools");
		const chunk = (delta: unknown, finishReason: string | null = null) =>
			JSON.stringify({
				id: "fork-smoke",
				object: "chat.completion.chunk",
				created: 1,
				model: MODEL,
				choices: [{ index: 0, delta, finish_reason: finishReason }],
				...(finishReason ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
			});
		response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
		response.end(
			`data: ${chunk({ role: "assistant", content: PRIMARY_TEXT })}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`,
		);
	};
	const server = createServer((request, response) => {
		void handleRequest(request, response).catch(error => {
			fixtureErrors.push(String(error));
			response.writeHead(500).end("invalid smoke request");
		});
	});
	server.on("connect", (_request, socket) => {
		blockedEgress++;
		socket.destroy();
	});
	server.requestTimeout = 5000;
	server.headersTimeout = 5000;
	server.setTimeout(5000);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	try {
		const address = server.address();
		requireCondition(address && typeof address !== "string", "fixture has no loopback address");
		const baseUrl = `http://127.0.0.1:${address.port}`;
		const extension = path.join(dir, "advisor.ts");
		await writeFile(extension, extensionSource(baseUrl), { mode: 0o600 });
		await writeFile(
			path.join(agentDir, "models.yml"),
			`providers:\n  ${PROVIDER}:\n    baseUrl: ${baseUrl}/v1\n    api: openai-completions\n    auth: none\n    authHeader: false\n    models:\n      - id: ${MODEL}\n        name: Offline primary\n        reasoning: false\n        input: [text]\n        contextWindow: 32768\n        maxTokens: 256\n        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }\n`,
			{ mode: 0o600 },
		);
		await writeFile(
			path.join(agentDir, "config.yml"),
			`enabledProviders: [${PROVIDER}]\ndisabledProviders: [ollama, llama.cpp, lm-studio, apple-foundation-models, local, web]\nadvisor:\n  enabled: false\ncompaction:\n  enabled: false\nretry:\n  enabled: false\ntodo:\n  enabled: false\nmarketplace:\n  autoUpdate: off\ntelemetry:\n  otlpExportEnabled: false\n`,
			{ mode: 0o600 },
		);
		// Deliberately do not inherit API keys, auth-broker/OTEL variables, profiles, or user config.
		const env: NodeJS.ProcessEnv = {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			LANG: "C.UTF-8",
			HOME: home,
			TMPDIR: temp,
			XDG_CONFIG_HOME: path.join(dir, "config"),
			XDG_CACHE_HOME: path.join(dir, "cache"),
			XDG_DATA_HOME: path.join(dir, "data"),
			XDG_STATE_HOME: path.join(dir, "state"),
			XDG_RUNTIME_DIR: path.join(dir, "runtime"),
			PI_CODING_AGENT_DIR: agentDir,
			PI_NO_TITLE: "1",
			NO_COLOR: "1",
			TERM: "dumb",
			CI: "true",
			HTTP_PROXY: baseUrl,
			HTTPS_PROXY: baseUrl,
			ALL_PROXY: baseUrl,
			http_proxy: baseUrl,
			https_proxy: baseUrl,
			all_proxy: baseUrl,
			NO_PROXY: "127.0.0.1",
			no_proxy: "127.0.0.1",
		};
		const stdout = await runBinary(
			binary,
			[
				"--mode",
				mode,
				"-p",
				"--provider",
				PROVIDER,
				"--model",
				MODEL,
				"--no-session",
				"--no-title",
				"--no-tools",
				"--no-lsp",
				"--no-skills",
				"--no-rules",
				"--no-extensions",
				"-e",
				extension,
				"Reply with the deterministic fixture response.",
			],
			cwd,
			env,
		);
		requireCondition(fixtureErrors.length === 0, fixtureErrors.join("; "));
		requireCondition(primaryCalls === 1, `expected exactly one primary call, saw ${primaryCalls}`);
		requireCondition(gateCalls === 1 && gateReleased, `expected one awaited session_stop gate, saw ${gateCalls}`);
		if (mode === "json") checkJson(stdout);
		else {
			const expected = `Advisor — 1 note\n\n[CONCERN] [Fork smoke] ${FINDING_TEXT}\n${ACCEPT_TEXT}\n${CANNOT_TELL_TEXT}\n${PRIMARY_TEXT}\n`;
			requireCondition(
				stdout.replace(/\r\n/g, "\n") === expected,
				`incorrect native findings/status text: ${JSON.stringify(stdout.slice(0, 4000))}`,
			);
		}
		return `${mode}: primary=1 advisor=3 gate=1${mode === "json" ? " FIFO-before-terminal" : " findings+accept+cannot_tell"} egress-blocked=${blockedEgress}`;
	} finally {
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
	const [binary] = argv;
	requireCondition(process.platform === "linux", "fork binary smoke supports Linux only");
	requireCondition(
		argv.length === 1 && binary && path.isAbsolute(binary),
		"usage: ci-fork-binary-smoke.ts <absolute-executable>",
	);
	await access(binary, constants.X_OK);
	requireCondition((await stat(binary)).isFile(), "supplied executable is not a file");
	const root = await mkdtemp(path.join(tmpdir(), "omp-fork-binary-smoke-"));
	try {
		for (const mode of ["json", "text"] as const) {
			try {
				console.log(`Fork binary smoke ${await runScenario(binary, root, mode)}`);
			} catch (error) {
				throw new Error(`${mode} scenario: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		console.error(`Fork binary smoke failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
