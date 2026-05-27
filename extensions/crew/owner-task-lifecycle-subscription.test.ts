import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import roomExtension from "./index.ts";
import {
	resetActiveRoomsForTests,
	setActiveRoom,
	processUnreadMessages,
} from "./lifecycle.ts";
import {
	appendMessage,
	createRoom,
	loadRoomMemberState,
	listBoardEntries,
	readMessage,
	writeRoomMemberState,
} from "./storage.ts";
import { executeCrewTell } from "./tools.ts";
import { createPiMemberAdapter, createPaseoPiMemberAdapter } from "./spawn.ts";
import { appendTerminalTaskReplyAndNotify } from "./task-terminal.ts";
import type { PublicTaskLifecycleEvent } from "./task-integration-events.ts";
import type { RoomMemberState, RoomSpawnAdapter } from "./types.ts";

type RegisteredHandler = (event: unknown, ctx?: unknown) => unknown;

function createMemberState(name: string, overrides: Partial<RoomMemberState> = {}): RoomMemberState {
	const now = new Date().toISOString();
	return {
		name,
		displayName: name.split("_")[0] ?? name,
		type: "worker",
		backend: "pi",
		runtimeId: null,
		state: "idle",
		spawnTaskId: null,
		currentTask: null,
		currentTaskMessageId: null,
		lastCompletedTask: null,
		lastError: null,
		lastSeenSeq: 0,
		joinedAt: now,
		updatedAt: now,
		sessionId: `${name}-session`,
		...overrides,
	};
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(
		path.join(os.tmpdir(), "crew-owner-task-lifecycle-subscription-"),
	);
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

function createTestAdapters(): { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter } {
	let runtimeSeq = 0;
	return {
		pi: {
			kind: "pi",
			async spawn() {
				runtimeSeq += 1;
				return {
					runtimeId: `test-runtime-${runtimeSeq}`,
					backend: "pi",
				};
			},
		},
		paseo: {
			kind: "paseo",
			async isAvailable() {
				return false;
			},
			async spawn() {
				throw new Error(
					"paseo adapter should not be used in owner task lifecycle subscription tests",
				);
			},
		},
	};
}

function createOwnerHarness(adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter }) {
	const eventHandlers = new Map<string, RegisteredHandler[]>();
	const lifecycleHandlers = new Map<string, RegisteredHandler>();
	const emit = vi.fn(async (name: string, payload: unknown) => {
		for (const handler of eventHandlers.get(name) ?? []) {
			await handler(payload);
		}
	});

	roomExtension(
		{
			events: {
				on: vi.fn((name: string, handler: RegisteredHandler) => {
					const existing = eventHandlers.get(name) ?? [];
					existing.push(handler);
					eventHandlers.set(name, existing);
				}),
				emit,
			},
			on: vi.fn((name: string, handler: RegisteredHandler) => {
				lifecycleHandlers.set(name, handler);
			}),
			registerTool: vi.fn(),
			sendMessage: vi.fn(),
			setActiveTools: vi.fn(),
			getAllTools: vi.fn(() => []),
			getThinkingLevel: vi.fn(),
		} as any,
		{ adapters },
	);

	return {
		onEvent(name: string, handler: RegisteredHandler): void {
			const existing = eventHandlers.get(name) ?? [];
			existing.push(handler);
			eventHandlers.set(name, existing);
		},
		async emitEvent(name: string, payload: unknown): Promise<void> {
			await emit(name, payload);
		},
		async runLifecycle(
			name: string,
			event: unknown,
			ctx: unknown,
		): Promise<void> {
			const handler = lifecycleHandlers.get(name);
			expect(handler).toBeTypeOf("function");
			await handler?.(event, ctx);
		},
	};
}

function setOwnerRoom(options: {
	roomDir: string;
	roomId: string;
	sessionId: string;
	memberName?: string;
}): void {
	setActiveRoom({
		role: "owner",
		roomDir: options.roomDir,
		roomId: options.roomId,
		memberName: options.memberName ?? "owner",
		sessionId: options.sessionId,
		pollTimer: null,
		heartbeatTimer: null,
		pendingPoll: null,
		pendingHeartbeat: null,
		pendingToolTasks: new Set<Promise<unknown>>(),
		shuttingDown: false,
		pendingDeliveryBatch: [],
		deliveryTimer: null,
	});
}

function setMemberActiveRoomContext(
	roomDir: string,
	roomId: string,
	sessionId: string,
	memberName: string,
) {
	return setActiveRoom({
		role: "member",
		roomDir,
		roomId,
		memberName,
		sessionId,
		pollTimer: null,
		heartbeatTimer: null,
		pendingPoll: null,
		pendingHeartbeat: null,
		pendingToolTasks: new Set<Promise<unknown>>(),
		shuttingDown: false,
		pendingDeliveryBatch: [],
		deliveryTimer: null,
	});
}

async function sendOwnerTask(
	tempDir: string,
	runtimeRoot: string,
	sessionId: string,
	params: { to: string; summary: string; content?: string },
) {
	const result = await executeCrewTell(
		{ ...params, kind: "task" },
		{ sendMessage() { return undefined; } } as ExtensionAPI,
		{
			cwd: tempDir,
			hasUI: false,
			sessionManager: { getSessionId: () => sessionId },
		},
		runtimeRoot,
		{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
		{},
	);
	const seqMatch = result.content[0]?.text.match(/seq:\s*(\d+)/);
	if (!seqMatch)
		throw new Error(
			`failed to parse task seq from ${result.content[0]?.text ?? "(empty)"}`,
		);
	return Number(seqMatch[1]);
}

async function waitFor(
	condition: () => boolean,
	options: { timeoutMs?: number; message: string },
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 2_000;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(options.message);
}

afterEach(() => {
	resetActiveRoomsForTests();
	vi.unstubAllEnvs();
});

describe("owner-side task lifecycle subscriptions", () => {
	it("no-deps task: owner sees task:assigned, then task:started after member poll", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-task-sub",
				cwd: tempDir,
				ownerPid: process.pid,
			});

			// Create a worker member
			await writeRoomMemberState(
				created.roomDir,
				createMemberState("worker_a"),
			);

			const adapters = createTestAdapters();
			const ownerHarness = createOwnerHarness(adapters);

			await ownerHarness.runLifecycle("session_start", {}, {
				cwd: tempDir,
				getSystemPrompt: () => "",
				sessionManager: {
					getSessionId: () => created.metadata.ownerSessionId,
				},
			});
			setOwnerRoom({
				roomDir: created.roomDir,
				roomId: created.metadata.roomId,
				sessionId: created.metadata.ownerSessionId,
			});

			const taskEvents: PublicTaskLifecycleEvent[] = [];
			ownerHarness.onEvent("crew:task", (payload: unknown) => {
				taskEvents.push(payload as PublicTaskLifecycleEvent);
			});

			// Assign a no-deps task to worker_a
			const taskSeq = await sendOwnerTask(
				tempDir,
				runtimeRoot,
				created.metadata.ownerSessionId,
				{ to: "worker_a", summary: "No deps quick task" },
			);

			// Should see task:assigned immediately
			await waitFor(
				() => taskEvents.some((e) => e.event === "task:assigned"),
				{ message: "expected task:assigned event" },
			);

			const assignedEvent = taskEvents.find(
				(e) => e.event === "task:assigned",
			);
			expect(assignedEvent).toBeDefined();
			expect(assignedEvent!.task_seq).toBe(taskSeq);
			expect(assignedEvent!.member_target).toBe("worker_a");
			expect(assignedEvent!.task_status).toBe("assigned");
			expect(assignedEvent!.task_summary).toBe("No deps quick task");

			// No task:started yet — member has not polled
			const startedBeforePoll = taskEvents.some(
				(e) => e.event === "task:started",
			);
			expect(startedBeforePoll).toBe(false);

			// Member polls — transitions to running
			const memberContext = setMemberActiveRoomContext(
				created.roomDir,
				created.metadata.roomId,
				"worker_a-session",
				"worker_a",
			);
			await processUnreadMessages(
				{ sendMessage() { return undefined; } } as ExtensionAPI,
				memberContext,
			);

			// Should see task:started after member poll
			await waitFor(
				() => taskEvents.some((e) => e.event === "task:started"),
				{ message: "expected task:started event after member poll" },
			);

			const startedEvent = taskEvents.find(
				(e) => e.event === "task:started",
			);
			expect(startedEvent).toBeDefined();
			expect(startedEvent!.task_seq).toBe(taskSeq);
			expect(startedEvent!.member_target).toBe("worker_a");
			expect(startedEvent!.task_status).toBe("running");
			expect(startedEvent!.task_summary).toBe("No deps quick task");

			// Verify member is actually running
			const state = await loadRoomMemberState(
				created.roomDir,
				"worker_a",
			);
			expect(state.state).toBe("running");

			// Event order must be assigned before started
			const assignedIdx = taskEvents.findIndex(
				(e) => e.event === "task:assigned",
			);
			const startedIdx = taskEvents.findIndex(
				(e) => e.event === "task:started",
			);
			expect(assignedIdx).toBeLessThan(startedIdx);
		});
	});

	it("ready-at-assignment task: owner emits task:assigned first, then task:started on the first poll", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-ready-assign-task-sub",
				cwd: tempDir,
				ownerPid: process.pid,
			});

			// Create two workers
			await writeRoomMemberState(
				created.roomDir,
				createMemberState("worker_a"),
			);
			await writeRoomMemberState(
				created.roomDir,
				createMemberState("worker_b"),
			);

			const adapters = createTestAdapters();
			const ownerHarness = createOwnerHarness(adapters);

			await ownerHarness.runLifecycle("session_start", {}, {
				cwd: tempDir,
				getSystemPrompt: () => "",
				sessionManager: {
					getSessionId: () => created.metadata.ownerSessionId,
				},
			});
			setOwnerRoom({
				roomDir: created.roomDir,
				roomId: created.metadata.roomId,
				sessionId: created.metadata.ownerSessionId,
			});

			const taskEvents: PublicTaskLifecycleEvent[] = [];
			ownerHarness.onEvent("crew:task", (payload: unknown) => {
				taskEvents.push(payload as PublicTaskLifecycleEvent);
			});

			// Upstream task completed before downstream is assigned
			const upstreamSeq = await sendOwnerTask(
				tempDir,
				runtimeRoot,
				created.metadata.ownerSessionId,
				{ to: "worker_a", summary: "Already finished upstream" },
			);
			const upstream = (await listBoardEntries(created.roomDir, 20)).find(
				(e) => e.seq === upstreamSeq,
			);
			if (!upstream) throw new Error("upstream task not found");

			await appendTerminalTaskReplyAndNotify({
				roomDir: created.roomDir,
				upstreamSeq: upstream.seq,
				taskMessageId: upstream.id,
				from: "worker_a",
				to: "owner",
				kind: "completion",
				summary: "Already finished upstream — complete",
				logContext: { source: "ready-at-assignment-task-sub-test" },
			});

			// Now assign downstream — deps already resolved
			const downstreamSeq = await sendOwnerTask(
				tempDir,
				runtimeRoot,
				created.metadata.ownerSessionId,
				{
					to: "worker_b",
					summary: "Ready immediately — deps done",
					content: `Use {input:#${upstreamSeq}} for context.`,
				},
			);

			// Should see task:assigned (or waiting_deps) for the downstream
			await waitFor(
				() =>
					taskEvents.some(
						(e) =>
							e.task_seq === downstreamSeq && e.event !== "task:started",
					),
				{
					message:
						"expected task:assigned/waiting_deps for downstream task",
				},
			);

			// The assignment event should be assigned/waiting_deps (first emit)
			const assignmentEvent = taskEvents.find(
				(e) => e.task_seq === downstreamSeq && e.event !== "task:started",
			);
			expect(assignmentEvent).toBeDefined();
			expect(
				["task:assigned", "task:waiting_deps", "task:blocked_failed"],
			).toContain(assignmentEvent!.event);

			// No task:started before the member actually polls
			const startedBeforePoll = taskEvents.some(
				(e) =>
					e.task_seq === downstreamSeq && e.event === "task:started",
			);
			expect(startedBeforePoll).toBe(false);

			// Member polls — should transition to running
			const memberContext = setMemberActiveRoomContext(
				created.roomDir,
				created.metadata.roomId,
				"worker_b-session",
				"worker_b",
			);
			await processUnreadMessages(
				{ sendMessage() { return undefined; } } as ExtensionAPI,
				memberContext,
			);

			// Should see task:started after member poll
			await waitFor(
				() =>
					taskEvents.some(
						(e) =>
							e.task_seq === downstreamSeq &&
							e.event === "task:started",
					),
				{ message: "expected task:started event after member poll" },
			);

			const startedEvent = taskEvents.find(
				(e) =>
					e.task_seq === downstreamSeq && e.event === "task:started",
			);
			expect(startedEvent).toBeDefined();
			expect(startedEvent!.task_status).toBe("running");
			expect(startedEvent!.task_summary).toBe(
				"Ready immediately — deps done",
			);

			// Verify member is running
			const state = await loadRoomMemberState(
				created.roomDir,
				"worker_b",
			);
			expect(state.state).toBe("running");

			// Event order: assigned before started
			const assignedIdx = taskEvents.findIndex(
				(e) =>
					e.task_seq === downstreamSeq && e.event !== "task:started",
			);
			const startedIdx = taskEvents.findIndex(
				(e) =>
					e.task_seq === downstreamSeq && e.event === "task:started",
			);
			expect(assignedIdx).toBeLessThan(startedIdx);
		});
	});

	it("waiting deps task: no task:started before the owner sees the running transition", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-waiting-deps",
				cwd: tempDir,
				ownerPid: process.pid,
			});

			await writeRoomMemberState(
				created.roomDir,
				createMemberState("worker_a"),
			);
			await writeRoomMemberState(
				created.roomDir,
				createMemberState("worker_b"),
			);

			const adapters = createTestAdapters();
			const ownerHarness = createOwnerHarness(adapters);

			await ownerHarness.runLifecycle("session_start", {}, {
				cwd: tempDir,
				getSystemPrompt: () => "",
				sessionManager: {
					getSessionId: () => created.metadata.ownerSessionId,
				},
			});
			setOwnerRoom({
				roomDir: created.roomDir,
				roomId: created.metadata.roomId,
				sessionId: created.metadata.ownerSessionId,
			});

			const taskEvents: PublicTaskLifecycleEvent[] = [];
			ownerHarness.onEvent("crew:task", (payload: unknown) => {
				taskEvents.push(payload as PublicTaskLifecycleEvent);
			});

			// Upstream task assigned to worker_a but NOT completed yet
			const upstreamSeq = await sendOwnerTask(
				tempDir,
				runtimeRoot,
				created.metadata.ownerSessionId,
				{ to: "worker_a", summary: "Slow upstream" },
			);
			const upstream = (await listBoardEntries(created.roomDir, 20)).find(
				(e) => e.seq === upstreamSeq,
			);
			if (!upstream) throw new Error("upstream task not found");

			// Assign downstream task with a dependency on the uncompleted upstream
			const downstreamSeq = await sendOwnerTask(
				tempDir,
				runtimeRoot,
				created.metadata.ownerSessionId,
				{
					to: "worker_b",
					summary: "Blocked on slow upstream",
					content: `Wait for {input:#${upstreamSeq}} before starting.`,
				},
			);

			// Should see waiting_deps or assigned for the downstream
			await waitFor(
				() =>
					taskEvents.some(
						(e) =>
							e.task_seq === downstreamSeq &&
							e.event !== "task:started",
					),
				{
					message:
						"expected waiting_deps event for downstream task",
				},
			);

			const waitingEvent = taskEvents.find(
				(e) => e.task_seq === downstreamSeq,
			);
			expect(waitingEvent).toBeDefined();
			expect(waitingEvent!.task_status).not.toBe("running");

			// Member polls — should NOT transition to running because deps not ready
			const memberContext = setMemberActiveRoomContext(
				created.roomDir,
				created.metadata.roomId,
				"worker_b-session",
				"worker_b",
			);
			await processUnreadMessages(
				{ sendMessage() { return undefined; } } as ExtensionAPI,
				memberContext,
			);

			// No task:started because deps are not ready
			const startedEvents = taskEvents.filter(
				(e) =>
					e.task_seq === downstreamSeq &&
					e.event === "task:started",
			);
			expect(startedEvents).toHaveLength(0);

			// Now complete the upstream
			await appendTerminalTaskReplyAndNotify({
				roomDir: created.roomDir,
				upstreamSeq: upstreamSeq,
				taskMessageId: upstream.id,
				from: "worker_a",
				to: "owner",
				kind: "completion",
				summary: "Slow upstream complete",
				logContext: { source: "waiting-deps-task-sub-test" },
			});

			// Wait for the dep-ready notification to be created
			await waitFor(
				async () => {
					const board = await listBoardEntries(created.roomDir, 20);
					return board.some(
						(e) =>
							e.from === "system" &&
							e.to === "worker_b" &&
							e.summary ===
								`All dependencies ready for task #${downstreamSeq}`,
					);
				},
				{ message: "expected dep-ready notification" },
			);

			// Member polls again — now transitions to running
			await processUnreadMessages(
				{ sendMessage() { return undefined; } } as ExtensionAPI,
				memberContext,
			);

			await waitFor(
				async () => {
					const state = await loadRoomMemberState(
						created.roomDir,
						"worker_b",
					);
					return state.state === "running";
				},
				{ message: "expected member to be running" },
			);

			// Now task:started should appear
			await waitFor(
				() =>
					taskEvents.some(
						(e) =>
							e.task_seq === downstreamSeq &&
							e.event === "task:started",
					),
				{
					message:
						"expected task:started after deps became ready",
				},
			);

			const startedEvent = taskEvents.find(
				(e) =>
					e.task_seq === downstreamSeq &&
					e.event === "task:started",
			);
			expect(startedEvent).toBeDefined();
			expect(startedEvent!.task_status).toBe("running");
		});
	});

	it("duplicate running patches do not emit a second task:started", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-dup-started",
				cwd: tempDir,
				ownerPid: process.pid,
			});

			await writeRoomMemberState(
				created.roomDir,
				createMemberState("worker_a"),
			);

			const adapters = createTestAdapters();
			const ownerHarness = createOwnerHarness(adapters);

			await ownerHarness.runLifecycle("session_start", {}, {
				cwd: tempDir,
				getSystemPrompt: () => "",
				sessionManager: {
					getSessionId: () => created.metadata.ownerSessionId,
				},
			});
			setOwnerRoom({
				roomDir: created.roomDir,
				roomId: created.metadata.roomId,
				sessionId: created.metadata.ownerSessionId,
			});

			const taskEvents: PublicTaskLifecycleEvent[] = [];
			ownerHarness.onEvent("crew:task", (payload: unknown) => {
				taskEvents.push(payload as PublicTaskLifecycleEvent);
			});

			// Assign a no-deps task
			const taskSeq = await sendOwnerTask(
				tempDir,
				runtimeRoot,
				created.metadata.ownerSessionId,
				{ to: "worker_a", summary: "Dedup started test" },
			);

			await waitFor(
				() => taskEvents.some((e) => e.event === "task:assigned"),
				{ message: "expected task:assigned event" },
			);

			// Member polls first time — transitions to running
			const memberContext = setMemberActiveRoomContext(
				created.roomDir,
				created.metadata.roomId,
				"worker_a-session",
				"worker_a",
			);
			await processUnreadMessages(
				{ sendMessage() { return undefined; } } as ExtensionAPI,
				memberContext,
			);

			await waitFor(
				() => taskEvents.some((e) => e.event === "task:started"),
				{ message: "expected first task:started event" },
			);

			expect(
				taskEvents.filter(
					(e) =>
						e.task_seq === taskSeq && e.event === "task:started",
				),
			).toHaveLength(1);

			// Member polls again — should not emit a second task:started
			await processUnreadMessages(
				{ sendMessage() { return undefined; } } as ExtensionAPI,
				memberContext,
			);

			// Small wait to let any async events settle
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Still only one task:started
			expect(
				taskEvents.filter(
					(e) =>
						e.task_seq === taskSeq && e.event === "task:started",
				),
			).toHaveLength(1);
		});
	});
});
