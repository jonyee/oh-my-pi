import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession idle custom message render", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-idle-custom-render-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	function createSession(): { session: AgentSession; streamCalls: () => number } {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		let streamCallCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: () => {
				streamCallCount++;
				return new AssistantMessageEventStream();
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
		});
		return { session: created, streamCalls: () => streamCallCount };
	}

	it("idle display:true no-trigger append paints exactly once without a turn", async () => {
		const created = createSession();
		session = created.session;

		const events: { type: string; customType?: string }[] = [];
		session.subscribe(event => {
			if (event.type === "message_start" || event.type === "message_end") {
				events.push({
					type: event.type,
					customType: event.message.role === "custom" ? event.message.customType : undefined,
				});
			} else {
				events.push({ type: event.type });
			}
		});

		expect(session.isStreaming).toBe(false);
		const dispatched = await session.sendCustomMessage(
			{ customType: "idle-status", content: "IDLE_DISPLAY_BODY", display: true, attribution: "agent" },
			{ triggerTurn: false },
		);

		// No turn started.
		expect(dispatched).toBe(false);
		expect(session.isStreaming).toBe(false);
		expect(created.streamCalls()).toBe(0);
		expect(events.some(e => e.type === "agent_start" || e.type === "agent_end")).toBe(false);

		// Painted exactly once via a message_start/message_end pair (fails pre-fix: no events).
		const starts = events.filter(e => e.type === "message_start" && e.customType === "idle-status");
		const ends = events.filter(e => e.type === "message_end" && e.customType === "idle-status");
		expect(starts.length).toBe(1);
		expect(ends.length).toBe(1);

		// Present exactly once in agent state.
		const inState = session.agent.state.messages.filter(m => m.role === "custom" && m.customType === "idle-status");
		expect(inState.length).toBe(1);

		// Persisted exactly once by the time the promise resolves.
		const persisted = session.sessionManager
			.getEntries()
			.filter(e => e.type === "custom_message" && e.customType === "idle-status");
		expect(persisted.length).toBe(1);

		// Rebuild-from-entries yields one copy — no duplicate after a reload/re-enter.
		const rebuilt = session
			.buildDisplaySessionContext()
			.messages.filter(m => m.role === "custom" && m.customType === "idle-status");
		expect(rebuilt.length).toBe(1);
	});

	it("idle display:false no-trigger append stays silent", async () => {
		const created = createSession();
		session = created.session;

		const events: { type: string; customType?: string }[] = [];
		session.subscribe(event => {
			if (event.type === "message_start" || event.type === "message_end") {
				events.push({
					type: event.type,
					customType: event.message.role === "custom" ? event.message.customType : undefined,
				});
			}
		});

		const dispatched = await session.sendCustomMessage(
			{ customType: "idle-hidden", content: "IDLE_HIDDEN_BODY", display: false, attribution: "agent" },
			{ triggerTurn: false },
		);

		expect(dispatched).toBe(false);
		expect(created.streamCalls()).toBe(0);
		expect(events.filter(e => e.customType === "idle-hidden").length).toBe(0);

		const inState = session.agent.state.messages.filter(m => m.role === "custom" && m.customType === "idle-hidden");
		expect(inState.length).toBe(1);

		const persisted = session.sessionManager
			.getEntries()
			.filter(e => e.type === "custom_message" && e.customType === "idle-hidden");
		expect(persisted.length).toBe(1);
	});

	it("default no-trigger messages wait for the complete tool batch and append FIFO exactly once without an extra request", async () => {
		const toolStarted = Promise.withResolvers<void>();
		const releaseTool = Promise.withResolvers<void>();
		const finalCallStarted = Promise.withResolvers<void>();
		const releaseFinalCall = Promise.withResolvers<void>();
		const slowTool: AgentTool = {
			name: "slow",
			label: "Slow",
			description: "Wait for the test gate",
			parameters: type({}),
			concurrency: "exclusive",
			execute: async (_id, _params, signal) => {
				toolStarted.resolve();
				await releaseTool.promise;
				expect(signal?.aborted).toBe(false);
				return { content: [{ type: "text", text: "SLOW_RESULT" }] };
			},
		};
		const nextTool: AgentTool = {
			name: "next",
			label: "Next",
			description: "Complete the batch",
			parameters: type({}),
			concurrency: "exclusive",
			execute: async () => ({ content: [{ type: "text", text: "NEXT_RESULT" }] }),
		};
		const mock = createMockModel({
			provider: "openai",
			id: "gpt-test",
			responses: [
				{
					content: [
						{ type: "toolCall", id: "slow-1", name: "slow", arguments: {} },
						{ type: "toolCall", id: "next-1", name: "next", arguments: {} },
					],
				},
				async () => {
					finalCallStarted.resolve();
					await releaseFinalCall.promise;
					return { content: ["Done"] };
				},
			],
			handler: { content: ["Unexpected continuation"] },
		});
		session = createRunningSession(mock, [slowTool, nextTool]);
		const events = observeCustomMessages(session);
		const run = session.prompt("go");
		try {
			await toolStarted.promise;
			for (const content of ["FIRST_CARD", "SECOND_CARD"]) {
				expect(
					await session.sendCustomMessage(
						{ customType: "advisor", content, display: true },
						{ triggerTurn: false },
					),
				).toBe(false);
			}
			expect(events).toEqual([]);
			expect(customContents(session.messages)).toEqual([]);
			expect(persistedCustomContents(session)).toEqual([]);
			expect(session.agent.hasQueuedMessages()).toBe(false);
			releaseTool.resolve();
			await finalCallStarted.promise;

			// Cards are already visible at the safe boundary, not delayed until idle.
			expect(customContents(session.messages)).toEqual(["FIRST_CARD", "SECOND_CARD"]);
			expect(persistedCustomContents(session)).toEqual(["FIRST_CARD", "SECOND_CARD"]);
			expect(events).toEqual([
				"message_start:FIRST_CARD",
				"message_end:FIRST_CARD",
				"message_start:SECOND_CARD",
				"message_end:SECOND_CARD",
			]);
			const roles = session.messages.map(message => message.role);
			const firstCard = session.messages.findIndex(
				message => message.role === "custom" && message.content === "FIRST_CARD",
			);
			expect(roles.slice(firstCard - 3, firstCard)).toEqual(["assistant", "toolResult", "toolResult"]);
			const persistedRoles = session.sessionManager
				.getEntries()
				.flatMap(entry =>
					entry.type === "message" ? [entry.message.role] : entry.type === "custom_message" ? ["custom"] : [],
				);
			expect(persistedRoles.slice(-5)).toEqual(["assistant", "toolResult", "toolResult", "custom", "custom"]);
		} finally {
			releaseTool.resolve();
			releaseFinalCall.resolve();
			await run;
		}
		expect(mock.calls).toHaveLength(2);
		expect(customContents(session.messages)).toEqual(["FIRST_CARD", "SECOND_CARD"]);
		expect(persistedCustomContents(session)).toEqual(["FIRST_CARD", "SECOND_CARD"]);
	});

	it("turn_end and awaited session_stop no-trigger messages paint before prompt resolves with one request", async () => {
		const mock = createMockModel({ provider: "openai", id: "gpt-test", handler: { content: ["Done"] } });
		const stopStarted = Promise.withResolvers<void>();
		const releaseStop = Promise.withResolvers<void>();
		let turnEndSends = 0;
		let stopSends = 0;
		const runner = {
			emitBeforeAgentStart: async () => undefined,
			hasHandlers: (eventType: string) => eventType === "turn_end" || eventType === "session_stop",
			emit: async (event: { type: string }) => {
				if (event.type !== "turn_end") return;
				turnEndSends++;
				await session!.sendCustomMessage(
					{ customType: "advisor", content: "TURN_END_CARD", display: true },
					{ triggerTurn: false },
				);
			},
			emitSessionStop: async () => {
				stopSends++;
				stopStarted.resolve();
				await releaseStop.promise;
				await session!.sendCustomMessage(
					{ customType: "advisor", content: "SESSION_STOP_CARD", display: true },
					{ triggerTurn: false },
				);
			},
		} as unknown as ExtensionRunner;
		session = createRunningSession(mock, [], runner);
		let promptCompleted = false;
		const events = observeCustomMessages(session, () => expect(promptCompleted).toBe(false));
		const run = session.prompt("go").then(() => {
			promptCompleted = true;
		});
		try {
			await stopStarted.promise;
			expect(promptCompleted).toBe(false);
			expect(mock.calls).toHaveLength(1);
		} finally {
			releaseStop.resolve();
			await run;
		}
		expect(mock.calls).toHaveLength(1);
		expect(turnEndSends).toBe(1);
		expect(stopSends).toBe(1);
		expect(events).toEqual([
			"message_start:TURN_END_CARD",
			"message_end:TURN_END_CARD",
			"message_start:SESSION_STOP_CARD",
			"message_end:SESSION_STOP_CARD",
		]);
		expect(customContents(session.messages)).toEqual(["TURN_END_CARD", "SESSION_STOP_CARD"]);
		expect(persistedCustomContents(session)).toEqual(["TURN_END_CARD", "SESSION_STOP_CARD"]);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it.each(["steer", "followUp", "aside", "nextTurn"] as const)(
		"explicit %s delivery keeps its existing streaming behavior with triggerTurn:false",
		async deliverAs => {
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const mock = createMockModel({
				provider: "openai",
				id: "gpt-test",
				responses: [
					async () => {
						started.resolve();
						await release.promise;
						return { content: ["Done"] };
					},
				],
				handler: { content: ["Continued"] },
			});
			session = createRunningSession(mock);
			const events = observeCustomMessages(session);
			const run = session.prompt("go");
			try {
				await started.promise;
				await session.sendCustomMessage(
					{ customType: "advisor", content: "EXPLICIT_CARD", display: true },
					{ deliverAs, triggerTurn: false },
				);
				expect(events).toEqual([]);
			} finally {
				release.resolve();
				await run;
			}
			if (deliverAs === "nextTurn") {
				expect(mock.calls).toHaveLength(1);
				expect(customContents(session.messages)).toEqual([]);
				expect(events).toEqual([]);
			} else {
				expect(mock.calls).toHaveLength(2);
				expect(JSON.stringify(mock.calls[1]!.context.messages)).toContain("EXPLICIT_CARD");
				expect(customContents(session.messages)).toEqual(["EXPLICIT_CARD"]);
				expect(events).toEqual(["message_start:EXPLICIT_CARD", "message_end:EXPLICIT_CARD"]);
			}
		},
	);

	it.each(["abort", "newSession", "dispose"] as const)(
		"drops pending no-trigger cards when %s fences the active run",
		async transition => {
			const started = Promise.withResolvers<void>();
			const mock = createMockModel({
				provider: "openai",
				id: "gpt-test",
				handler: () => {
					started.resolve();
					return { content: ["Working"], delayMs: 60_000 };
				},
			});
			session = createRunningSession(mock);
			const events = observeCustomMessages(session);
			const run = session.prompt("go");
			await started.promise;
			await session.sendCustomMessage(
				{ customType: "advisor", content: "STALE_CARD", display: true },
				{ triggerTurn: false },
			);
			if (transition === "newSession") expect(await session.newSession()).toBe(true);
			else if (transition === "dispose") await session.dispose();
			else await session.abort();
			await run.catch(() => {});
			expect(events).toEqual([]);
			expect(customContents(session.messages)).toEqual([]);
			expect(persistedCustomContents(session)).toEqual([]);
			expect(mock.calls).toHaveLength(1);
		},
	);

	it("drops no-trigger normalization that completes after a session change", async () => {
		const mock = createMockModel({ provider: "openai", id: "gpt-test", handler: { content: ["Done"] } });
		session = createRunningSession(mock);
		const events = observeCustomMessages(session);
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const normalize = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			started.resolve();
			await release.promise;
			return images;
		});
		const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
		const sent = session.sendCustomMessage(
			{ customType: "advisor", content: [{ type: "text", text: "STALE_IMAGE_CARD" }, image], display: true },
			{ triggerTurn: false },
		);
		try {
			await started.promise;
			expect(await session.newSession()).toBe(true);
		} finally {
			release.resolve();
			await sent;
			normalize.mockRestore();
		}
		expect(events).toEqual([]);
		expect(customContents(session.messages)).toEqual([]);
		expect(persistedCustomContents(session)).toEqual([]);
		expect(mock.calls).toHaveLength(0);
	});

	function createRunningSession(
		mock: ReturnType<typeof createMockModel>,
		tools: AgentTool[] = [],
		extensionRunner?: ExtensionRunner,
	): AgentSession {
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools, messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			extensionRunner,
		});
	}

	function observeCustomMessages(target: AgentSession, onEvent?: () => void): string[] {
		const events: string[] = [];
		target.subscribe(event => {
			if (
				(event.type === "message_start" || event.type === "message_end") &&
				event.message.role === "custom" &&
				event.message.customType === "advisor"
			) {
				events.push(`${event.type}:${event.message.content}`);
				onEvent?.();
			}
		});
		return events;
	}

	function customContents(messages: AgentMessage[]): unknown[] {
		return messages.flatMap(message =>
			message.role === "custom" && message.customType === "advisor" ? [message.content] : [],
		);
	}

	function persistedCustomContents(target: AgentSession): unknown[] {
		return target.sessionManager
			.getEntries()
			.flatMap(entry => (entry.type === "custom_message" && entry.customType === "advisor" ? [entry.content] : []));
	}
});
