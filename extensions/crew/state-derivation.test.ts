import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	appendMessage,
	createRoom,
	createSpawningMember,
	listBoardEntries,
	loadRoomMemberState,
	markMemberJoined,
	persistCrewAddReplayEvent,
	readSpawnJob,
	resolveTaskSeqByMessageId,
	writeRoomMemberState,
} from "./storage.ts";
import { processUnreadMessages, resetActiveRoomsForTests, setActiveRoom } from "./lifecycle.ts";
import { executeCrewTasks, executeCrewTell, collectCrewWhoEntries } from "./tools.ts";
import { createPiMemberAdapter, createPaseoPiMemberAdapter } from "./spawn.ts";
import { recordTerminalTaskState, appendTerminalTaskReplyAndNotify } from "./task-terminal.ts";
import { clearRoomDeps } from "./deps.ts";
import type { RoomMemberState } from "./types.ts";
import { buildCrewLifecycleEvent } from "./integration-events.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crew-state-derivation-test-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

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

function setOwnerActiveRoomContext(created: Awaited<ReturnType<typeof createRoom>>, sessionId: string) {
	return setActiveRoom({
		role: "owner",
		roomDir: created.roomDir,
		roomId: created.metadata.roomId,
		memberName: created.metadata.ownerName,
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

function setMemberActiveRoomContext(created: Awaited<ReturnType<typeof createRoom>>, sessionId: string, memberName: string) {
	return setActiveRoom({
		role: "member",
		roomDir: created.roomDir,
		roomId: created.metadata.roomId,
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

async function createRoomWithWorkers(tempDir: string, ownerSessionId = "owner-session-state") {
	const runtimeRoot = path.join(tempDir, ".pi", "agent", "runtime", "rooms");
	const created = await createRoom({
		runtimeRoot,
		ownerName: "owner",
		ownerSessionId,
		cwd: tempDir,
		ownerPid: process.pid,
	});
	await writeRoomMemberState(created.roomDir, createMemberState("worker_a"));
	await writeRoomMemberState(created.roomDir, createMemberState("worker_b"));
	return { created, runtimeRoot };
}

async function createReplayableClaimedMember(
	created: Awaited<ReturnType<typeof createRoom>>,
	options: {
		memberName: string;
		activation: "immediate" | "manual";
		requestId: string;
		taskId: string;
		holdExpiresAt?: string | null;
	},
) {
	const spawned = await createSpawningMember(created.roomDir, {
		name: options.memberName,
		displayName: options.memberName,
		type: "worker",
		backend: "pi",
		taskId: options.taskId,
		bootstrapToken: `bootstrap-${options.requestId}`,
		requestReplay: {
			requestId: options.requestId,
			requestedName: options.memberName,
			type: "worker",
			model: null,
			task: null,
			transient: false,
			metadata: { source: "state-derivation" },
			activation: options.activation,
			holdTimeoutMs:
				options.activation === "manual" && options.holdExpiresAt ? 30_000 : null,
		},
	} as never);

	if (options.activation === "manual" && options.holdExpiresAt) {
		await persistCrewAddReplayEvent({
			roomDir: created.roomDir,
			requestId: options.requestId,
			event: buildCrewLifecycleEvent({
				event: "spawned",
				phase: "spawn",
				request_id: options.requestId,
				command_id: null,
				requested_name: options.memberName,
				member_target: options.memberName,
				member_type: "worker",
				room_id: created.metadata.roomId,
				spawn_task_id: options.taskId,
				runtime_id: null,
				activation: "manual",
				metadata: { source: "state-derivation" },
				delivery_state: "held",
				hold_expires_at: options.holdExpiresAt,
				error: null,
				reason: null,
			}),
			member: spawned.member,
			job: spawned.job,
		});
	}

	await markMemberJoined({
		bootstrap: {
			version: 1,
			roomId: created.metadata.roomId,
			roomDir: created.roomDir,
			memberName: options.memberName,
			memberType: "worker",
			ownerName: created.metadata.ownerName,
			ownerSessionId: created.metadata.ownerSessionId,
			token: `bootstrap-${options.requestId}`,
			spawnTaskId: options.taskId,
		},
		sessionId: `${options.memberName}-session`,
		runtimeId: `runtime-${options.memberName}`,
		backend: "pi",
	});

	const member = await loadRoomMemberState(created.roomDir, options.memberName);
	const job = await readSpawnJob(created.roomDir, options.taskId);
	if (!job) throw new Error(`missing spawn job ${options.taskId}`);
	return { member, job };
}

async function runCrewWho(roomDir: string, cwd: string) {
	return await collectCrewWhoEntries(roomDir, cwd);
}

async function runCrewTasks(
	tempDir: string,
	runtimeRoot: string,
	sessionId: string,
	params: { limit?: number; before?: number; status?: string } = {},
) {
	const result = await executeCrewTasks(
		params,
		{ sendMessage() { return undefined; } } as ExtensionAPI,
		{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => sessionId } },
		runtimeRoot,
		{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
		{},
	);
	return result.content[0]?.text ?? "";
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
		{ cwd: tempDir, hasUI: false, sessionManager: { getSessionId: () => sessionId } },
		runtimeRoot,
		{ pi: createPiMemberAdapter(), paseo: createPaseoPiMemberAdapter() },
		{},
	);
	const seqMatch = result.content[0]?.text.match(/seq:\s*(\d+)/);
	if (!seqMatch) throw new Error(`failed to parse task seq from ${result.content[0]?.text ?? "(empty)"}`);
	return Number(seqMatch[1]);
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Timed out waiting for condition");
}

afterEach(() => {
	resetActiveRoomsForTests();
});

describe("crew state derivation", () => {
	it("derives assigned and waiting_deps for idle members that hold tasks", async () => {
		await withTempDir(async (tempDir) => {
			const { created, runtimeRoot } = await createRoomWithWorkers(tempDir);
			setOwnerActiveRoomContext(created, "owner-session-state");

			const upstreamSeq = await sendOwnerTask(tempDir, runtimeRoot, "owner-session-state", {
				to: "worker_a",
				summary: "Build upstream artifact",
			});
			await sendOwnerTask(tempDir, runtimeRoot, "owner-session-state", {
				to: "worker_b",
				summary: "Review upstream artifact",
				content: `Wait for {input:#${upstreamSeq}} before starting.`,
			});

			const members = await runCrewWho(created.roomDir, tempDir);
			const workerA = members.find((member) => member.name === "worker_a");
			const workerB = members.find((member) => member.name === "worker_b");
			expect(workerA).toMatchObject({ state: "assigned" });
			expect(workerA).not.toHaveProperty("rawState");
			expect(workerB).toMatchObject({ state: "waiting_deps" });
			expect(workerB).not.toHaveProperty("rawState");

			expect(await runCrewTasks(tempDir, runtimeRoot, "owner-session-state", { status: "assigned" })).toContain("Build upstream artifact");
			expect(await runCrewTasks(tempDir, runtimeRoot, "owner-session-state", { status: "waiting_deps" })).toContain("Review upstream artifact");
		});
	});

	it("derives blocked_failed after an upstream task errors and targets only the dependent member", async () => {
		await withTempDir(async (tempDir) => {
			const { created, runtimeRoot } = await createRoomWithWorkers(tempDir);
			setOwnerActiveRoomContext(created, "owner-session-state");

			const upstreamSeq = await sendOwnerTask(tempDir, runtimeRoot, "owner-session-state", {
				to: "worker_a",
				summary: "Compile dataset",
			});
			const upstream = (await listBoardEntries(created.roomDir, 20)).find((entry) => entry.seq === upstreamSeq);
			if (!upstream) throw new Error("expected upstream task on board");
			await sendOwnerTask(tempDir, runtimeRoot, "owner-session-state", {
				to: "worker_b",
				summary: "Summarize dataset",
				content: `Wait for {input:#${upstream.seq}} before starting.`,
			});

			await recordTerminalTaskState({
				roomDir: created.roomDir,
				upstreamSeq: upstream.seq,
				taskMessageId: upstream.id,
				status: "error",
				logContext: { source: "state-derivation-test" },
			});

			expect(await runCrewTasks(tempDir, runtimeRoot, "owner-session-state", { status: "blocked_failed" })).toContain("Summarize dataset");

			const members = await runCrewWho(created.roomDir, tempDir);
			const memberB_err = members.find((member) => member.name === "worker_b");
			expect(memberB_err).toMatchObject({ state: "blocked_failed" });
			expect(memberB_err).not.toHaveProperty("rawState");

			const notifications = (await listBoardEntries(created.roomDir, 20)).filter((entry) => entry.from === "system");
			expect(notifications).toHaveLength(1);
			expect(notifications[0]).toMatchObject({
				to: "worker_b",
			});
			expect(notifications[0]?.summary).toMatch(/^Dependency failed/);
		});
	});

	it("derives blocked_failed after an upstream task is cancelled", async () => {
		await withTempDir(async (tempDir) => {
			const { created, runtimeRoot } = await createRoomWithWorkers(tempDir);
			setOwnerActiveRoomContext(created, "owner-session-cancelled");

			const upstreamSeq = await sendOwnerTask(tempDir, runtimeRoot, "owner-session-cancelled", {
				to: "worker_a",
				summary: "Prepare inputs",
			});
			const upstream = (await listBoardEntries(created.roomDir, 20)).find((entry) => entry.seq === upstreamSeq);
			if (!upstream) throw new Error("expected upstream task on board");
			await sendOwnerTask(tempDir, runtimeRoot, "owner-session-cancelled", {
				to: "worker_b",
				summary: "Use prepared inputs",
				content: `Wait for {input:#${upstream.seq}} before starting.`,
			});

			await recordTerminalTaskState({
				roomDir: created.roomDir,
				upstreamSeq: upstream.seq,
				taskMessageId: upstream.id,
				status: "cancelled",
				logContext: { source: "state-derivation-test-cancelled" },
			});

			expect(await runCrewTasks(tempDir, runtimeRoot, "owner-session-cancelled", { status: "blocked_failed" })).toContain("Use prepared inputs");

			const members = await runCrewWho(created.roomDir, tempDir);
			const memberB_err = members.find((member) => member.name === "worker_b");
			expect(memberB_err).toMatchObject({ state: "blocked_failed" });
			expect(memberB_err).not.toHaveProperty("rawState");

			const notifications = (await listBoardEntries(created.roomDir, 20)).filter((entry) => entry.from === "system");
			expect(notifications).toHaveLength(1);
			expect(notifications[0]).toMatchObject({ to: "worker_b" });
			expect(notifications[0]?.summary).toMatch(/^Dependency cancelled/);
		});
	});

	it("reports chatting instead of running for an idle member with chatBusy set", async () => {
		await withTempDir(async (tempDir) => {
			const { created, runtimeRoot } = await createRoomWithWorkers(tempDir, "owner-session-chatting");
			setOwnerActiveRoomContext(created, "owner-session-chatting");

			const worker = await loadRoomMemberState(created.roomDir, "worker_b");
			await writeRoomMemberState(created.roomDir, {
				...worker,
				chatBusy: true,
				state: "idle",
				currentTask: null,
				currentTaskMessageId: null,
				updatedAt: new Date().toISOString(),
			});

			const members = await runCrewWho(created.roomDir, tempDir);
			const chattingMember = members.find((member) => member.name === "worker_b");
			expect(chattingMember).toMatchObject({ state: "chatting" });
			expect(chattingMember).not.toHaveProperty("rawState");
		});
	});

	it("does not mark a task agentLost while the errored member still holds that task", async () => {
		await withTempDir(async (tempDir) => {
			const { created, runtimeRoot } = await createRoomWithWorkers(tempDir);
			setOwnerActiveRoomContext(created, "owner-session-state");

			const task = await appendMessage(created.roomDir, {
				from: "owner",
				to: "worker_a",
				broadcast: false,
				replyTo: null,
				kind: "task",
				summary: "Recover work after transient runtime issue",
			});
			const worker = await loadRoomMemberState(created.roomDir, "worker_a");
			await writeRoomMemberState(created.roomDir, {
				...worker,
				state: "error",
				currentTask: task.summary,
				currentTaskMessageId: task.id,
				updatedAt: new Date().toISOString(),
			});

			expect(await runCrewTasks(tempDir, runtimeRoot, "owner-session-state", { status: "agentLost" })).toBe("(no tasks)");
			expect(await runCrewTasks(tempDir, runtimeRoot, "owner-session-state", { status: "running" })).toContain(task.summary);
		});
	});

	it("adds Starting only when a dependency-gated task actually becomes running", async () => {
		await withTempDir(async (tempDir) => {
			const { created, runtimeRoot } = await createRoomWithWorkers(tempDir, "owner-session-starting");
			setOwnerActiveRoomContext(created, "owner-session-starting");
			const memberContext = setMemberActiveRoomContext(created, "worker_b-session", "worker_b");

			const upstreamSeq = await sendOwnerTask(tempDir, runtimeRoot, "owner-session-starting", {
				to: "worker_a",
				summary: "Prepare source material",
			});
			const upstream = (await listBoardEntries(created.roomDir, 20)).find((entry) => entry.seq === upstreamSeq);
			if (!upstream) throw new Error("expected upstream task on board");
			const downstreamSeq = await sendOwnerTask(tempDir, runtimeRoot, "owner-session-starting", {
				to: "worker_b",
				summary: "Draft final report",
				content: `Wait for {input:#${upstream.seq}} before starting.`,
			});
			const downstream = (await listBoardEntries(created.roomDir, 20)).find((entry) => entry.seq === downstreamSeq);
			if (!downstream) throw new Error("expected downstream task on board");

			await processUnreadMessages({ sendMessage() { return undefined; } } as ExtensionAPI, memberContext);

			expect((await listBoardEntries(created.roomDir, 20)).some((entry) => entry.summary === `Starting: ${downstream.summary}`)).toBe(false);
			expect(await resolveTaskSeqByMessageId(created.roomDir, downstream.id)).toBe(downstream.seq);

			await recordTerminalTaskState({
				roomDir: created.roomDir,
				upstreamSeq: upstream.seq,
				taskMessageId: upstream.id,
				status: "completed",
				logContext: { source: "state-derivation-test-ready" },
			});

			await waitFor(async () => {
				const board = await listBoardEntries(created.roomDir, 20);
				return board.some((entry) => entry.from === "system" && entry.to === "worker_b" && entry.summary === `All dependencies ready for task #${downstream.seq}`);
			});

			await processUnreadMessages({ sendMessage() { return undefined; } } as ExtensionAPI, memberContext);
			await waitFor(async () => (await loadRoomMemberState(created.roomDir, "worker_b")).state === "running");

			await waitFor(async () => {
				const board = await listBoardEntries(created.roomDir, 20);
				return board.filter((entry) => entry.summary === `Starting: ${downstream.summary}`).length === 1;
			});

			const worker = await loadRoomMemberState(created.roomDir, "worker_b");
			expect(worker.state).toBe("running");
			const board = await listBoardEntries(created.roomDir, 20);
			expect(board.filter((entry) => entry.summary === `Starting: ${downstream.summary}`)).toHaveLength(1);
			expect(board.some((entry) => entry.from === "system" && entry.to === "worker_b" && entry.summary === `All dependencies ready for task #${downstream.seq}`)).toBe(true);
		});
	});

	it("no-deps task: owner does not pre-write running; member poll transitions to running with Starting: appended", async () => {
		await withTempDir(async (tempDir) => {
			const { created, runtimeRoot } = await createRoomWithWorkers(tempDir, "owner-session-nodeps");
			setOwnerActiveRoomContext(created, "owner-session-nodeps");
			// Session ID must match what createMemberState("worker_a") sets
			const memberContext = setMemberActiveRoomContext(created, "worker_a-session", "worker_a");

			const taskSeq = await sendOwnerTask(tempDir, runtimeRoot, "owner-session-nodeps", {
				to: "worker_a",
				summary: "Immediate start — no deps",
			});

			// Owner must NOT have pre-written "running"; member state should still be idle
			const stateBeforePoll = await loadRoomMemberState(created.roomDir, "worker_a");
			expect(stateBeforePoll.state).not.toBe("running");
			expect(stateBeforePoll.currentTask).toBe("Immediate start — no deps");

			// Member polls and transitions to running
			await processUnreadMessages({ sendMessage() { return undefined; } } as ExtensionAPI, memberContext);

			const stateAfterPoll = await loadRoomMemberState(created.roomDir, "worker_a");
			expect(stateAfterPoll.state).toBe("running");

			// Starting: message must appear exactly once
			await waitFor(async () => {
				const board = await listBoardEntries(created.roomDir, 20);
				return board.some((entry) => entry.summary === "Starting: Immediate start — no deps");
			});
			const board = await listBoardEntries(created.roomDir, 20);
			const task = board.find((entry) => entry.seq === taskSeq);
			expect(task).toBeDefined();
			expect(board.filter((entry) => entry.summary === "Starting: Immediate start — no deps")).toHaveLength(1);
		});
	});

	it("ready-at-assignment: deps already satisfied when member first polls transitions immediately to running", async () => {
		await withTempDir(async (tempDir) => {
			const { created, runtimeRoot } = await createRoomWithWorkers(tempDir, "owner-session-ready-assign");
			setOwnerActiveRoomContext(created, "owner-session-ready-assign");
			const memberContext = setMemberActiveRoomContext(created, "worker_b-session", "worker_b");

			// Upstream task that completes before downstream is even assigned
			const upstreamSeq = await sendOwnerTask(tempDir, runtimeRoot, "owner-session-ready-assign", {
				to: "worker_a",
				summary: "Already finished upstream",
			});
			const upstream = (await listBoardEntries(created.roomDir, 20)).find((e) => e.seq === upstreamSeq);
			if (!upstream) throw new Error("upstream task not found");

			// Mark upstream as completed before assigning downstream (writes to disk so ensureRoomLoaded sees it)
			await appendTerminalTaskReplyAndNotify({
				roomDir: created.roomDir,
				upstreamSeq: upstream.seq,
				taskMessageId: upstream.id,
				from: "worker_a",
				to: "owner",
				kind: "completion",
				summary: "Already finished upstream — complete",
				logContext: { source: "ready-at-assignment-test" },
			});

			// Now assign downstream task — deps are already resolved
			await sendOwnerTask(tempDir, runtimeRoot, "owner-session-ready-assign", {
				to: "worker_b",
				summary: "Start immediately — deps done",
				content: `Use {input:#${upstream.seq}} for context.`,
			});

			// Member polls — should transition to running because allDepsReady returns true
			await processUnreadMessages({ sendMessage() { return undefined; } } as ExtensionAPI, memberContext);

			const state = await loadRoomMemberState(created.roomDir, "worker_b");
			expect(state.state).toBe("running");

			// Starting: must appear
			await waitFor(async () => {
				const board = await listBoardEntries(created.roomDir, 20);
				return board.some((entry) => entry.summary === "Starting: Start immediately — deps done");
			});
			const board = await listBoardEntries(created.roomDir, 20);
			expect(board.filter((entry) => entry.summary === "Starting: Start immediately — deps done")).toHaveLength(1);
		});
	});

	it("multi-dep failure dedup: two upstreams fail but downstream receives only one failure notification", async () => {
		await withTempDir(async (tempDir) => {
			const { created, runtimeRoot } = await createRoomWithWorkers(tempDir, "owner-session-multidep");
			setOwnerActiveRoomContext(created, "owner-session-multidep");

			// Add a third worker for the second upstream task (worker_a can only hold one open task)
			await writeRoomMemberState(created.roomDir, createMemberState("worker_c"));

			// Two upstream tasks, assigned to separate workers
			const u1Seq = await sendOwnerTask(tempDir, runtimeRoot, "owner-session-multidep", {
				to: "worker_a",
				summary: "Upstream one",
			});
			const u2Seq = await sendOwnerTask(tempDir, runtimeRoot, "owner-session-multidep", {
				to: "worker_c",
				summary: "Upstream two",
			});
			await sendOwnerTask(tempDir, runtimeRoot, "owner-session-multidep", {
				to: "worker_b",
				summary: "Depends on both upstreams",
				content: `Needs {input:#${u1Seq}} and {input:#${u2Seq}}.`,
			});

			const board0 = await listBoardEntries(created.roomDir, 20);
			const u1 = board0.find((e) => e.seq === u1Seq);
			const u2 = board0.find((e) => e.seq === u2Seq);
			if (!u1 || !u2) throw new Error("upstream tasks not found");

			// First upstream fails — early blocked notification should fire
			await recordTerminalTaskState({
				roomDir: created.roomDir,
				upstreamSeq: u1.seq,
				taskMessageId: u1.id,
				status: "error",
				logContext: { source: "multidep-dedup-test" },
			});

			// Second upstream also fails — all deps resolved, notifyDependentsIfAllReady runs
			await recordTerminalTaskState({
				roomDir: created.roomDir,
				upstreamSeq: u2.seq,
				taskMessageId: u2.id,
				status: "error",
				logContext: { source: "multidep-dedup-test" },
			});

			// Wait a moment for async notifications to settle
			await new Promise((r) => setTimeout(r, 100));

			const systemMessages = (await listBoardEntries(created.roomDir, 50))
				.filter((e) => e.from === "system" && e.to === "worker_b");
			// Downstream must have received exactly one failure notification, not two
			expect(systemMessages).toHaveLength(1);
			expect(systemMessages[0]?.summary).toMatch(/^Dependency (failed|cancelled)/);
		});
	});

	it("multi-dep failure dedup survives dependency cache reload between the early and later paths", async () => {
		await withTempDir(async (tempDir) => {
			const { created, runtimeRoot } = await createRoomWithWorkers(tempDir, "owner-session-multidep-reload");
			setOwnerActiveRoomContext(created, "owner-session-multidep-reload");
			await writeRoomMemberState(created.roomDir, createMemberState("worker_c"));

			const u1Seq = await sendOwnerTask(tempDir, runtimeRoot, "owner-session-multidep-reload", {
				to: "worker_a",
				summary: "Upstream reload one",
			});
			const u2Seq = await sendOwnerTask(tempDir, runtimeRoot, "owner-session-multidep-reload", {
				to: "worker_c",
				summary: "Upstream reload two",
			});
			await sendOwnerTask(tempDir, runtimeRoot, "owner-session-multidep-reload", {
				to: "worker_b",
				summary: "Depends on both after reload",
				content: `Needs {input:#${u1Seq}} and {input:#${u2Seq}}.`,
			});

			const board = await listBoardEntries(created.roomDir, 20);
			const u1 = board.find((entry) => entry.seq === u1Seq);
			const u2 = board.find((entry) => entry.seq === u2Seq);
			if (!u1 || !u2) throw new Error("expected upstream tasks on board");

			await appendTerminalTaskReplyAndNotify({
				roomDir: created.roomDir,
				upstreamSeq: u1.seq,
				taskMessageId: u1.id,
				from: "worker_a",
				to: "owner",
				kind: "error",
				summary: "Upstream reload one failed",
				logContext: { source: "multidep-reload-dedup-test" },
			});

			clearRoomDeps(created.roomDir);

			await appendTerminalTaskReplyAndNotify({
				roomDir: created.roomDir,
				upstreamSeq: u2.seq,
				taskMessageId: u2.id,
				from: "worker_c",
				to: "owner",
				kind: "error",
				summary: "Upstream reload two failed",
				logContext: { source: "multidep-reload-dedup-test" },
			});

			const systemMessages = (await listBoardEntries(created.roomDir, 50))
				.filter((entry) => entry.from === "system" && entry.to === "worker_b");
			expect(systemMessages).toHaveLength(1);
			expect(systemMessages[0]?.summary).toMatch(/^Dependency failed/);
		});
	});

	it("dep-ready notification does not transition a non-idle member (e.g. error) to running", async () => {
		await withTempDir(async (tempDir) => {
			const { created, runtimeRoot } = await createRoomWithWorkers(tempDir, "owner-session-depready-nonidle");
			setOwnerActiveRoomContext(created, "owner-session-depready-nonidle");
			const memberContext = setMemberActiveRoomContext(created, "worker_b-session", "worker_b");

			const upstreamSeq = await sendOwnerTask(tempDir, runtimeRoot, "owner-session-depready-nonidle", {
				to: "worker_a",
				summary: "Upstream for non-idle test",
			});
			// Assign downstream task to worker_b with a dep
			const downstreamSeq = await sendOwnerTask(tempDir, runtimeRoot, "owner-session-depready-nonidle", {
				to: "worker_b",
				summary: "Downstream — dep on non-idle member",
				content: `Depends on {input:#${upstreamSeq}}.`,
			});
			await processUnreadMessages({ sendMessage() { return undefined; } } as ExtensionAPI, memberContext);

			// Deliver dep-ready notification while the member is still idle/waiting.
			const downstreamMsg = (await listBoardEntries(created.roomDir, 20)).find((e) => e.seq === downstreamSeq);
			if (!downstreamMsg) throw new Error("downstream task not found");
			await appendMessage(created.roomDir, {
				from: "system",
				to: "worker_b",
				replyTo: null,
				kind: "info",
				summary: `All dependencies ready for task #${downstreamSeq}`,
				content: `All dependencies for task #${downstreamSeq} have completed.`,
				broadcast: false,
			});

			// Flip the member into a non-idle lifecycle state before it processes
			// the queued dep-ready control message.
			const workerBState = await loadRoomMemberState(created.roomDir, "worker_b");
			await writeRoomMemberState(created.roomDir, {
				...workerBState,
				state: "error",
				currentTaskMessageId: downstreamMsg.id,
			});

			// Member polls — must NOT transition error→running
			await processUnreadMessages({ sendMessage() { return undefined; } } as ExtensionAPI, memberContext);

			const stateAfterPoll = await loadRoomMemberState(created.roomDir, "worker_b");
			expect(stateAfterPoll.state).toBe("error");
			expect(stateAfterPoll.state).not.toBe("running");
		});
	});

	it("gates new tasks on unclosed task ownership, not raw running state", async () => {
		await withTempDir(async (tempDir) => {
			const { created } = await createRoomWithWorkers(tempDir);
			const runningButFree = createMemberState("worker_running", {
				state: "running",
				sessionId: "worker-running-session",
			});
			await writeRoomMemberState(created.roomDir, runningButFree);

			const first = await appendMessage(created.roomDir, {
				from: "owner",
				to: "worker_running",
				broadcast: false,
				replyTo: null,
				kind: "task",
				summary: "Adopt a task while already running",
			});
			expect(first.summary).toBe("Adopt a task while already running");

			await expect(() => appendMessage(created.roomDir, {
				from: "owner",
				to: "worker_running",
				broadcast: false,
				replyTo: null,
				kind: "task",
				summary: "Second task should be blocked",
			})).rejects.toThrow(/already has an unclosed task/i);
		});
	});

	it("normalizes a task-free running member to waiting before dep-ready start, then emits Starting once", async () => {
		await withTempDir(async (tempDir) => {
			const { created, runtimeRoot } = await createRoomWithWorkers(tempDir, "owner-session-running-gap");
			setOwnerActiveRoomContext(created, "owner-session-running-gap");

			const runningButFree = createMemberState("worker_running", {
				state: "running",
				sessionId: "worker-running-gap-session",
			});
			await writeRoomMemberState(created.roomDir, runningButFree);
			const memberContext = setMemberActiveRoomContext(created, "worker-running-gap-session", "worker_running");

			const upstreamSeq = await sendOwnerTask(tempDir, runtimeRoot, "owner-session-running-gap", {
				to: "worker_a",
				summary: "Prepare prerequisite",
			});
			const upstream = (await listBoardEntries(created.roomDir, 20)).find((entry) => entry.seq === upstreamSeq);
			if (!upstream) throw new Error("expected upstream task on board");

			const downstreamSeq = await sendOwnerTask(tempDir, runtimeRoot, "owner-session-running-gap", {
				to: "worker_running",
				summary: "Resume only after dependency",
				content: `Wait for {input:#${upstream.seq}} before starting.`,
			});

			const stateBeforePoll = await loadRoomMemberState(created.roomDir, "worker_running");
			expect(stateBeforePoll.state).toBe("idle");
			expect(await runCrewTasks(tempDir, runtimeRoot, "owner-session-running-gap", { status: "waiting_deps" }))
				.toContain("Resume only after dependency");

			await processUnreadMessages({ sendMessage() { return undefined; } } as ExtensionAPI, memberContext);

			const stateAfterAssignment = await loadRoomMemberState(created.roomDir, "worker_running");
			expect(stateAfterAssignment.state).toBe("idle");
			expect((await listBoardEntries(created.roomDir, 20)).some(
				(entry) => entry.summary === "Starting: Resume only after dependency",
			)).toBe(false);

			await recordTerminalTaskState({
				roomDir: created.roomDir,
				upstreamSeq: upstream.seq,
				taskMessageId: upstream.id,
				status: "completed",
				logContext: { source: "state-derivation-running-gap-test" },
			});

			await waitFor(async () => {
				const board = await listBoardEntries(created.roomDir, 20);
				return board.some((entry) => entry.from === "system"
					&& entry.to === "worker_running"
					&& entry.summary === `All dependencies ready for task #${downstreamSeq}`);
			});

			await processUnreadMessages({ sendMessage() { return undefined; } } as ExtensionAPI, memberContext);

			const stateAfterReady = await loadRoomMemberState(created.roomDir, "worker_running");
			expect(stateAfterReady.state).toBe("running");
			await waitFor(async () => {
				const board = await listBoardEntries(created.roomDir, 20);
				return board.filter((entry) => entry.summary === "Starting: Resume only after dependency").length === 1;
			});
		});
	});

		it("keeps claimed manual members held and queues caller-directed task/info/question traffic without waking runtime", async () => {
			await withTempDir(async (tempDir) => {
				const { created } = await createRoomWithWorkers(tempDir, "owner-session-held-member");
				await createReplayableClaimedMember(created, {
					memberName: "held_worker",
					activation: "manual",
					requestId: "req-held-member",
					taskId: "spawn-held-member",
					holdExpiresAt: "2026-05-26T00:01:00.000Z",
				});
				const memberContext = setMemberActiveRoomContext(
					created,
					"held_worker-session",
					"held_worker",
				);
				const pi = {
					sendMessage: vi.fn(),
				} as unknown as ExtensionAPI;

				const heldTask = await appendMessage(created.roomDir, {
					from: "owner",
					to: "held_worker",
					broadcast: false,
					replyTo: null,
					kind: "task",
					summary: "Stay held for now",
				});
				const heldInfo = await appendMessage(created.roomDir, {
					from: "owner",
					to: "held_worker",
					broadcast: false,
					replyTo: null,
					kind: "info",
					summary: "Extra context while held",
				});
				const heldQuestion = await appendMessage(created.roomDir, {
					from: "owner",
					to: "held_worker",
					broadcast: false,
					replyTo: null,
					kind: "question",
					summary: "Question that must wait",
				});

				await processUnreadMessages(pi, memberContext);

				await expect(loadRoomMemberState(created.roomDir, "held_worker")).resolves.toMatchObject({
					state: "idle",
					currentTask: null,
					currentTaskMessageId: null,
					lastSeenSeq: heldQuestion.seq,
					queuedDeliveryMessageIds: [heldTask.id, heldInfo.id, heldQuestion.id],
				});
				expect(pi.sendMessage).not.toHaveBeenCalled();

				const members = await runCrewWho(created.roomDir, tempDir);
				expect(members.find((member) => member.name === "held_worker")).toMatchObject({
					state: "idle",
				});
			});
		});

		it("releases queued caller-directed traffic once delivery becomes enabled", async () => {
			await withTempDir(async (tempDir) => {
				vi.stubEnv("PI_ROOM_DELIVERY_DEBOUNCE_MS", "1");
				const { created } = await createRoomWithWorkers(tempDir, "owner-session-held-release");
				const { member, job } = await createReplayableClaimedMember(created, {
					memberName: "held_worker",
					activation: "manual",
					requestId: "req-held-release",
					taskId: "spawn-held-release",
					holdExpiresAt: "2026-05-26T00:01:00.000Z",
				});
				const memberContext = setMemberActiveRoomContext(
					created,
					"held_worker-session",
					"held_worker",
				);
				const pi = {
					sendMessage: vi.fn(),
				} as unknown as ExtensionAPI;

				const queuedTask = await appendMessage(created.roomDir, {
					from: "owner",
					to: "held_worker",
					broadcast: false,
					replyTo: null,
					kind: "task",
					summary: "Run after release",
				});
				await appendMessage(created.roomDir, {
					from: "owner",
					to: "held_worker",
					broadcast: false,
					replyTo: null,
					kind: "info",
					summary: "Queued context",
				});
				await processUnreadMessages(pi, memberContext);
				expect(pi.sendMessage).not.toHaveBeenCalled();

				await persistCrewAddReplayEvent({
					roomDir: created.roomDir,
					requestId: "req-held-release",
					event: buildCrewLifecycleEvent({
						event: "enabled",
						phase: "delivery",
						request_id: "req-held-release",
						command_id: null,
						requested_name: "held_worker",
						member_target: "held_worker",
						member_type: "worker",
						room_id: created.metadata.roomId,
						spawn_task_id: job.taskId,
						runtime_id: member.runtimeId,
						activation: "manual",
						metadata: { source: "state-derivation" },
						delivery_state: "enabled",
						hold_expires_at: null,
						error: null,
						reason: null,
					}),
					member,
					job,
				});

				await processUnreadMessages(pi, memberContext);
				await waitFor(() => pi.sendMessage.mock.calls.length > 0);

				await expect(loadRoomMemberState(created.roomDir, "held_worker")).resolves.toMatchObject({
					state: "running",
					currentTask: "Run after release",
					currentTaskMessageId: queuedTask.id,
					queuedDeliveryMessageIds: null,
				});
				expect(pi.sendMessage).toHaveBeenCalledTimes(1);
			});
		});

		it("delivers queued caller-directed traffic exactly once when delivery opens before the first held poll", async () => {
			await withTempDir(async (tempDir) => {
				vi.stubEnv("PI_ROOM_DELIVERY_DEBOUNCE_MS", "1");
				const { created } = await createRoomWithWorkers(tempDir, "owner-session-held-open-first");
				const { member, job } = await createReplayableClaimedMember(created, {
					memberName: "held_worker",
					activation: "manual",
					requestId: "req-held-open-first",
					taskId: "spawn-held-open-first",
					holdExpiresAt: "2026-05-26T00:01:00.000Z",
				});
				const memberContext = setMemberActiveRoomContext(
					created,
					"held_worker-session",
					"held_worker",
				);
				const pi = {
					sendMessage: vi.fn(),
				} as unknown as ExtensionAPI;

				const queuedTask = await appendMessage(created.roomDir, {
					from: "owner",
					to: "held_worker",
					broadcast: false,
					replyTo: null,
					kind: "task",
					summary: "Open only once",
				});

				await persistCrewAddReplayEvent({
					roomDir: created.roomDir,
					requestId: "req-held-open-first",
					event: buildCrewLifecycleEvent({
						event: "enabled",
						phase: "delivery",
						request_id: "req-held-open-first",
						command_id: null,
						requested_name: "held_worker",
						member_target: "held_worker",
						member_type: "worker",
						room_id: created.metadata.roomId,
						spawn_task_id: job.taskId,
						runtime_id: member.runtimeId,
						activation: "manual",
						metadata: { source: "state-derivation" },
						delivery_state: "enabled",
						hold_expires_at: null,
						error: null,
						reason: null,
					}),
					member,
					job,
				});

				await processUnreadMessages(pi, memberContext);
				await waitFor(() => pi.sendMessage.mock.calls.length > 0);

				await expect(loadRoomMemberState(created.roomDir, "held_worker")).resolves.toMatchObject({
					state: "running",
					currentTask: "Open only once",
					currentTaskMessageId: queuedTask.id,
					lastSeenSeq: queuedTask.seq,
					queuedDeliveryMessageIds: null,
				});
				expect(pi.sendMessage).toHaveBeenCalledTimes(1);
				expect(pi.sendMessage.mock.calls[0]?.[0]).toMatchObject({
					customType: "mail",
					content: expect.stringContaining("Open only once"),
				});
			});
		});

		it("removes queued held delivery ids when a queued info message is later cancelled", async () => {
			await withTempDir(async (tempDir) => {
				const { created } = await createRoomWithWorkers(tempDir, "owner-session-held-cancel");
				await createReplayableClaimedMember(created, {
					memberName: "held_worker",
					activation: "manual",
					requestId: "req-held-cancel",
					taskId: "spawn-held-cancel",
					holdExpiresAt: "2026-05-26T00:01:00.000Z",
				});
				const memberContext = setMemberActiveRoomContext(
					created,
					"held_worker-session",
					"held_worker",
				);
				const pi = {
					sendMessage: vi.fn(),
				} as unknown as ExtensionAPI;

				const heldInfo = await appendMessage(created.roomDir, {
					from: "owner",
					to: "held_worker",
					broadcast: false,
					replyTo: null,
					kind: "info",
					summary: "Held context to cancel",
				});
				await processUnreadMessages(pi, memberContext);

				const cancelled = await appendMessage(created.roomDir, {
					from: "system",
					to: "held_worker",
					broadcast: false,
					replyTo: heldInfo.id,
					kind: "cancelled",
					summary: "Cancelling held context",
				});
				await processUnreadMessages(pi, memberContext);

				await expect(loadRoomMemberState(created.roomDir, "held_worker")).resolves.toMatchObject({
					queuedDeliveryMessageIds: null,
					lastSeenSeq: cancelled.seq,
				});
			});
		});

		it("applies a same-poll cancellation after releasing a previously queued task", async () => {
			await withTempDir(async (tempDir) => {
				vi.stubEnv("PI_ROOM_DELIVERY_DEBOUNCE_MS", "1");
				const { created } = await createRoomWithWorkers(tempDir, "owner-session-held-release-cancel");
				const { member, job } = await createReplayableClaimedMember(created, {
					memberName: "held_worker",
					activation: "manual",
					requestId: "req-held-release-cancel",
					taskId: "spawn-held-release-cancel",
					holdExpiresAt: "2026-05-26T00:01:00.000Z",
				});
				const memberContext = setMemberActiveRoomContext(
					created,
					"held_worker-session",
					"held_worker",
				);
				const pi = {
					sendMessage: vi.fn(),
				} as unknown as ExtensionAPI;

				const queuedTask = await appendMessage(created.roomDir, {
					from: "owner",
					to: "held_worker",
					broadcast: false,
					replyTo: null,
					kind: "task",
					summary: "Release then cancel",
				});
				await persistCrewAddReplayEvent({
					roomDir: created.roomDir,
					requestId: "req-held-release-cancel",
					event: buildCrewLifecycleEvent({
						event: "enabled",
						phase: "delivery",
						request_id: "req-held-release-cancel",
						command_id: null,
						requested_name: "held_worker",
						member_target: "held_worker",
						member_type: "worker",
						room_id: created.metadata.roomId,
						spawn_task_id: job.taskId,
						runtime_id: member.runtimeId,
						activation: "manual",
						metadata: { source: "state-derivation" },
						delivery_state: "enabled",
						hold_expires_at: null,
						error: null,
						reason: null,
					}),
					member,
					job,
				});
				const cancelled = await appendMessage(created.roomDir, {
					from: "system",
					to: "held_worker",
					broadcast: false,
					replyTo: queuedTask.id,
					kind: "cancelled",
					summary: "Cancelled immediately after release",
				});

				await processUnreadMessages(pi, memberContext);
				await waitFor(() => pi.sendMessage.mock.calls.length > 0);

				await expect(loadRoomMemberState(created.roomDir, "held_worker")).resolves.toMatchObject({
					state: "idle",
					currentTask: null,
					currentTaskMessageId: null,
					queuedDeliveryMessageIds: null,
					lastSeenSeq: cancelled.seq,
				});
			});
		});
	});
