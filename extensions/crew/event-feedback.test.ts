import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveRoom, resetActiveRoomsForTests } from "./lifecycle.ts";

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

function setOwnerRoom(sessionId = "owner-session"): void {
	setActiveRoom({
		role: "owner",
		roomDir: "/home/thn/pi-crew/extensions/crew",
		roomId: "room-1",
		memberName: "lead",
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

async function flushAsyncWork(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
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
		await flushAsyncWork();

		expect(queueCrewAddMock).not.toHaveBeenCalled();
		expect(crewEventPayloads(harness.emit)).toContainEqual(
			expect.objectContaining({
				event: "rejected",
				phase: "request",
				request_id: "req-invalid-shape",
			}),
		);
	});

	it("emits rejected when project cwd has not been cached yet", async () => {
		const harness = createHarness();
		setOwnerRoom();

		harness.eventHandlers.get("crew:add")?.({
			request_id: "req-no-cwd",
			name: "worker",
			type: "builder",
		});
		await flushAsyncWork();

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
		await flushAsyncWork();

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
		await flushAsyncWork();

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

	it("emits rejected when there is no active owner room", async () => {
		const harness = createHarness();
		await cacheProjectCwd(harness.lifecycleHandlers);

		harness.eventHandlers.get("crew:add")?.({
			request_id: "req-no-owner",
			name: "worker",
			type: "builder",
		});
		await flushAsyncWork();

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
		await flushAsyncWork();

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
		await flushAsyncWork();

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
		await flushAsyncWork();

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
		await flushAsyncWork();

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
		await flushAsyncWork();

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
});
