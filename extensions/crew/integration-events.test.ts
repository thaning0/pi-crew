import { describe, expect, it, vi } from "vitest";
import {
	createCrewEndedLifecycleEvent,
	createCrewHeldLifecycleEvent,
	createCrewPendingLifecycleEvent,
	emitCrewLifecycleEvent,
	setCrewEventEmitter,
} from "./integration-events.ts";
import {
	emitCrewLifecycleEvent as emitCrewLifecycleEventFromIndex,
	setCrewEventEmitter as setCrewEventEmitterFromIndex,
} from "./index.ts";
import roomExtension from "./index.ts";

describe("integration-events", () => {
	it("creates lifecycle envelopes without conflating member_target and spawn_task_id", () => {
		const pending = createCrewPendingLifecycleEvent({
			request_id: "req-1",
			command_id: "cmd-1",
			requested_name: "worker",
			member_target: "worker_ab12cd34",
			spawn_task_id: "spawn-123",
			activation: "immediate",
		});

		expect(pending).toMatchObject({
			request_id: "req-1",
			command_id: "cmd-1",
			requested_name: "worker",
			member_target: "worker_ab12cd34",
			spawn_task_id: "spawn-123",
			activation: "immediate",
			delivery_state: "pending",
			hold_expires_at: null,
			error: null,
			reason: null,
		});

		const held = createCrewHeldLifecycleEvent({
			request_id: "req-1",
			command_id: "cmd-1",
			requested_name: "worker",
			member_target: "worker_ab12cd34",
			spawn_task_id: "spawn-123",
			activation: "manual",
			hold_expires_at: "2026-01-02T03:04:05.000Z",
			reason: "awaiting-approval",
		});

		expect(held.delivery_state).toBe("held");
		expect(held.hold_expires_at).toBe("2026-01-02T03:04:05.000Z");
		expect(held.reason).toBe("awaiting-approval");

		const ended = createCrewEndedLifecycleEvent({
			request_id: "req-1",
			command_id: "cmd-1",
			requested_name: "worker",
			member_target: "worker_ab12cd34",
			spawn_task_id: "spawn-123",
			activation: "manual",
			error: "spawn failed",
			reason: "adapter-error",
		});

		expect(ended.delivery_state).toBe("ended");
		expect(ended.error).toBe("spawn failed");
		expect(ended.reason).toBe("adapter-error");
	});

	it("generates a stable event_id in the shared emission path", async () => {
		const emitted: unknown[] = [];
		setCrewEventEmitter((payload) => {
			emitted.push(payload);
		});

		const baseEvent = createCrewPendingLifecycleEvent({
			request_id: "req-2",
			command_id: "cmd-2",
			requested_name: "builder",
			member_target: "builder_eeff0011",
			spawn_task_id: "spawn-456",
			activation: "immediate",
		});

		const first = await emitCrewLifecycleEvent(baseEvent);
		const second = await emitCrewLifecycleEvent({ ...baseEvent });

		expect(first.event_id).toBe(second.event_id);
		expect(emitted).toEqual([first, second]);
	});

	it("swallows sink failures and still returns the emitted payload", async () => {
		setCrewEventEmitter(() => {
			throw new Error("boom");
		});

		const emitted = await emitCrewLifecycleEvent(
			createCrewHeldLifecycleEvent({
				request_id: "req-3",
				command_id: "cmd-3",
				requested_name: "reviewer",
				member_target: "reviewer_1234abcd",
				spawn_task_id: "spawn-789",
				activation: "manual",
				hold_expires_at: "2026-02-03T04:05:06.000Z",
				reason: "manual-approval",
			}),
		);

		expect(emitted.event_id).toMatch(/^crew-event-/);
		expect(emitted.delivery_state).toBe("held");
	});

	it("re-exports the public helper surface from index.ts", () => {
		expect(emitCrewLifecycleEventFromIndex).toBe(emitCrewLifecycleEvent);
		expect(setCrewEventEmitterFromIndex).toBe(setCrewEventEmitter);
	});

	it("registers a best-effort crew:event sink from the extension entrypoint", async () => {
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

		const emitted = await emitCrewLifecycleEvent(
			createCrewPendingLifecycleEvent({
				request_id: "req-5",
				command_id: "cmd-5",
				requested_name: "synth",
				member_target: "synth_deadbeef",
				spawn_task_id: "spawn-222",
				activation: "immediate",
			}),
		);

		expect(emit).toHaveBeenCalledWith("crew:event", emitted);
	});

	it("allows the emitter to be reset", async () => {
		const sink = vi.fn();
		setCrewEventEmitter(sink);
		setCrewEventEmitter(null);

		await emitCrewLifecycleEvent(
			createCrewEndedLifecycleEvent({
				request_id: "req-4",
				command_id: "cmd-4",
				requested_name: "planner",
				member_target: "planner_a1b2c3d4",
				spawn_task_id: "spawn-111",
				activation: "manual",
				reason: "cancelled",
			}),
		);

		expect(sink).not.toHaveBeenCalled();
	});
});
