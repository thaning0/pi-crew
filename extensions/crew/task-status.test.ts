import { describe, expect, it, vi, afterEach } from "vitest";
import {
	classifyIdleTaskStatus,
	idleStatusToEventName,
	resolveTaskDepState,
} from "./task-status.ts";
import { setTaskEventEmitter, emitTaskLifecycleEvent } from "./task-integration-events.ts";
import {
	createRoom,
	writeRoomMemberState,
	appendMessage,
	loadRoomMemberState,
	appendDirectedTaskMessage,
	listBoardEntries,
} from "./storage.ts";
import { registerDeps, allDepsReady, clearRoomDeps } from "./deps.ts";
import type { PublicTaskLifecycleEvent } from "./task-integration-events.ts";
import { resetActiveRoomsForTests, setActiveRoom } from "./lifecycle.ts";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crew-task-status-test-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

afterEach(() => {
	resetActiveRoomsForTests();
	setTaskEventEmitter(null);
	vi.restoreAllMocks();
});

describe("classifyIdleTaskStatus", () => {
	it("no deps + idle member → assigned", () => {
		expect(classifyIdleTaskStatus({
			hasDeps: false,
			depsReady: true,
			hasError: false,
			hasCancelled: false,
		})).toBe("assigned");
	});

	it("unresolved deps + idle member → waiting_deps", () => {
		expect(classifyIdleTaskStatus({
			hasDeps: true,
			depsReady: false,
			hasError: false,
			hasCancelled: false,
		})).toBe("waiting_deps");
	});

	it("failed upstream + idle member → blocked_failed", () => {
		expect(classifyIdleTaskStatus({
			hasDeps: true,
			depsReady: true,
			hasError: true,
			hasCancelled: false,
		})).toBe("blocked_failed");
	});

	it("cancelled upstream + idle member → blocked_failed", () => {
		expect(classifyIdleTaskStatus({
			hasDeps: true,
			depsReady: true,
			hasError: false,
			hasCancelled: true,
		})).toBe("blocked_failed");
	});

	it("all deps resolved (no errors) + idle member → assigned", () => {
		expect(classifyIdleTaskStatus({
			hasDeps: true,
			depsReady: true,
			hasError: false,
			hasCancelled: false,
		})).toBe("assigned");
	});

	it("hasError takes priority over unresolved deps", () => {
		expect(classifyIdleTaskStatus({
			hasDeps: true,
			depsReady: false,
			hasError: true,
			hasCancelled: false,
		})).toBe("blocked_failed");
	});

	it("hasCancelled takes priority over unresolved deps", () => {
		expect(classifyIdleTaskStatus({
			hasDeps: true,
			depsReady: false,
			hasError: false,
			hasCancelled: true,
		})).toBe("blocked_failed");
	});

	it("both error and cancelled → blocked_failed", () => {
		expect(classifyIdleTaskStatus({
			hasDeps: true,
			depsReady: true,
			hasError: true,
			hasCancelled: true,
		})).toBe("blocked_failed");
	});
});

describe("idleStatusToEventName", () => {
	it("maps assigned → task:assigned", () => {
		expect(idleStatusToEventName("assigned")).toBe("task:assigned");
	});

	it("maps waiting_deps → task:waiting_deps", () => {
		expect(idleStatusToEventName("waiting_deps")).toBe("task:waiting_deps");
	});

	it("maps blocked_failed → task:blocked_failed", () => {
		expect(idleStatusToEventName("blocked_failed")).toBe("task:blocked_failed");
	});
});

describe("idleStatusToEventName integration", () => {
	it("classifyIdleTaskStatus + idleStatusToEventName produces correct event for each state", () => {
		const assigned = classifyIdleTaskStatus({
			hasDeps: false, depsReady: true, hasError: false, hasCancelled: false,
		});
		expect(idleStatusToEventName(assigned)).toBe("task:assigned");

		const waiting = classifyIdleTaskStatus({
			hasDeps: true, depsReady: false, hasError: false, hasCancelled: false,
		});
		expect(idleStatusToEventName(waiting)).toBe("task:waiting_deps");

		const blocked = classifyIdleTaskStatus({
			hasDeps: true, depsReady: false, hasError: true, hasCancelled: false,
		});
		expect(idleStatusToEventName(blocked)).toBe("task:blocked_failed");
	});
});

describe("resolveTaskDepState", () => {
	it("no deps → hasDeps=false, depsReady=true, no errors", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setActiveRoom({
				role: "owner",
				roomDir: created.roomDir,
				roomId: created.metadata.roomId,
				memberName: created.metadata.ownerName,
				sessionId: "owner-session",
				pollTimer: null,
				heartbeatTimer: null,
				pendingPoll: null,
				pendingHeartbeat: null,
				pendingToolTasks: new Set(),
				shuttingDown: false,
				pendingDeliveryBatch: [],
				deliveryTimer: null,
			});

			const state = await resolveTaskDepState(created.roomDir, "No deps here.");
			expect(state).toEqual({ hasDeps: false, depsReady: true, hasError: false, hasCancelled: false });
		});
	});

	it("pending deps → hasDeps=true, depsReady=false", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setActiveRoom({
				role: "owner",
				roomDir: created.roomDir,
				roomId: created.metadata.roomId,
				memberName: created.metadata.ownerName,
				sessionId: "owner-session",
				pollTimer: null, heartbeatTimer: null, pendingPoll: null, pendingHeartbeat: null,
				pendingToolTasks: new Set(), shuttingDown: false,
				pendingDeliveryBatch: [], deliveryTimer: null,
			});

			// Create worker members so we can post tasks to them
			await writeRoomMemberState(created.roomDir, {
				name: "worker_a", displayName: "worker_a", type: "worker", backend: "pi",
				runtimeId: null, state: "idle", spawnTaskId: null, currentTask: null,
				lastCompletedTask: null, lastError: null, lastSeenSeq: 0,
				joinedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
				sessionId: "worker_a-session",
			});
			await writeRoomMemberState(created.roomDir, {
				name: "worker_b", displayName: "worker_b", type: "worker", backend: "pi",
				runtimeId: null, state: "idle", spawnTaskId: null, currentTask: null,
				lastCompletedTask: null, lastError: null, lastSeenSeq: 0,
				joinedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
				sessionId: "worker_b-session",
			});

			// Create upstream task (still pending/running)
			const upstream = await appendMessage(created.roomDir, {
				from: "owner", to: "worker_a", broadcast: false, replyTo: null,
				kind: "task", summary: "Upstream",
			});
			registerDeps(created.roomDir, upstream.seq, `Ref: {input:#${upstream.seq}}`, "worker_b");

			const content = `Wait for {input:#${upstream.seq}}.`;
			const state = await resolveTaskDepState(created.roomDir, content);
			expect(state).toMatchObject({ hasDeps: true, depsReady: false, hasError: false, hasCancelled: false });
		});
	});

	it("resolved deps → depsReady=true", async () => {
		await withTempDir(async (tempDir) => {
			const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
			const created = await createRoom({
				runtimeRoot,
				ownerName: "owner",
				ownerSessionId: "owner-session",
				cwd: tempDir,
				ownerPid: process.pid,
			});
			setActiveRoom({
				role: "owner",
				roomDir: created.roomDir,
				roomId: created.metadata.roomId,
				memberName: created.metadata.ownerName,
				sessionId: "owner-session",
				pollTimer: null, heartbeatTimer: null, pendingPoll: null, pendingHeartbeat: null,
				pendingToolTasks: new Set(), shuttingDown: false,
				pendingDeliveryBatch: [], deliveryTimer: null,
			});

			// Create and complete upstream
			// Create worker members so we can post tasks to them
			await writeRoomMemberState(created.roomDir, {
				name: "worker_a", displayName: "worker_a", type: "worker", backend: "pi",
				runtimeId: null, state: "idle", spawnTaskId: null, currentTask: null,
				lastCompletedTask: null, lastError: null, lastSeenSeq: 0,
				joinedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
				sessionId: "worker_a-session",
			});

			// Create and complete upstream
			const upstream = await appendMessage(created.roomDir, {
				from: "owner", to: "worker_a", broadcast: false, replyTo: null,
				kind: "task", summary: "Upstream",
			});
			registerDeps(created.roomDir, upstream.seq, `Ref: {input:#${upstream.seq}}`, "owner");
			await appendMessage(created.roomDir, {
				from: "worker_a", to: "owner", broadcast: false, replyTo: upstream.id,
				kind: "completion", summary: "Done",
			});

			const content = `Wait for {input:#${upstream.seq}}.`;
			const state = await resolveTaskDepState(created.roomDir, content);
			expect(state).toMatchObject({ hasDeps: true, depsReady: true, hasError: false, hasCancelled: false });
		});
	});
});

describe("task lifecycle event emission via emitTaskLifecycleEvent", () => {
	it("emits task:assigned with correct task_status for no-deps task", async () => {
		const events: PublicTaskLifecycleEvent[] = [];
		setTaskEventEmitter(async (payload) => { events.push(payload); });

		const payload = await emitTaskLifecycleEvent({
			event: "task:assigned",
			task_status: "assigned",
			room_id: "room-1",
			member_target: "worker-1",
			member_type: "worker",
			task_seq: 1,
			task_message_id: "msg-1",
			task_summary: "Do work",
			content_ref: { room_id: "room-1", message_id: "msg-1", seq: 1, kind: "room_message" },
		});

		expect(events).toHaveLength(1);
		expect(events[0].event).toBe("task:assigned");
		expect(events[0].task_status).toBe("assigned");
		expect(events[0].task_seq).toBe(1);
		expect(payload.event_id).toBe(events[0].event_id);
	});

	it("emits task:waiting_deps with correct task_status", async () => {
		const events: PublicTaskLifecycleEvent[] = [];
		setTaskEventEmitter(async (payload) => { events.push(payload); });

		await emitTaskLifecycleEvent({
			event: "task:waiting_deps",
			task_status: "waiting_deps",
			room_id: "room-1",
			member_target: "worker-2",
			member_type: "worker",
			task_seq: 2,
			task_message_id: "msg-2",
			task_summary: "Wait for dep",
			content_ref: { room_id: "room-1", message_id: "msg-2", seq: 2, kind: "room_message" },
		});

		expect(events).toHaveLength(1);
		expect(events[0].event).toBe("task:waiting_deps");
		expect(events[0].task_status).toBe("waiting_deps");
	});

	it("emits task:blocked_failed with correct task_status", async () => {
		const events: PublicTaskLifecycleEvent[] = [];
		setTaskEventEmitter(async (payload) => { events.push(payload); });

		await emitTaskLifecycleEvent({
			event: "task:blocked_failed",
			task_status: "blocked_failed",
			room_id: "room-1",
			member_target: "worker-3",
			member_type: "worker",
			task_seq: 3,
			task_message_id: "msg-3",
			task_summary: "Blocked by upstream",
			content_ref: { room_id: "room-1", message_id: "msg-3", seq: 3, kind: "room_message" },
		});

		expect(events).toHaveLength(1);
		expect(events[0].event).toBe("task:blocked_failed");
		expect(events[0].task_status).toBe("blocked_failed");
	});

	it("event_id is deterministic for same transition", async () => {
		const inputBase = {
			event: "task:assigned" as const,
			task_status: "assigned" as const,
			room_id: "room-1",
			member_target: "worker-1",
			member_type: "worker" as const,
			task_seq: 1,
			task_message_id: "msg-1",
			task_summary: "Do work",
			content_ref: { room_id: "room-1" as const, message_id: "msg-1", seq: 1, kind: "room_message" as const },
		};

		const first = await emitTaskLifecycleEvent(inputBase);
		const second = await emitTaskLifecycleEvent(inputBase);
		expect(second.event_id).toBe(first.event_id);
	});
});
