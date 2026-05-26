import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCrewLifecycleEvent } from "./integration-events.ts";
import { setActiveRoom, resetActiveRoomsForTests } from "./lifecycle.ts";
import { activateBootstrapRoom } from "./lifecycle.ts";
import {
	createRoom,
	createSpawningMember,
	markMemberJoined,
	persistCrewAddReplayEvent,
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

type RegisteredHandler = (event: unknown, ctx?: unknown) => unknown;

function createHarness() {
	const eventHandlers = new Map<string, RegisteredHandler>();
	const lifecycleHandlers = new Map<string, RegisteredHandler>();
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
			registerTool: vi.fn(),
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
				event: "ended",
				phase: "delivery",
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
				phase: "delivery",
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
				([eventName, payload]) => eventName === "crew:event" && payload?.event === "enabled",
			);
			expect(activatedCalls).toHaveLength(1);
			expect(activatedCalls[0]?.[1]).toMatchObject({
				event: "enabled",
				request_id: "req-activated-immediate",
				member_target: "immediate-worker",
				spawn_task_id: "spawn-activated-immediate",
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
	});
