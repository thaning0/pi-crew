import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCrewLifecycleEvent, setCrewEventEmitter } from "./integration-events.ts";
import { setActiveRoom, resetActiveRoomsForTests } from "./lifecycle.ts";
import { activateBootstrapRoom } from "./lifecycle.ts";
import {
	createRoom,
	createSpawningMember,
	markMemberJoined,
	persistCrewAddReplayEvent,
	readCrewAddRequestReplay,
} from "./storage.ts";

const { queueCrewAddMock } = vi.hoisted(() => ({
	queueCrewAddMock: vi.fn(),
}));

vi.mock("./tools.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./tools.ts")>();
	return {
		...actual,
		queueCrewAdd: queueCrewAddMock,
	};
});

import roomExtension from "./index.ts";
import { executeCrewRemove, executeCrewStop } from "./tools.ts";

type RegisteredHandler = (event: unknown, ctx?: unknown) => unknown;

function createHarness() {
	const eventHandlers = new Map<string, RegisteredHandler>();
	const lifecycleHandlers = new Map<string, RegisteredHandler>();
	const tools = new Map<string, any>();
	const emit = vi.fn(async () => undefined);

	roomExtension(
		{
			events: {
				on: vi.fn((name: string, handler: RegisteredHandler) => {
					eventHandlers.set(name, handler);
				}),
				emit,
			},
			on: vi.fn((name: string, handler: RegisteredHandler) => {
				lifecycleHandlers.set(name, handler);
			}),
			registerTool: vi.fn((tool: any) => {
				tools.set(tool.name, tool);
			}),
			sendMessage: vi.fn(),
			setActiveTools: vi.fn(),
			getAllTools: vi.fn(() => []),
			getThinkingLevel: vi.fn(),
		} as any,
		{},
	);

	return {
		emit,
		eventHandlers,
		lifecycleHandlers,
		async callTool(
			name: string,
			params: unknown,
			ctxOverrides: Partial<{
				cwd: string;
				hasUI: boolean;
				model: unknown;
				getSystemPrompt: () => string;
				sessionManager: { getSessionId: () => string };
			}> = {},
		) {
			const tool = tools.get(name);
			expect(tool).toBeTruthy();
			return await tool.execute(
				"tool-call-1",
				params,
				new AbortController().signal,
				() => undefined,
				{
					cwd: "/home/thn/pi-crew",
					hasUI: true,
					getSystemPrompt: () => "",
					sessionManager: { getSessionId: () => "owner-session" },
					...ctxOverrides,
				},
			);
		},
	};
}

function setOwnerRoom(options: {
	sessionId?: string;
	roomDir?: string;
	roomId?: string;
	memberName?: string;
} = {}): void {
	setActiveRoom({
		role: "owner",
		roomDir: options.roomDir ?? "/home/thn/pi-crew/extensions/crew",
		roomId: options.roomId ?? "room-1",
		memberName: options.memberName ?? "lead",
		sessionId: options.sessionId ?? "owner-session",
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

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crew-event-feedback-test-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

async function cacheProjectCwd(
	lifecycleHandlers: Map<string, RegisteredHandler>,
	sessionId = "owner-session",
): Promise<void> {
	const sessionStart = lifecycleHandlers.get("session_start");
	expect(sessionStart).toBeTypeOf("function");
	await sessionStart?.(
		{},
		{
			cwd: "/home/thn/pi-crew",
			getSystemPrompt: () => "",
			sessionManager: { getSessionId: () => sessionId },
		},
	);
}

async function flushAsyncWork(delay = 0): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, delay));
}

async function seedHeldManualGeneration(roomDir: string, ownerSessionId: string, roomId: string) {
	await createSpawningMember(roomDir, {
		name: "held-worker",
		displayName: "held-worker",
		type: "worker",
		backend: "pi",
		taskId: "spawn-held-manual",
		bootstrapToken: "bootstrap-held-manual",
		requestReplay: {
			requestId: "req-held-manual",
			requestedName: "held-worker",
			type: "worker",
			model: null,
			task: null,
			transient: false,
			metadata: { source: "event-feedback-control" },
			activation: "manual",
			holdTimeoutMs: 30_000,
		},
	} as never);
	await markMemberJoined({
		bootstrap: {
			version: 1,
			roomId,
			roomDir,
			memberName: "held-worker",
			memberType: "worker",
			ownerName: "owner",
			ownerSessionId,
			token: "bootstrap-held-manual",
			spawnTaskId: "spawn-held-manual",
		},
		sessionId: "held-worker-session",
		runtimeId: "held-worker-runtime",
		backend: "pi",
	});
}

async function seedImmediateGeneration(options: {
	roomDir: string;
	roomId: string;
	ownerSessionId: string;
	memberName: string;
	taskId: string;
	requestId: string;
}) {
	await createSpawningMember(options.roomDir, {
		name: options.memberName,
		displayName: options.memberName,
		type: "worker",
		backend: "pi",
		taskId: options.taskId,
		bootstrapToken: `bootstrap-${options.taskId}`,
		requestReplay: {
			requestId: options.requestId,
			requestedName: options.memberName,
			type: "worker",
			model: null,
			task: null,
			transient: false,
			metadata: { source: "event-feedback-terminal" },
			activation: "immediate",
			holdTimeoutMs: null,
		},
	} as never);
	await markMemberJoined({
		bootstrap: {
			version: 1,
			roomId: options.roomId,
			roomDir: options.roomDir,
			memberName: options.memberName,
			memberType: "worker",
			ownerName: "owner",
			ownerSessionId: options.ownerSessionId,
			token: `bootstrap-${options.taskId}`,
			spawnTaskId: options.taskId,
		},
		sessionId: `${options.memberName}-session`,
		runtimeId: String(process.pid),
		backend: "pi",
	});
}

function crewEventPayloads(emit: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
	return emit.mock.calls
		.filter(([eventName]) => eventName === "crew:event")
		.map(([, payload]) => payload as Record<string, unknown>);
}

describe("crew:add request feedback", () => {
	beforeEach(() => {
		queueCrewAddMock.mockReset();
		resetActiveRoomsForTests();
	});

	afterEach(() => {
		resetActiveRoomsForTests();
	});

	it("emits rejected for invalid payload shape before queueing", async () => {
		const harness = createHarness();
		await cacheProjectCwd(harness.lifecycleHandlers);
		setOwnerRoom();

		harness.eventHandlers.get("crew:add")?.({
			request_id: "req-invalid-shape",
			type: "builder",
		});
		await flushAsyncWork(25);

		expect(queueCrewAddMock).not.toHaveBeenCalled();
		const [payload] = crewEventPayloads(harness.emit);
		expect(payload).toMatchObject({
			event: "rejected",
			phase: "request",
			request_id: "req-invalid-shape",
		});
		expect(payload?.member_target ?? null).toBeNull();
		expect(payload?.spawn_task_id ?? null).toBeNull();
		expect(payload).not.toHaveProperty("member_id");
	});

	it("emits rejected when project cwd has not been cached yet", async () => {
		const harness = createHarness();
		setOwnerRoom();

		harness.eventHandlers.get("crew:add")?.({
			request_id: "req-no-cwd",
			name: "worker",
			type: "builder",
		});
		await flushAsyncWork(25);

		expect(queueCrewAddMock).not.toHaveBeenCalled();
		expect(crewEventPayloads(harness.emit)).toContainEqual(
			expect.objectContaining({
				event: "rejected",
				phase: "request",
				request_id: "req-no-cwd",
				requested_name: "worker",
			}),
		);
	});

	it("echoes request_id verbatim in invalid-activation request rejection without invented generation handles", async () => {
		const harness = createHarness();
		await cacheProjectCwd(harness.lifecycleHandlers);
		setOwnerRoom();

		harness.eventHandlers.get("crew:add")?.({
			request_id: "  req-bad-activation  ",
			name: " worker ",
			type: "builder",
			activation: "later",
		});
		await flushAsyncWork(25);

		const [payload] = crewEventPayloads(harness.emit);
		expect(queueCrewAddMock).not.toHaveBeenCalled();
		expect(payload).toMatchObject({
			event: "rejected",
			phase: "request",
			request_id: "  req-bad-activation  ",
			requested_name: "worker",
		});
		expect(payload?.member_target ?? null).toBeNull();
		expect(payload?.spawn_task_id ?? null).toBeNull();
	});

	it("emits rejected for invalid metadata before queueing", async () => {
		const harness = createHarness();
		await cacheProjectCwd(harness.lifecycleHandlers);
		setOwnerRoom();

		harness.eventHandlers.get("crew:add")?.({
			request_id: "req-bad-metadata",
			name: "worker",
			type: "builder",
			metadata: "not-an-object",
		});
		await flushAsyncWork(25);

		expect(queueCrewAddMock).not.toHaveBeenCalled();
		expect(crewEventPayloads(harness.emit)).toContainEqual(
			expect.objectContaining({
				event: "rejected",
				phase: "request",
				request_id: "req-bad-metadata",
				requested_name: "worker",
			}),
		);
	});

	it("emits rejected for empty or whitespace-only request_id before queueing", async () => {
		const harness = createHarness();
		await cacheProjectCwd(harness.lifecycleHandlers);
		setOwnerRoom();

		harness.eventHandlers.get("crew:add")?.({
			request_id: "   ",
			name: "worker",
			type: "builder",
		});
		await flushAsyncWork(25);

		expect(queueCrewAddMock).not.toHaveBeenCalled();
		expect(crewEventPayloads(harness.emit)).toContainEqual(
			expect.objectContaining({
				event: "rejected",
				phase: "request",
				request_id: "   ",
				requested_name: "worker",
			}),
		);
	});

	it("emits rejected when there is no active owner room", async () => {
		const harness = createHarness();
		await cacheProjectCwd(harness.lifecycleHandlers);

		harness.eventHandlers.get("crew:add")?.({
			request_id: "req-no-owner",
			name: "worker",
			type: "builder",
		});
		await flushAsyncWork(25);

		expect(queueCrewAddMock).not.toHaveBeenCalled();
		expect(crewEventPayloads(harness.emit)).toContainEqual(
			expect.objectContaining({
				event: "rejected",
				phase: "request",
				request_id: "req-no-owner",
				requested_name: "worker",
			}),
		);
	});

	it("drops hold_timeout_ms for immediate requests before queueing", async () => {
		const harness = createHarness();
		await cacheProjectCwd(harness.lifecycleHandlers);
		setOwnerRoom();
		const metadata = { source: "event-feedback-test" };
		queueCrewAddMock.mockResolvedValueOnce({
			memberName: "worker_deadbeef",
			memberLabel: "worker#deadbeef",
			taskId: "spawn-task-1",
			backend: "pi",
			transient: true,
			initialTaskBoardError: null,
			unresolvedMentions: [],
		});

		harness.eventHandlers.get("crew:add")?.({
			request_id: "  req-immediate  ",
			name: " worker ",
			type: " builder ",
			model: " gpt-5-mini ",
			task: " ship it ",
			transient: true,
			activation: "immediate",
			hold_timeout_ms: 15_000,
			metadata,
		});
		await flushAsyncWork(25);

		expect(queueCrewAddMock).toHaveBeenCalledTimes(1);
		const [params] = queueCrewAddMock.mock.calls[0] ?? [];
		expect(params).toMatchObject({
			request_id: "  req-immediate  ",
			name: "worker",
			type: "builder",
			model: "gpt-5-mini",
			task: "ship it",
			transient: true,
			activation: "immediate",
			metadata,
		});
		expect(params.hold_timeout_ms).toBeUndefined();
	});

	it("emits rejected when queueing fails before generation creation", async () => {
		const harness = createHarness();
		await cacheProjectCwd(harness.lifecycleHandlers);
		setOwnerRoom();
		queueCrewAddMock.mockRejectedValueOnce(
			Object.assign(new Error("Agent type builder not found."), {
				crewAddPhase: "request",
			}),
		);

		harness.eventHandlers.get("crew:add")?.({
			request_id: "req-unknown-type",
			name: "worker",
			type: "builder",
		});
		await flushAsyncWork(25);

		const [payload] = crewEventPayloads(harness.emit);
		expect(queueCrewAddMock).toHaveBeenCalledTimes(1);
		expect(payload).toMatchObject({
			event: "rejected",
			phase: "request",
			request_id: "req-unknown-type",
			requested_name: "worker",
		});
		expect(payload?.member_target ?? null).toBeNull();
		expect(payload?.spawn_task_id ?? null).toBeNull();
	});

	it("does not emit request rejection for post-generation transient spawn failures", async () => {
		const harness = createHarness();
		await cacheProjectCwd(harness.lifecycleHandlers);
		setOwnerRoom();
		queueCrewAddMock.mockRejectedValueOnce(
			Object.assign(new Error("spawn failed after member creation"), {
				crewAddPhase: "spawn",
			}),
		);

		harness.eventHandlers.get("crew:add")?.({
			request_id: "req-transient-spawn-fail",
			name: "worker",
			type: "builder",
			task: "do the work",
			transient: true,
		});
		await flushAsyncWork(25);

		expect(queueCrewAddMock).toHaveBeenCalledTimes(1);
		expect(crewEventPayloads(harness.emit)).toEqual([]);
	});

	it("re-emits a replayed lifecycle snapshot instead of inventing a new generation event", async () => {
		const harness = createHarness();
		await cacheProjectCwd(harness.lifecycleHandlers);
		setOwnerRoom();
		queueCrewAddMock.mockResolvedValueOnce({
			memberName: "worker_deadbeef",
			memberLabel: "worker#deadbeef",
			taskId: "spawn-task-replay",
			backend: "pi",
			transient: false,
			unresolvedMentions: [],
			replayed: true,
			replayedLifecycleEvent: {
				event_id: "crew-event-replayed",
				event: "ended",
				phase: "delivery",
				request_id: "req-replayed",
				command_id: null,
				requested_name: "worker",
				member_target: "worker_deadbeef",
				spawn_task_id: "spawn-task-replay",
				activation: "manual",
				delivery_state: "ended",
				hold_expires_at: null,
				error: "spawn failed after timeout reconciliation",
				reason: "spawn-failed",
			},
		});

		harness.eventHandlers.get("crew:add")?.({
			request_id: "req-replayed",
			name: "worker",
			type: "builder",
		});
		await flushAsyncWork(25);

		expect(queueCrewAddMock).toHaveBeenCalledTimes(1);
		expect(crewEventPayloads(harness.emit)).toContainEqual(
			expect.objectContaining({
				event_id: "crew-event-replayed",
				event: "failed",
				phase: "spawn",
				request_id: "req-replayed",
				spawn_task_id: "spawn-task-replay",
			}),
		);
	});

	it("preserves held delivery fields when replaying a claimed lifecycle snapshot", async () => {
		const harness = createHarness();
		await cacheProjectCwd(harness.lifecycleHandlers);
		setOwnerRoom();
		queueCrewAddMock.mockResolvedValueOnce({
			memberName: "worker_deadbeef",
			memberLabel: "worker#deadbeef",
			taskId: "spawn-task-claimed-held",
			backend: "paseo",
			transient: false,
			unresolvedMentions: [],
			replayed: true,
			replayedLifecycleEvent: {
				event_id: "crew-event-claimed-held",
				event: "claimed",
				phase: "delivery",
				request_id: "req-claimed-held",
				command_id: null,
				requested_name: "worker",
				member_target: "worker_deadbeef",
				member_type: "builder",
				room_id: "room-1",
				spawn_task_id: "spawn-task-claimed-held",
				runtime_id: null,
				activation: "manual",
				metadata: null,
				delivery_state: "held",
				hold_expires_at: "2026-05-26T00:01:00.000Z",
				error: null,
				reason: null,
			},
		});

		harness.eventHandlers.get("crew:add")?.({
			request_id: "req-claimed-held",
			name: "worker",
			type: "builder",
			activation: "manual",
			hold_timeout_ms: 30_000,
		});
		await flushAsyncWork(25);

		expect(queueCrewAddMock).toHaveBeenCalledTimes(1);
		expect(crewEventPayloads(harness.emit)).toContainEqual(
			expect.objectContaining({
				event_id: "crew-event-claimed-held",
				event: "claimed",
				phase: "claim",
				request_id: "req-claimed-held",
				spawn_task_id: "spawn-task-claimed-held",
				delivery_state: "held",
				hold_expires_at: "2026-05-26T00:01:00.000Z",
			}),
		);
	});

	it("emits rejected with a request-id-conflict reason when queueing reports conflicting reuse", async () => {
		const harness = createHarness();
		await cacheProjectCwd(harness.lifecycleHandlers);
		setOwnerRoom();
		queueCrewAddMock.mockRejectedValueOnce(
			Object.assign(new Error("request_id req-conflict conflicts with an existing crew:add"), {
				crewAddPhase: "request",
				crewAddReason: "request-id-conflict",
			}),
		);

		harness.eventHandlers.get("crew:add")?.({
			request_id: "req-conflict",
			name: "worker",
			type: "builder",
			task: "original task",
		});
		await flushAsyncWork(25);

		expect(queueCrewAddMock).toHaveBeenCalledTimes(1);
		expect(crewEventPayloads(harness.emit)).toContainEqual(
			expect.objectContaining({
				event: "rejected",
				phase: "request",
				request_id: "req-conflict",
				reason: "request-id-conflict",
			}),
		);
	});

	it("emits activated exactly once when an immediate generation first opens delivery", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-activated",
				cwd: tempDir,
				ownerPid: process.pid,
			});

			await createSpawningMember(created.roomDir, {
				name: "immediate-worker",
				displayName: "immediate-worker",
				type: "worker",
				backend: "pi",
				taskId: "spawn-activated-immediate",
				bootstrapToken: "bootstrap-activated-immediate",
				requestReplay: {
					requestId: "req-activated-immediate",
					requestedName: "immediate-worker",
					type: "worker",
					model: null,
					task: null,
					transient: false,
					metadata: { source: "event-feedback" },
					activation: "immediate",
					holdTimeoutMs: null,
				},
			} as never);

			vi.stubEnv("PI_ROOM_ID", created.metadata.roomId);
			vi.stubEnv("PI_ROOM_DIR", created.roomDir);
			vi.stubEnv("PI_ROOM_MEMBER_NAME", "immediate-worker");
			vi.stubEnv("PI_ROOM_MEMBER_TYPE", "worker");
			vi.stubEnv("PI_ROOM_BOOTSTRAP_TOKEN", "bootstrap-activated-immediate");
			vi.stubEnv("PI_ROOM_OWNER_NAME", "owner");
			vi.stubEnv("PI_ROOM_OWNER_SESSION_ID", created.metadata.ownerSessionId);

			const emit = vi.fn(async () => undefined);
			const pi = {
				events: { emit },
				sendMessage: vi.fn(),
			} as any;
			const adapters = {
				pi: { kind: "pi", async spawn() { throw new Error("not used"); } },
				paseo: { kind: "paseo", async spawn() { throw new Error("not used"); } },
			};

			await activateBootstrapRoom(
				pi,
				"",
				"immediate-worker-session",
				adapters as any,
			);
			await persistCrewAddReplayEvent({
				roomDir: created.roomDir,
				requestId: "req-activated-immediate",
				event: buildCrewLifecycleEvent({
					event: "enabled",
					phase: "delivery",
					request_id: "req-activated-immediate",
					command_id: null,
					requested_name: "immediate-worker",
					member_target: "immediate-worker",
					member_type: "worker",
					room_id: created.metadata.roomId,
					spawn_task_id: "spawn-activated-immediate",
					runtime_id: "immediate-worker-session",
					activation: "immediate",
					metadata: { source: "event-feedback" },
					delivery_state: "enabled",
					hold_expires_at: null,
					error: null,
					reason: null,
				}),
			});
			resetActiveRoomsForTests();
			await activateBootstrapRoom(
				pi,
				"",
				"immediate-worker-session",
				adapters as any,
			);

			const activatedCalls = emit.mock.calls.filter(
				([eventName, payload]) => eventName === "crew:event" && payload?.event === "activated",
			);
			expect(activatedCalls).toHaveLength(1);
			expect(activatedCalls[0]?.[1]).toMatchObject({
				event: "activated",
				phase: "activation",
				request_id: "req-activated-immediate",
				member_target: "immediate-worker",
				spawn_task_id: "spawn-activated-immediate",
				session_id: "immediate-worker-session",
				activation: "immediate",
				delivery_state: "enabled",
			});
		});
	});

	it("emits activated when crew:release targets a held manual generation", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-release",
					cwd: tempDir,
					ownerPid: process.pid,
				});
				await seedHeldManualGeneration(
					created.roomDir,
					created.metadata.ownerSessionId,
					created.metadata.roomId,
				);

				const harness = createHarness();
				setOwnerRoom({
					sessionId: created.metadata.ownerSessionId,
					roomDir: created.roomDir,
					roomId: created.metadata.roomId,
					memberName: "owner",
				});

				const releaseHandler = harness.eventHandlers.get("crew:release");
				expect(releaseHandler).toBeTypeOf("function");
				releaseHandler?.({
					spawn_task_id: "spawn-held-manual",
					command_id: "release-command-1",
					request_id: "req-held-manual",
				});
				await flushAsyncWork(25);

				expect(crewEventPayloads(harness.emit)).toContainEqual(
					expect.objectContaining({
						event: "activated",
						phase: "activation",
						request_id: "req-held-manual",
						command_id: "release-command-1",
						spawn_task_id: "spawn-held-manual",
					}),
				);
			});
		});

	it("emits aborted when crew:abort targets a held manual generation", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-abort",
					cwd: tempDir,
					ownerPid: process.pid,
				});
				await seedHeldManualGeneration(
					created.roomDir,
					created.metadata.ownerSessionId,
					created.metadata.roomId,
				);

				const harness = createHarness();
				setOwnerRoom({
					sessionId: created.metadata.ownerSessionId,
					roomDir: created.roomDir,
					roomId: created.metadata.roomId,
					memberName: "owner",
				});

				const abortHandler = harness.eventHandlers.get("crew:abort");
				expect(abortHandler).toBeTypeOf("function");
				abortHandler?.({
					spawn_task_id: "spawn-held-manual",
					command_id: "abort-command-1",
					request_id: "req-held-manual",
				});
				await flushAsyncWork(25);

				expect(crewEventPayloads(harness.emit)).toContainEqual(
					expect.objectContaining({
						event: "aborted",
						phase: "activation",
						reason: "caller_abort",
						request_id: "req-held-manual",
						command_id: "abort-command-1",
						spawn_task_id: "spawn-held-manual",
					}),
				);
			});
		});

	it("replays the prior activated outcome for an identical release command_id", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-release-replay",
					cwd: tempDir,
					ownerPid: process.pid,
				});
				await seedHeldManualGeneration(
					created.roomDir,
					created.metadata.ownerSessionId,
					created.metadata.roomId,
				);

				const harness = createHarness();
				setOwnerRoom({
					sessionId: created.metadata.ownerSessionId,
					roomDir: created.roomDir,
					roomId: created.metadata.roomId,
					memberName: "owner",
				});

				const releaseHandler = harness.eventHandlers.get("crew:release");
				expect(releaseHandler).toBeTypeOf("function");
				releaseHandler?.({
					spawn_task_id: "spawn-held-manual",
					command_id: "release-command-replay",
					request_id: "req-held-manual",
				});
				await flushAsyncWork(25);
				releaseHandler?.({
					spawn_task_id: "spawn-held-manual",
					command_id: "release-command-replay",
					request_id: "req-held-manual",
				});
				await flushAsyncWork(25);

				const activatedCalls = crewEventPayloads(harness.emit).filter(
					(payload) => payload.event === "activated",
				);
				expect(activatedCalls).toHaveLength(2);
				expect(activatedCalls[1]).toMatchObject({
					event_id: activatedCalls[0]?.event_id,
					command_id: "release-command-replay",
					phase: "activation",
				});
			});
		});

	it("emits activation-phase failed when a command_id is reused for a conflicting control verb", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-control-conflict",
					cwd: tempDir,
					ownerPid: process.pid,
				});
				await seedHeldManualGeneration(
					created.roomDir,
					created.metadata.ownerSessionId,
					created.metadata.roomId,
				);

				const harness = createHarness();
				setOwnerRoom({
					sessionId: created.metadata.ownerSessionId,
					roomDir: created.roomDir,
					roomId: created.metadata.roomId,
					memberName: "owner",
				});

				const releaseHandler = harness.eventHandlers.get("crew:release");
				const abortHandler = harness.eventHandlers.get("crew:abort");
				expect(releaseHandler).toBeTypeOf("function");
				expect(abortHandler).toBeTypeOf("function");

				releaseHandler?.({
					spawn_task_id: "spawn-held-manual",
					command_id: "conflicting-command-id",
					request_id: "req-held-manual",
				});
				await flushAsyncWork(25);
				abortHandler?.({
					spawn_task_id: "spawn-held-manual",
					command_id: "conflicting-command-id",
					request_id: "req-held-manual",
				});
				await flushAsyncWork(25);

				expect(crewEventPayloads(harness.emit)).toContainEqual(
					expect.objectContaining({
						event: "failed",
						phase: "activation",
						command_id: "conflicting-command-id",
						spawn_task_id: "spawn-held-manual",
					}),
				);
			});
		});

	it("replays hold_expired aborted outcomes for later crew:abort retries", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-expiry-replay",
					cwd: tempDir,
					ownerPid: process.pid,
				});
				await seedHeldManualGeneration(
					created.roomDir,
					created.metadata.ownerSessionId,
					created.metadata.roomId,
				);
				await persistCrewAddReplayEvent({
					roomDir: created.roomDir,
					requestId: "req-held-manual",
					event: buildCrewLifecycleEvent({
						event: "aborted",
						phase: "activation",
						request_id: "req-held-manual",
						command_id: null,
						requested_name: "held-worker",
						member_target: "held-worker",
						member_type: "worker",
						room_id: created.metadata.roomId,
						spawn_task_id: "spawn-held-manual",
						runtime_id: null,
						activation: "manual",
						metadata: { source: "event-feedback-control" },
						delivery_state: "ended",
						hold_expires_at: null,
						error: null,
						reason: "hold_expired",
					}),
				});

				const harness = createHarness();
				setOwnerRoom({
					sessionId: created.metadata.ownerSessionId,
					roomDir: created.roomDir,
					roomId: created.metadata.roomId,
					memberName: "owner",
				});

				const abortHandler = harness.eventHandlers.get("crew:abort");
				expect(abortHandler).toBeTypeOf("function");
				abortHandler?.({
					spawn_task_id: "spawn-held-manual",
					command_id: "abort-after-expiry",
					request_id: "req-held-manual",
				});
				await flushAsyncWork(25);

				expect(crewEventPayloads(harness.emit)).toContainEqual(
					expect.objectContaining({
						event: "aborted",
						phase: "activation",
						command_id: "abort-after-expiry",
						request_id: "req-held-manual",
						spawn_task_id: "spawn-held-manual",
						reason: "hold_expired",
					}),
				);
			});
		});

	it("emits activation-phase failed when crew:release targets a terminated generation", async () => {
			await withTempDir(async (tempDir) => {
				const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
				const created = await createRoom({
					runtimeRoot,
					ownerName: "owner",
					ownerSessionId: "owner-session-terminated-control",
					cwd: tempDir,
					ownerPid: process.pid,
				});
				await seedImmediateGeneration({
					roomDir: created.roomDir,
					roomId: created.metadata.roomId,
					ownerSessionId: created.metadata.ownerSessionId,
					memberName: "terminated-control-worker",
					taskId: "spawn-terminated-control",
					requestId: "req-terminated-control",
				});
				await persistCrewAddReplayEvent({
					roomDir: created.roomDir,
					requestId: "req-terminated-control",
					event: buildCrewLifecycleEvent({
						event: "terminated",
						phase: "delivery",
						request_id: "req-terminated-control",
						command_id: null,
						requested_name: "terminated-control-worker",
						member_target: "terminated-control-worker",
						member_type: "worker",
						room_id: created.metadata.roomId,
						spawn_task_id: "spawn-terminated-control",
						runtime_id: null,
						activation: "immediate",
						metadata: { source: "event-feedback-terminal" },
						delivery_state: "ended",
						hold_expires_at: null,
						error: null,
						reason: "removed",
					}),
				});

				const harness = createHarness();
				setOwnerRoom({
					sessionId: created.metadata.ownerSessionId,
					roomDir: created.roomDir,
					roomId: created.metadata.roomId,
					memberName: "owner",
				});

				const releaseHandler = harness.eventHandlers.get("crew:release");
				expect(releaseHandler).toBeTypeOf("function");
				releaseHandler?.({
					spawn_task_id: "spawn-terminated-control",
					command_id: "release-after-terminated",
					request_id: "req-terminated-control",
				});
				await flushAsyncWork(25);

				expect(crewEventPayloads(harness.emit)).toContainEqual(
					expect.objectContaining({
						event: "failed",
						phase: "activation",
						command_id: "release-after-terminated",
						request_id: "req-terminated-control",
						spawn_task_id: "spawn-terminated-control",
						reason: "invalid-activation-state",
					}),
				);
			});
		});

	it("emits terminated when crew_remove destroys the active generation", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-remove-terminal",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			await seedImmediateGeneration({
				roomDir: created.roomDir,
				roomId: created.metadata.roomId,
				ownerSessionId: created.metadata.ownerSessionId,
				memberName: "remove-worker",
				taskId: "spawn-remove-terminal",
				requestId: "req-remove-terminal",
			});

			const emit = vi.fn(async () => undefined);
			setCrewEventEmitter(emit);
			setOwnerRoom({
				sessionId: created.metadata.ownerSessionId,
				roomDir: created.roomDir,
				roomId: created.metadata.roomId,
				memberName: "owner",
			});
			try {
				await executeCrewRemove(
					{ name: "remove-worker" },
					{
						events: { emit: vi.fn(async () => undefined) },
						sendMessage: vi.fn(),
						getThinkingLevel: vi.fn(),
					} as any,
					{
						cwd: tempDir,
						hasUI: true,
						sessionManager: {
							getSessionId: () => created.metadata.ownerSessionId,
						},
					} as any,
					runtimeRoot,
					{
						pi: { kind: "pi", async spawn() { throw new Error("not used"); } },
						paseo: { kind: "paseo", async spawn() { throw new Error("not used"); } },
					} as any,
					{ ownerName: "owner" },
				);
				await flushAsyncWork(25);
			} finally {
				setCrewEventEmitter(null);
			}

			const payloads = emit.mock.calls.map(([payload]) => payload as Record<string, unknown>);
			expect(payloads).toContainEqual(
				expect.objectContaining({
					event: "terminated",
					phase: "runtime",
					request_id: "req-remove-terminal",
					member_target: "remove-worker",
					spawn_task_id: "spawn-remove-terminal",
					delivery_state: "ended",
					reason: "removed",
				}),
			);
		});
	});

	it("emits terminated when crew_stop transient removal destroys the active generation", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-stop-terminal",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			await createSpawningMember(created.roomDir, {
				name: "stop-transient-worker",
				displayName: "stop-transient-worker",
				type: "worker",
				backend: "pi",
				taskId: "spawn-stop-terminal",
				transient: true,
				bootstrapToken: "bootstrap-stop-terminal",
				requestReplay: {
					requestId: "req-stop-terminal",
					requestedName: "stop-transient-worker",
					type: "worker",
					model: null,
					task: "Stop this transient worker",
					transient: true,
					metadata: { source: "event-feedback-terminal" },
					activation: "immediate",
					holdTimeoutMs: null,
				},
			} as never);
			await markMemberJoined({
				bootstrap: {
					version: 1,
					roomId: created.metadata.roomId,
					roomDir: created.roomDir,
					memberName: "stop-transient-worker",
					memberType: "worker",
					ownerName: "owner",
					ownerSessionId: created.metadata.ownerSessionId,
					token: "bootstrap-stop-terminal",
					spawnTaskId: "spawn-stop-terminal",
				},
				sessionId: "stop-transient-worker-session",
				runtimeId: String(process.pid),
				backend: "pi",
			});

			const emit = vi.fn(async () => undefined);
			setCrewEventEmitter(emit);
			setOwnerRoom({
				sessionId: created.metadata.ownerSessionId,
				roomDir: created.roomDir,
				roomId: created.metadata.roomId,
				memberName: "owner",
			});
			try {
				await executeCrewStop(
					{ name: "stop-transient-worker" },
					{
						events: { emit: vi.fn(async () => undefined) },
						sendMessage: vi.fn(),
						getThinkingLevel: vi.fn(),
					} as any,
					{
						cwd: tempDir,
						hasUI: true,
						sessionManager: {
							getSessionId: () => created.metadata.ownerSessionId,
						},
					} as any,
					runtimeRoot,
					{
						pi: { kind: "pi", async spawn() { throw new Error("not used"); } },
						paseo: { kind: "paseo", async spawn() { throw new Error("not used"); } },
					} as any,
					{ ownerName: "owner" },
				);
				await flushAsyncWork(25);
			} finally {
				setCrewEventEmitter(null);
			}

			const payloads = emit.mock.calls.map(([payload]) => payload as Record<string, unknown>);
			expect(payloads).toContainEqual(
				expect.objectContaining({
					event: "terminated",
					phase: "runtime",
					request_id: "req-stop-terminal",
					member_target: "stop-transient-worker",
					spawn_task_id: "spawn-stop-terminal",
					delivery_state: "ended",
					reason: "transient_removed",
				}),
			);
		});
	});

	it("emits terminated when member session shutdown destroys the active generation", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-terminal-dedupe",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			await seedImmediateGeneration({
				roomDir: created.roomDir,
				roomId: created.metadata.roomId,
				ownerSessionId: created.metadata.ownerSessionId,
				memberName: "dedupe-worker",
				taskId: "spawn-terminal-dedupe",
				requestId: "req-terminal-dedupe",
			});

			const harness = createHarness();
			setActiveRoom({
				role: "member",
				roomDir: created.roomDir,
				roomId: created.metadata.roomId,
				memberName: "dedupe-worker",
				sessionId: "dedupe-worker-session",
				pollTimer: null,
				heartbeatTimer: null,
				pendingPoll: null,
				pendingHeartbeat: null,
				pendingToolTasks: new Set<Promise<unknown>>(),
				shuttingDown: false,
				pendingDeliveryBatch: [],
				deliveryTimer: null,
			} as any);

			const shutdown = harness.lifecycleHandlers.get("session_shutdown");
			expect(shutdown).toBeTypeOf("function");
			await shutdown?.(
				{},
				{
					cwd: tempDir,
					getSystemPrompt: () => "",
					sessionManager: {
						getSessionId: () => "dedupe-worker-session",
					},
				},
			);
			await flushAsyncWork(25);

			const terminalCalls = crewEventPayloads(harness.emit).filter(
				(payload) =>
					payload.event === "terminated"
					&& payload.spawn_task_id === "spawn-terminal-dedupe",
			);
			expect(terminalCalls).toHaveLength(1);
			expect(terminalCalls[0]).toMatchObject({
				event: "terminated",
				reason: "session_shutdown",
				request_id: "req-terminal-dedupe",
			});
		});
	});

	it("does not re-emit a persisted terminated outcome during member session shutdown", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session-terminal-replay",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			await seedImmediateGeneration({
				roomDir: created.roomDir,
				roomId: created.metadata.roomId,
				ownerSessionId: created.metadata.ownerSessionId,
				memberName: "terminal-replay-worker",
				taskId: "spawn-terminal-replay",
				requestId: "req-terminal-replay",
			});
			await persistCrewAddReplayEvent({
				roomDir: created.roomDir,
				requestId: "req-terminal-replay",
				event: buildCrewLifecycleEvent({
					event: "terminated",
					phase: "delivery",
					request_id: "req-terminal-replay",
					command_id: null,
					requested_name: "terminal-replay-worker",
					member_target: "terminal-replay-worker",
					member_type: "worker",
					room_id: created.metadata.roomId,
					spawn_task_id: "spawn-terminal-replay",
					runtime_id: null,
					activation: "immediate",
					metadata: { source: "event-feedback-terminal" },
					delivery_state: "ended",
					hold_expires_at: null,
					error: null,
					reason: "removed",
				}),
			});
			const persistedReplay = await readCrewAddRequestReplay(
				created.roomDir,
				"req-terminal-replay",
			);
			expect(persistedReplay?.replay?.event).toBe("terminated");

			const harness = createHarness();
			setActiveRoom({
				role: "member",
				roomDir: created.roomDir,
				roomId: created.metadata.roomId,
				memberName: "terminal-replay-worker",
				sessionId: "terminal-replay-worker-session",
				pollTimer: null,
				heartbeatTimer: null,
				pendingPoll: null,
				pendingHeartbeat: null,
				pendingToolTasks: new Set<Promise<unknown>>(),
				shuttingDown: false,
				pendingDeliveryBatch: [],
				deliveryTimer: null,
			} as any);

			const shutdown = harness.lifecycleHandlers.get("session_shutdown");
			expect(shutdown).toBeTypeOf("function");
			await shutdown?.(
				{},
				{
					cwd: tempDir,
					getSystemPrompt: () => "",
					sessionManager: {
						getSessionId: () => "terminal-replay-worker-session",
					},
				},
			);
			await flushAsyncWork(25);

			const terminalCalls = crewEventPayloads(harness.emit).filter(
				(payload) =>
					payload.event === "terminated"
					&& payload.spawn_task_id === "spawn-terminal-replay",
			);
			expect(terminalCalls).toHaveLength(0);
		});
	});
	});
