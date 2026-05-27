/**
 * task-status.ts — Shared task-status helpers
 *
 * Extracted from tools.ts so both deriveTaskStatus() and owner-side
 * event emission reuse the same idle-task classification logic.
 */

/**
 * Classify the status of an idle member that holds a task.
 *
 * Decision order (must match deriveTaskStatus steps 3-4):
 * 1. Upstream error or cancelled → blocked_failed
 * 2. Has unresolved deps → waiting_deps
 * 3. Otherwise → assigned
 */
export function classifyIdleTaskStatus(input: {
	hasDeps: boolean;
	depsReady: boolean;
	hasError: boolean;
	hasCancelled: boolean;
}): "assigned" | "waiting_deps" | "blocked_failed" {
	if (input.hasError || input.hasCancelled) return "blocked_failed";
	if (input.hasDeps && !input.depsReady) return "waiting_deps";
	return "assigned";
}

/** Map from classifyIdleTaskStatus result to the corresponding event name. */
export function idleStatusToEventName(
	status: "assigned" | "waiting_deps" | "blocked_failed",
): "task:assigned" | "task:waiting_deps" | "task:blocked_failed" {
	switch (status) {
		case "assigned": return "task:assigned";
		case "waiting_deps": return "task:waiting_deps";
		case "blocked_failed": return "task:blocked_failed";
	}
}
