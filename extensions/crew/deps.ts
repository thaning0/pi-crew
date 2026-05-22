/**
 * deps.ts — Dependency management for task flow ({input:#N} placeholders).
 *
 * All dependency state and logic lives here as module-level singletons.
 * Designed to run in the Owner process only: registerDeps and
 * notifyDependentsIfAllReady must execute in the process that owns
 * the MutationProxyServer (the room owner). Member agents communicate
 * via the proxy's notify_deps mutation command.
 *
 * State overview:
 *   depIndex        — upstream seq → set of downstream seqs (who depends on whom)
 *   taskStates      — seq → { status, to, content } (incremental, no disk IO)
 *   notifiedReadyTasks — dedup set to avoid duplicate "deps ready" messages
 *   closedTaskIds   — message ID dedup to prevent double-closure from same process
 *
 * Cold-start recovery: on first access to a room after process restart,
 * taskStates and depIndex are rebuilt by scanning existing disk messages
 * once (ensureRoomLoaded). After that, all operations are pure in-memory.
 *
 * Extracted from tools.ts (2026-05-04) to fix the process-isolation bug
 * where member agents had empty depIndex → dependency notifications
 * silently skipped.
 */

import type { RoomMessage } from "./types.ts";
import { listBoardEntries, appendMessage } from "./storage.ts";
import { consoleError } from "./logger.ts";

// ── Module-level state (owned by the Owner process) ────────────────────────

/** Dependency graph: roomDir → upstreamSeq → Set of downstream task seqs. */
const depIndex = new Map<string, Map<number, Set<number>>>();

/** Task state table: roomDir → seq → immutable task info + mutable status.
 *  Updated incrementally — registerDeps on creation, setTaskState on closure.
 *  Eliminates full-message-scan in allDepsReady and notifyDependentsIfAllReady. */
const taskStates = new Map<
	string,
	Map<number, { status: "running" | "completed" | "error" | "cancelled"; to: string; content: string | undefined }>
>();

/** Rooms that have been loaded from disk (cold-start recovery). */
const loadedRooms = new Set<string>();

/** Dedup set for "All dependencies ready" notifications. */
const notifiedReadyTasks = new Set<string>();

/** Dedup set for "upstream terminal failure" notifications.
 *  Keys: `${roomDir}|${downstreamSeq}` — ensures a downstream task
 *  only receives one failure notification even if multiple upstreams fail. */
const notifiedBlockedTasks = new Set<string>();

/** Closed task message IDs (roomDir → Set<messageId>).
 *  Process-local fast dedup; cross-process dedup is handled by the
 *  mutation-lock in appendMessage. */
const closedTaskIds = new Map<string, Set<string>>();

async function hasExistingDependencyNotification(
	roomDir: string,
	to: string,
	summary: string,
): Promise<boolean> {
	const messages = await listBoardEntries(roomDir, Number.MAX_SAFE_INTEGER);
	return messages.some((message) => {
		return message.from === "system"
			&& message.to === to
			&& message.kind === "info"
			&& message.summary === summary;
	});
}

// ── Cold-start recovery ────────────────────────────────────────────────────

/**
 * Rebuild taskStates and depIndex for a room from disk messages.
 * Called automatically on first access after process restart.
 * One-time O(N) cost per room per process lifetime; after this,
 * all dependency operations are pure in-memory O(1).
 */
async function ensureRoomLoaded(roomDir: string): Promise<void> {
	if (loadedRooms.has(roomDir)) return;

	const messages = await listBoardEntries(roomDir, Number.MAX_SAFE_INTEGER);

	// Ensure maps exist even for empty rooms (avoids repeated rebuild attempts)
	if (!taskStates.has(roomDir)) taskStates.set(roomDir, new Map());
	if (!depIndex.has(roomDir)) depIndex.set(roomDir, new Map());
	loadedRooms.add(roomDir);

	const room = taskStates.get(roomDir)!;
	const deps = depIndex.get(roomDir)!;

	// Build a map of task message ID → completion/error/cancelled reply kind
	const replyKinds = new Map<string, "completed" | "error" | "cancelled">();
	for (const m of messages) {
		if (
			m.replyTo &&
			(m.kind === "completion" || m.kind === "error" || m.kind === "cancelled")
		) {
			replyKinds.set(m.replyTo, m.kind === "completion" ? "completed" : m.kind);
		}
	}

	// Scan task messages: register state and deps
	for (const m of messages) {
		if (m.kind !== "task" || m.to === "room") continue;

		const reply = replyKinds.get(m.id);
		const status: "running" | "completed" | "error" | "cancelled" = reply
			? (reply as "completed" | "error" | "cancelled")
			: "running";

		room.set(m.seq, { status, to: m.to, content: m.content });

		// Rebuild depIndex from {input:#N} placeholders
		const inputDeps = extractInputDeps(m.content);
		for (const upstreamSeq of inputDeps) {
			if (!deps.has(upstreamSeq)) deps.set(upstreamSeq, new Set());
			deps.get(upstreamSeq)!.add(m.seq);
		}
	}
}

// ── Closed-task helpers ────────────────────────────────────────────────────

export function isTaskClosed(roomDir: string, messageId: string): boolean {
	const roomClosed = closedTaskIds.get(roomDir);
	return roomClosed?.has(messageId) ?? false;
}

export function markTaskClosed(roomDir: string, messageId: string): void {
	if (!closedTaskIds.has(roomDir)) closedTaskIds.set(roomDir, new Set());
	closedTaskIds.get(roomDir)!.add(messageId);
}

// ── Dependency extraction ──────────────────────────────────────────────────

export function extractInputDeps(content: string | undefined): number[] {
	if (!content) return [];
	const deps = new Set<number>();
	for (const m of content.matchAll(/\{input:#(\d+)\}/g)) {
		const seq = Number(m[1]);
		if (seq > 0) deps.add(seq);
	}
	return [...deps].sort((a, b) => a - b);
}

export function annotateMultiDepHint(
	summary: string,
	content: string | undefined,
): { summary: string; content?: string } {
	const deps = extractInputDeps(content);
	if (deps.length < 2) return { summary, content };
	const depList = deps.map((d) => `{input:#${d}}`).join(", ");
	const annotated = content
		? content +
			`\n\n---\nThis task depends on ${deps.length} upstream task(s) completing first.\nWait for all dependency-ready notifications (${depList}), then use crew_read to read each dependency's full content before starting.`
		: content;
	return { summary, content: annotated };
}

// ── Dependency registration ────────────────────────────────────────────────

/**
 * Register a task's {input:#N} dependencies in the depIndex AND record
 * its state in the taskStates table for O(1) lookup later.
 *
 * `to` is the target member name — needed by notifyDependentsIfAllReady
 * to know who to deliver the dependency-ready notification to.
 */
export function registerDeps(
	roomDir: string,
	taskSeq: number,
	content: string | undefined,
	to: string,
): void {
	// ── Store task state (always, even for tasks with no deps) ──
	if (!taskStates.has(roomDir)) taskStates.set(roomDir, new Map());
	taskStates.get(roomDir)!.set(taskSeq, { status: "running", to, content });

	// ── Populate depIndex ──
	const deps = extractInputDeps(content);
	if (deps.length === 0) return;
	if (!depIndex.has(roomDir)) depIndex.set(roomDir, new Map());
	const roomDeps = depIndex.get(roomDir)!;
	for (const upstreamSeq of deps) {
		if (!roomDeps.has(upstreamSeq)) roomDeps.set(upstreamSeq, new Set());
		roomDeps.get(upstreamSeq)!.add(taskSeq);
	}
}

/**
 * Update a task's status in the taskStates table.
 * Creates the entry if it doesn't exist (e.g. task was loaded from disk
 * during cold-start recovery but status has changed since).
 *
 * Called on crew_reply (completion / error / cancelled).
 *
 * For member processes this updates their local (empty) taskStates
 * harmlessly; the real update happens in the proxy's notify_deps
 * handler which runs in the Owner process.
 */
export function setTaskState(
	roomDir: string,
	seq: number,
	status: "completed" | "error" | "cancelled",
): void {
	if (!taskStates.has(roomDir)) taskStates.set(roomDir, new Map());
	const room = taskStates.get(roomDir)!;
	const existing = room.get(seq);
	if (existing) {
		existing.status = status;
	} else {
		// Create-or-update: task may not have been registered via registerDeps
		// (e.g. created before this process started, or has no deps).
		room.set(seq, { status, to: "unknown", content: undefined });
	}
}

/** Remove all dependency data for a room. Called by the watchdog on reap. */
export function clearRoomDeps(roomDir: string): void {
	depIndex.delete(roomDir);
	taskStates.delete(roomDir);
	loadedRooms.delete(roomDir);
	closedTaskIds.delete(roomDir);
	for (const key of notifiedReadyTasks) {
		if (key.startsWith(roomDir + "|")) notifiedReadyTasks.delete(key);
	}
	for (const key of notifiedBlockedTasks) {
		if (key.startsWith(roomDir + "|")) notifiedBlockedTasks.delete(key);
	}
}

// ── Dependency readiness check (lazy-loads from disk on first access) ──────

/**
 * Check whether all of a task's {input:#N} upstream dependencies are
 * satisfied, using the in-memory taskStates table.
 *
 * On first access to a room after process restart, rebuilds taskStates
 * and depIndex from disk messages (one-time O(N) scan). After that,
 * all checks are pure in-memory O(1).
 */
export async function allDepsReady(
	roomDir: string,
	taskContent: string | undefined,
): Promise<{ ready: boolean; pending: number[]; hasCancelled: boolean; hasError: boolean }> {
	const deps = extractInputDeps(taskContent);
	if (deps.length === 0) return { ready: true, pending: [], hasCancelled: false, hasError: false };

	// Cold-start: ensure room's taskStates are populated
	await ensureRoomLoaded(roomDir);

	const room = taskStates.get(roomDir);
	const pending: number[] = [];
	let hasCancelled = false;
	let hasError = false;

	for (const depSeq of deps) {
		const state = room?.get(depSeq);
		if (!state || state.status === "running") {
			pending.push(depSeq);
			continue;
		}
		if (state.status === "cancelled") hasCancelled = true;
		if (state.status === "error") hasError = true;
	}

	return { ready: pending.length === 0, pending, hasCancelled, hasError };
}

// ── Notification ───────────────────────────────────────────────────────────

/**
 * Notify downstream tasks when an upstream task completes.
 * MUST run in the Owner process where depIndex and taskStates are populated.
 *
 * On first access after restart, lazy-loads state from disk.
 * After that, uses only in-memory state.
 */
export async function notifyDependentsIfAllReady(
	roomDir: string,
	upstreamSeq: number,
): Promise<void> {
	// Cold-start: ensure room's depIndex and taskStates are populated
	await ensureRoomLoaded(roomDir);

	const roomDeps = depIndex.get(roomDir);
	if (!roomDeps) return;
	const downstreamSeqs = roomDeps.get(upstreamSeq);
	if (!downstreamSeqs || downstreamSeqs.size === 0) return;

	const room = taskStates.get(roomDir);

	for (const taskSeq of downstreamSeqs) {
		const task = room?.get(taskSeq);
		if (!task || !task.content || task.to === "room") continue;

		const { ready, hasCancelled, hasError } = await allDepsReady(roomDir, task.content);
		if (!ready) continue;

		const dedupKey = `${roomDir}|${taskSeq}`;
		if (notifiedReadyTasks.has(dedupKey)) continue;
		// Cross-path dedup: if an early blocked notification was already sent via
		// notifyBlockedDependentsOnTerminalFailure, skip this duplicate failure path.
		if ((hasCancelled || hasError) && notifiedBlockedTasks.has(dedupKey)) {
			notifiedReadyTasks.add(dedupKey);
			continue;
		}
		const summary = hasCancelled
			? `Dependency cancelled — some upstream tasks for #${taskSeq} were cancelled`
			: hasError
				? `Dependency failed — some upstream tasks for #${taskSeq} ended with error`
				: `All dependencies ready for task #${taskSeq}`;
		if (await hasExistingDependencyNotification(roomDir, task.to, summary)) {
			notifiedReadyTasks.add(dedupKey);
			continue;
		}
		notifiedReadyTasks.add(dedupKey);

		if (hasCancelled) {
			await appendMessage(roomDir, {
				from: "system",
				to: task.to,
				replyTo: null,
				kind: "info",
				summary,
				content: `Some upstream dependencies for task #${taskSeq} were cancelled.\nAsk @lead to re-publish the cancelled dependency tasks, or use crew_reply kind=error to end this task.`,
				broadcast: false,
			}).catch((err) => {
				consoleError("deps", "dep notification failed (cancelled)", {
					roomDir,
					upstreamSeq,
					taskSeq,
					error: String(err),
				});
			});
		} else if (hasError) {
			await appendMessage(roomDir, {
				from: "system",
				to: task.to,
				replyTo: null,
				kind: "info",
				summary,
				content: `Some upstream dependencies for task #${taskSeq} ended with error.\nUse crew_read to check each dependency's full content, or use crew_reply kind=error to end this task.`,
				broadcast: false,
			}).catch((err) => {
				consoleError("deps", "dep notification failed (error)", {
					roomDir,
					upstreamSeq,
					taskSeq,
					error: String(err),
				});
			});
		} else {
			await appendMessage(roomDir, {
				from: "system",
				to: task.to,
				replyTo: null,
				kind: "info",
				summary,
				content: `All dependencies for task #${taskSeq} have completed.\nUse crew_read to read the task context and start working.`,
				broadcast: false,
			}).catch((err) => {
				consoleError("deps", "dep notification failed (ready)", {
					roomDir,
					upstreamSeq,
					taskSeq,
					error: String(err),
				});
			});
		}
	}
}

/**
 * Check whether a newly created task already has all deps resolved,
 * and send an immediate notification if so.
 */
export async function checkAndNotifyIfReady(
	roomDir: string,
	_taskSeq: number,
	content: string | undefined,
): Promise<void> {
	const deps = extractInputDeps(content);
	if (deps.length === 0) return;
	const { ready } = await allDepsReady(roomDir, content);
	if (!ready) return;
	// notifyDependentsIfAllReady for any dep will check all downstream tasks.
	notifyDependentsIfAllReady(roomDir, deps[0]).catch((err) => {
		consoleError("deps", "dep check failed (checkAndNotify)", {
			roomDir,
			error: String(err),
		});
	});
}

// ── Terminal failure propagation ───────────────────────────────────────────

/**
 * Immediately notify all downstream tasks when an upstream enters a terminal
 * failure state (error or cancelled). Unlike notifyDependentsIfAllReady,
 * this does NOT wait for remaining dependencies to complete — it proactively
 * informs downstream agents that one of their dependencies has failed,
 * enabling crew_tasks to derive blocked_failed status without polling.
 *
 * Dedup: uses notifiedBlockedTasks to ensure a downstream task only receives
 * one failure notification even if multiple upstreams fail.
 */
export async function notifyBlockedDependentsOnTerminalFailure(
	roomDir: string,
	upstreamSeq: number,
	terminal: "error" | "cancelled",
): Promise<void> {
	// Cold-start: ensure room's depIndex and taskStates are populated
	await ensureRoomLoaded(roomDir);

	const roomDeps = depIndex.get(roomDir);
	if (!roomDeps) return;
	const downstreamSeqs = roomDeps.get(upstreamSeq);
	if (!downstreamSeqs || downstreamSeqs.size === 0) return;

	const room = taskStates.get(roomDir);

	for (const taskSeq of downstreamSeqs) {
		const task = room?.get(taskSeq);
		if (!task || task.to === "room") continue;

		// Skip downstream tasks that are already in a terminal state
		if (task.status !== "running") continue;

		// Only notify early if the downstream task still has pending
		// (running) dependencies. If all deps are already resolved
		// (including other failures/cancellations), notifyDependentsIfAllReady
		// will handle the notification.
		const allUpstreamResolved = task.content
			? (await allDepsReady(roomDir, task.content)).ready
			: true;
		if (allUpstreamResolved) continue;

		// Dedup: only send one failure notification per downstream task
		const dedupKey = `${roomDir}|${taskSeq}`;
		if (notifiedBlockedTasks.has(dedupKey)) continue;

		const summary =
			terminal === "cancelled"
				? `Dependency cancelled — some upstream tasks for #${taskSeq} were cancelled`
				: `Dependency failed — some upstream tasks for #${taskSeq} ended with error`;

		if (await hasExistingDependencyNotification(roomDir, task.to, summary)) {
			notifiedBlockedTasks.add(dedupKey);
			continue;
		}
		notifiedBlockedTasks.add(dedupKey);

		const content =
			terminal === "cancelled"
				? `Upstream task #${upstreamSeq} for task #${taskSeq} was cancelled.\nAsk @lead to re-publish the cancelled dependency task, or use crew_reply kind=error to end this task.`
				: `Upstream task #${upstreamSeq} for task #${taskSeq} ended with error.\nUse crew_read to check the dependency's full content, then decide whether to use crew_reply kind=error to end this task.`;

		await appendMessage(roomDir, {
			from: "system",
			to: task.to,
			replyTo: null,
			kind: "info",
			summary,
			content,
			broadcast: false,
		}).catch((err) => {
			consoleError("deps", "blocked notification failed", {
				roomDir,
				upstreamSeq,
				taskSeq,
				terminal,
				error: String(err),
			});
		});
	}
}
