/**
 * Wait Tool — Pause Agent Turn for Async Events
 *
 * When the agent needs to wait for asynchronous messages (Monitor output,
 * bash background task results, room messages from other agents), it calls
 * this tool. Returns terminate:true to skip the follow-up LLM call,
 * forcibly ending the current agent turn.
 *
 * When async events arrive later (via sendMessage with triggerTurn:true),
 * they automatically kick off a new agent run — effectively "waking" the
 * agent to process the new information.
 *
 * **Reminder:** Uses a fixed 10 minute reminder window. If the expected events
 * still have not arrived by then, a reminder message wakes the agent and
 * suggests proactively checking the current status.
 *
 * Usage:
 *   Place in ~/.pi/agent/extensions/ and /reload, or use pi -e ./wait.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000);
	return `${minutes}m${seconds}s`;
}

export default function (pi: ExtensionAPI) {
	const activeTimers = new Map<string, ReturnType<typeof setTimeout>>();
	let runtimeActive = true;

	function log(msg: string) {
		// const ts = new Date().toISOString();
		// const count = activeTimers.size;
		// console.error(`[wait-debug ${ts}] (timers=${count}) ${msg}`);
	}

	function isStaleExtensionContextError(error: unknown): boolean {
		return error instanceof Error &&
			error.message.includes("This extension ctx is stale after session replacement or reload");
	}

	function clearAllTimers() {
		log(`clearAllTimers called`);
		for (const timerId of activeTimers.values()) clearTimeout(timerId);
		activeTimers.clear();
	}

	// Public hooks we can rely on:
	//   turn_start     — any new LLM turn after wait has yielded control
	//   agent_start    — keep as an early cancellation path for prompt-driven runs
	pi.on("agent_start", () => { log("★ agent_start"); clearAllTimers(); });
	pi.on("turn_start", () => { log("★ turn_start"); clearAllTimers(); });
	pi.on("session_shutdown", (event) => {
		runtimeActive = false;
		log(`★ session_shutdown reason=${event.reason}`);
		clearAllTimers();
	});

	pi.registerTool({
		name: "wait",
		label: "Wait",
		description:
			"Use when you need to wait for asynchronous messages to arrive " +
			"before continuing, such as Monitor output, or mails from other agents. ",
		parameters: Type.Object({
			reason: Type.String({
				description:
					"What the agent is waiting for, e.g. " +
					"'等待后台任务运行结果' or 'waiting for monitor output'",
			}),
		}),
		async execute(_toolCallId, params) {
			const reminderMs = DEFAULT_TIMEOUT_MS;

			const waitId = `wait-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			log(`creating timer id=${waitId} reminderMs=${reminderMs}`);
			const timerId = setTimeout(() => {
				log(`timer FIRED id=${waitId} — sending wait-reminder message`);
				activeTimers.delete(waitId);

				if (!runtimeActive) {
					log(`timer SKIPPED id=${waitId} — runtime inactive`);
					return;
				}

				try {
					pi.sendMessage(
						{
							customType: "wait-reminder",
							content:
								`⏰ 已等待 ${formatDuration(reminderMs)}："${params.reason}"。\n` +
								`建议主动查询当前情况，确认相关任务、监控或外部事件是否仍在推进。`,
							display: true,
							details: { reason: params.reason },
						},
						{ triggerTurn: true },
					);
				} catch (error) {
					if (isStaleExtensionContextError(error)) {
						log(`timer SKIPPED id=${waitId} — stale extension ctx`);
						return;
					}
					throw error;
				}
			}, reminderMs);

			activeTimers.set(waitId, timerId);

			const reminderNote = ` (10-minute reminder enabled)`;

			return {
				content: [{ type: "text", text: `⏳ Waiting for: ${params.reason}${reminderNote}` }],
				details: { waitingFor: params.reason },
				terminate: true,
			};
		},
	});
}
