import { describe, expect, it, vi } from "vitest";
import {
	buildTaskLifecycleEvent,
	emitTaskLifecycleEvent,
	setTaskEventEmitter,
	type PublicTaskLifecycleEvent,
	type PublicTaskLifecycleEventName,
	type PublicTaskStatus,
} from "./task-integration-events.ts";
import {
	emitTaskLifecycleEvent as emitTaskLifecycleEventFromIndex,
	setTaskEventEmitter as setTaskEventEmitterFromIndex,
} from "./index.ts";
import roomExtension from "./index.ts";

function makeInput(
	overrides: Partial<{
		event: PublicTaskLifecycleEventName;
		task_status: PublicTaskStatus;
		room_id: string;
		member_target: string;
		member_type: string | null;
		request_id: string | null;
		spawn_task_id: string | null;
		runtime_id: string | null;
		session_id: string | null;
		task_seq: number;
		task_message_id: string;
		task_summary: string;
		reply_message_id: string | null;
		reply_summary: string | null;
		metadata: Record<string, unknown> | null;
		content_ref: PublicTaskLifecycleEvent["content_ref"];
		error: string | null;
		reason: string | null;
	}> = {},
) {
	return {
		event: "task:assigned" as const,
		task_status: "assigned" as const,
		room_id: "room-1",
		member_target: "worker-1",
		member_type: "worker",
		request_id: "req-1",
		spawn_task_id: "spawn-1",
		runtime_id: "rt-1",
		session_id: "sess-1",
		task_seq: 10,
		task_message_id: "msg-1",
		task_summary: "do the thing",
		reply_message_id: null,
		reply_summary: null,
		metadata: null,
		content_ref: {
			room_id: "room-1",
			message_id: "msg-1",
			seq: 10,
			kind: "room_message" as const,
		},
		error: null,
		reason: null,
		...overrides,
	};
}

describe("task-integration-events", () => {
	it("generates a deterministic event_id for the same normalized task transition", () => {
		const input = makeInput();

		const first = buildTaskLifecycleEvent(input);
		const second = buildTaskLifecycleEvent({ ...input });

		expect(first.event_id).toBe(second.event_id);
		expect(first.event_id).toMatch(/^crew-task-event-/);
	});

	it("excludes occurred_at, runtime_id, and session_id from identity hash", () => {
		const base = makeInput();

		const first = buildTaskLifecycleEvent(base);
		const second = buildTaskLifecycleEvent({
			...base,
			runtime_id: "rt-2",
			session_id: "sess-2",
		});

		// Same identity fields → same event_id
		expect(first.event_id).toBe(second.event_id);
	});

	it("produces different event_ids for different events on the same task", () => {
		const assigned = buildTaskLifecycleEvent(makeInput());
		const started = buildTaskLifecycleEvent(
			makeInput({ event: "task:started", task_status: "running" }),
		);

		expect(assigned.event_id).not.toBe(started.event_id);
	});

	it("maps task:failed to task_status: error", () => {
		const input = makeInput({
			event: "task:failed",
			task_status: "error",
		});

		const result = buildTaskLifecycleEvent(input);

		expect(result.event).toBe("task:failed");
		expect(result.task_status).toBe("error");
	});

	it("includes content_ref pointing to a board message, not a room file path", () => {
		const input = makeInput({
			content_ref: {
				room_id: "room-xyz",
				message_id: "board-msg-42",
				seq: 42,
				kind: "room_message",
			},
		});

		const result = buildTaskLifecycleEvent(input);

		expect(result.content_ref).toEqual({
			room_id: "room-xyz",
			message_id: "board-msg-42",
			seq: 42,
			kind: "room_message",
		});
		// No file path should appear in the payload
		expect(JSON.stringify(result)).not.toContain("/rooms/");
		expect(JSON.stringify(result)).not.toContain("roomDir");
	});

	it("emits full PublicTaskLifecycleEvent with protocol_version and occurred_at", async () => {
		const emitted: unknown[] = [];
		setTaskEventEmitter((payload) => {
			emitted.push(payload);
		});

		const input = makeInput();
		const result = await emitTaskLifecycleEvent(input);

		expect(emitted).toHaveLength(1);
		const payload = emitted[0] as PublicTaskLifecycleEvent;
		expect(payload.protocol_version).toBe(1);
		expect(payload.occurred_at).toEqual(expect.any(String));
		expect(new Date(payload.occurred_at).getTime()).toBeGreaterThan(0);
		expect(payload.event_id).toBe(result.event_id);
		expect(payload.event).toBe("task:assigned");
		expect(payload.task_status).toBe("assigned");
		expect(payload.room_id).toBe("room-1");
		expect(payload.member_target).toBe("worker-1");
		expect(payload.task_seq).toBe(10);
		expect(payload.task_message_id).toBe("msg-1");
		expect(payload.task_summary).toBe("do the thing");
	});

	it("swallows emitter failures and still returns the built payload", async () => {
		setTaskEventEmitter(() => {
			throw new Error("boom");
		});

		const input = makeInput({
			event: "task:failed",
			task_status: "error",
			error: "something broke",
		});

		const result = await emitTaskLifecycleEvent(input);

		expect(result.event_id).toMatch(/^crew-task-event-/);
		expect(result.event).toBe("task:failed");
		expect(result.task_status).toBe("error");
		expect(result.error).toBe("something broke");
	});

	it("returns the payload without emitting when no emitter is set", async () => {
		setTaskEventEmitter(null);

		const input = makeInput({ event: "task:completed", task_status: "completed" });
		const result = await emitTaskLifecycleEvent(input);

		expect(result.event_id).toMatch(/^crew-task-event-/);
		expect(result.event).toBe("task:completed");
	});

	it("allows the emitter to be reset", async () => {
		const sink = vi.fn();
		setTaskEventEmitter(sink);
		setTaskEventEmitter(null);

		await emitTaskLifecycleEvent(makeInput());

		expect(sink).not.toHaveBeenCalled();
	});

	it("re-exports the public helper surface from index.ts", () => {
		expect(emitTaskLifecycleEventFromIndex).toBe(emitTaskLifecycleEvent);
		expect(setTaskEventEmitterFromIndex).toBe(setTaskEventEmitter);
	});

	it("registers a best-effort crew:task sink from the extension entrypoint", async () => {
		const emit = vi.fn();

		(roomExtension as any)(
			{
				events: {
					on: vi.fn(),
					emit,
				},
				on: vi.fn(),
				registerTool: vi.fn(),
				sendMessage: vi.fn(),
				setActiveTools: vi.fn(),
				getAllTools: vi.fn(() => []),
				getThinkingLevel: vi.fn(),
			},
			{},
		);

		const result = await emitTaskLifecycleEvent(makeInput());

		expect(emit).toHaveBeenCalledWith("crew:task", expect.objectContaining({
			protocol_version: 1,
			event_id: result.event_id,
			event: "task:assigned",
			task_status: "assigned",
			room_id: "room-1",
			task_message_id: "msg-1",
		}));
	});
});
