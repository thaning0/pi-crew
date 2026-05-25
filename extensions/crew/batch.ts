import { randomUUID } from "node:crypto";
import { getActiveRoom, resolveAccessibleRoom, trackActiveRoomTask } from "./lifecycle.ts";
import { appendMessage, findIdleMemberByAlias, formatMemberLabel, listBoardEntries, loadRoomMemberState } from "./storage.ts";
import { ValidationError } from "./errors.ts";
import { createRoomLogger } from "./logger.ts";
import {
	type CrewBatchTemplateName,
	isKnownBatchTemplate,
} from "./batch-templates.ts";
import { isNonEmptyString, queueCrewAdd, queueCrewTell, textResult } from "./tools.ts";
import type {
	QueuedCrewAddResult,
	QueuedTaskHandle,
	RoomExecutionContext,
	RoomMemberState,
	RoomMessage,
	RoomSpawnAdapter,
} from "./types.ts";

type ExtensionAPI = Parameters<typeof resolveAccessibleRoom>[0];

type RoomExecCtx = RoomExecutionContext & Parameters<typeof resolveAccessibleRoom>[1] & {
	currentModel?: string;
	currentThinkingLevel?: import("@mariozechner/pi-agent-core").ThinkingLevel;
};

type CrewBatchContext = {
	id: string;
	silentOwnerDelivery: boolean;
};

type CrewBatchToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: true;
};

export type CrewBatchMemberHandle = {
	memberName: string;
	memberLabel: string;
};

export type MemberReadyWaitState =
	| "ready"
	| "failed"
	| "missing"
	| "timeout";

export type TaskTerminalWaitState =
	| "completion"
	| "error"
	| "cancelled"
	| "missing"
	| "timeout";

export type BatchLoopResultState = "max-rounds-exhausted";

export type BatchLoopResultOutcome = "final-rejected" | "no-terminal-verdict";

export type MemberReadyWaitResult = {
	handle: CrewBatchMemberHandle;
	state: MemberReadyWaitState;
	member?: RoomMemberState;
	detail?: string;
};

export type TaskTerminalWaitResult = {
	handle: QueuedTaskHandle;
	state: TaskTerminalWaitState;
	task?: RoomMessage | null;
	reply?: RoomMessage;
	detail?: string;
};

export type BatchLoopResult = {
	state: BatchLoopResultState;
	outcome: BatchLoopResultOutcome;
	round: number;
	maxRounds: number;
	detail: string;
};

type ParallelWorkAggregateWorker = {
	name: string;
	type: string;
	task?: string;
	model?: string;
};

type ParallelWorkAggregateParams = {
	workers: ParallelWorkAggregateWorker[];
};

type ParallelWorkAggregateWorkerResult = {
	worker: ParallelWorkAggregateWorker;
	queued?: QueuedCrewAddResult;
	queueError?: string;
	member?: MemberReadyWaitResult;
	task?: TaskTerminalWaitResult;
};

type ReviewLoopParticipant = {
	name: string;
	type: string;
	model?: string;
};

type ReviewLoopParams = {
	author: ReviewLoopParticipant;
	reviewers: ReviewLoopParticipant[];
	initialAuthorTask: string;
	maxRounds: number;
};

type ReviewLoopTemplateConfig = {
	template: Extract<CrewBatchTemplateName, "plan-review-loop" | "implement-review-loop">;
	authorSummaryLabel: string;
	reviewerSummaryLabel: string;
	revisionSummaryLabel: string;
};

type ReviewLoopParticipantResult = {
	role: "author" | "reviewer";
	participant: ReviewLoopParticipant;
	queued?: QueuedCrewAddResult;
	queueError?: string;
	ready?: MemberReadyWaitResult;
};

type ReviewLoopRoundResult = {
	round: number;
	authorTask: QueuedTaskHandle;
	authorReply: TaskTerminalWaitResult;
	reviewerTasks: QueuedTaskHandle[];
	reviewerReplies: TaskTerminalWaitResult[];
};

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTerminalReply(
	messages: ReadonlyArray<RoomMessage>,
	handle: QueuedTaskHandle,
): RoomMessage | undefined {
	return messages.find((message) =>
		message.replyTo === handle.messageId
		&& (message.kind === "completion" || message.kind === "error" || message.kind === "cancelled"),
	);
}

export async function waitForMembersReady(
	roomDir: string,
	handles: ReadonlyArray<CrewBatchMemberHandle>,
	options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<MemberReadyWaitResult[]> {
	const timeoutMs = options.timeoutMs;
	const pollIntervalMs = options.pollIntervalMs ?? 100;
	const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs;
	const resolved = new Map<string, MemberReadyWaitResult>();

	while ((deadline === null || Date.now() <= deadline) && resolved.size < handles.length) {
		for (const handle of handles) {
			if (resolved.has(handle.memberName)) {
				continue;
			}
			const member = await loadRoomMemberState(roomDir, handle.memberName).catch(() => null);
			if (!member) {
				continue;
			}
			if (member.state === "idle" || member.state === "running") {
				resolved.set(handle.memberName, {
					handle,
					state: "ready",
					member,
				});
				continue;
			}
			if (member.state === "error" || member.state === "removed") {
				resolved.set(handle.memberName, {
					handle,
					state: "failed",
					member,
					detail: member.lastError ?? `member entered ${member.state}`,
				});
			}
		}
		if (resolved.size < handles.length) {
			await delay(pollIntervalMs);
		}
	}

	return await Promise.all(handles.map(async (handle) => {
		const result = resolved.get(handle.memberName);
		if (result) {
			return result;
		}
		const member = await loadRoomMemberState(roomDir, handle.memberName).catch(() => null);
		if (!member) {
			return {
				handle,
				state: "missing" as const,
				detail: `member ${handle.memberLabel} was not found`,
			};
		}
		return {
			handle,
			state: "timeout" as const,
			member,
			detail: `member ${handle.memberLabel} did not become ready before timeout`,
		};
	}));
}

export async function waitForTaskTerminalReplies(
	roomDir: string,
	handles: ReadonlyArray<QueuedTaskHandle>,
	options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<TaskTerminalWaitResult[]> {
	const timeoutMs = options.timeoutMs;
	const pollIntervalMs = options.pollIntervalMs ?? 100;
	const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs;
	const resolved = new Map<string, TaskTerminalWaitResult>();

	while ((deadline === null || Date.now() <= deadline) && resolved.size < handles.length) {
		const messages = await listBoardEntries(roomDir, Number.MAX_SAFE_INTEGER);
		for (const handle of handles) {
			if (resolved.has(handle.messageId)) {
				continue;
			}
			const task = messages.find((message) => message.id === handle.messageId && message.seq === handle.seq) ?? null;
			const reply = getTerminalReply(messages, handle);
			if (!reply) {
				continue;
			}
			resolved.set(handle.messageId, {
				handle,
				state: reply.kind as Extract<RoomMessage["kind"], TaskTerminalWaitState>,
				task,
				reply,
			});
		}
		if (resolved.size < handles.length) {
			await delay(pollIntervalMs);
		}
	}

	const finalMessages = await listBoardEntries(roomDir, Number.MAX_SAFE_INTEGER);
	return handles.map((handle) => {
		const result = resolved.get(handle.messageId);
		if (result) {
			return result;
		}
		const task = finalMessages.find((message) => message.id === handle.messageId && message.seq === handle.seq) ?? null;
		const reply = getTerminalReply(finalMessages, handle);
		if (reply) {
			return {
				handle,
				state: reply.kind as Extract<RoomMessage["kind"], TaskTerminalWaitState>,
				task,
				reply,
			};
		}
		if (!task) {
			return {
				handle,
				state: "missing" as const,
				task: null,
				detail: `task handle ${handle.messageId}#${handle.seq} was not found`,
			};
		}
		return {
			handle,
			state: "timeout",
			task,
			detail: `task ${handle.messageId} did not receive a terminal reply before timeout`,
		};
	});
}

export function createMaxRoundsExhaustedResult(
	template: CrewBatchTemplateName,
	round: number,
	maxRounds: number,
	outcome: BatchLoopResultOutcome = "no-terminal-verdict",
): BatchLoopResult {
	const detail = outcome === "final-rejected"
		? `crew_batch template "${template}" exhausted ${maxRounds} rounds because final round ${round} was rejected`
		: `crew_batch template "${template}" exhausted ${maxRounds} rounds at round ${round}`;
	return {
		state: "max-rounds-exhausted",
		outcome,
		round,
		maxRounds,
		detail,
	};
}

function formatBatchText(template: CrewBatchTemplateName, lines: string[]): string {
	return [`crew_batch template: ${template}`, ...lines].join("\n");
}

function parseOptionalPositiveNumber(
	value: unknown,
	fieldName: string,
): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new ValidationError(`${fieldName} must be a positive number when provided.`);
	}
	return value;
}

function parseOptionalNonEmptyString(
	value: unknown,
	fieldName: string,
): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isNonEmptyString(value)) {
		throw new ValidationError(`${fieldName} must be a non-empty string when provided.`);
	}
	return value;
}

function parseParallelWorkAggregateParams(
	params: Record<string, unknown>,
): ParallelWorkAggregateParams {
	assertAllowedTemplateParamKeys("parallel-work-aggregate", params, ["workers"]);
	if (!Array.isArray(params.workers) || params.workers.length === 0) {
		throw new ValidationError("parallel-work-aggregate requires a non-empty workers array.");
	}
	const workers = params.workers.map((worker, index) => {
		if (!worker || typeof worker !== "object" || Array.isArray(worker)) {
			throw new ValidationError(`parallel-work-aggregate worker #${index + 1} must be an object.`);
		}
		const candidate = worker as Record<string, unknown>;
		if (!isNonEmptyString(candidate.name) || !isNonEmptyString(candidate.type)) {
			throw new ValidationError(`parallel-work-aggregate worker #${index + 1} requires non-empty name and type.`);
		}
		return {
			name: candidate.name,
			type: candidate.type,
			task: parseOptionalNonEmptyString(
				candidate.task,
				`parallel-work-aggregate worker #${index + 1} task`,
			),
			model: parseOptionalNonEmptyString(
				candidate.model,
				`parallel-work-aggregate worker #${index + 1} model`,
			),
		};
	});
	return {
		workers,
	};
}

function assertAllowedTemplateParamKeys(
	template: CrewBatchTemplateName,
	params: Record<string, unknown>,
	allowedKeys: readonly string[],
): void {
	const unexpectedKeys = Object.keys(params).filter((key) => !allowedKeys.includes(key));
	if (unexpectedKeys.length === 0) {
		return;
	}
	throw new ValidationError(
		`${template} does not accept ${unexpectedKeys.map((key) => `"${key}"`).join(", ")}.`,
	);
}

function parseReviewLoopParticipant(
	value: unknown,
	fieldName: string,
): ReviewLoopParticipant {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ValidationError(`${fieldName} must be an object.`);
	}
	const candidate = value as Record<string, unknown>;
	if (!isNonEmptyString(candidate.name) || !isNonEmptyString(candidate.type)) {
		throw new ValidationError(`${fieldName} requires non-empty name and type.`);
	}
	return {
		name: candidate.name,
		type: candidate.type,
		model: parseOptionalNonEmptyString(candidate.model, `${fieldName} model`),
	};
}

function parseReviewLoopParams(
	template: Extract<CrewBatchTemplateName, "plan-review-loop" | "implement-review-loop">,
	params: Record<string, unknown>,
): ReviewLoopParams {
	assertAllowedTemplateParamKeys(template, params, ["author", "reviewers", "initialAuthorTask", "maxRounds"]);
	const author = parseReviewLoopParticipant(params.author, `${template} author`);
	if (!Array.isArray(params.reviewers) || params.reviewers.length === 0) {
		throw new ValidationError(`${template} requires a non-empty reviewers array.`);
	}
	const reviewers = params.reviewers.map((reviewer, index) =>
		parseReviewLoopParticipant(reviewer, `${template} reviewer #${index + 1}`));
	if (!isNonEmptyString(params.initialAuthorTask)) {
		throw new ValidationError(`${template} requires a non-empty initialAuthorTask.`);
	}
	return {
		author,
		reviewers,
		initialAuthorTask: params.initialAuthorTask,
		maxRounds: parseOptionalPositiveNumber(params.maxRounds, `${template} maxRounds`) ?? 3,
	};
}

function summarizeMemberResult(result?: MemberReadyWaitResult): string {
	if (!result) {
		return "member=not-queued";
	}
	return result.detail
		? `member=${result.state} (${result.detail})`
		: `member=${result.state}`;
}

function summarizeTaskResult(result: ParallelWorkAggregateWorkerResult): string {
	if (result.queueError) {
		return `task=not-queued (${result.queueError})`;
	}
	if (result.queued?.initialTaskBoardError) {
		return `task=not-queued (${result.queued.initialTaskBoardError})`;
	}
	if (!result.queued?.initialTask) {
		return "task=not-requested";
	}
	if (!result.task) {
		return "task=missing";
	}
	const detail = result.task.reply?.summary ?? result.task.detail;
	return detail
		? `task=${result.task.state} (${detail})`
		: `task=${result.task.state}`;
}

function toTaskHandle(message: RoomMessage): QueuedTaskHandle {
	return {
		messageId: message.id,
		seq: message.seq,
		targetName: message.to === "room" ? "room" : message.to,
		batchId: message.batchId ?? null,
	};
}

function formatReplySummary(reply?: RoomMessage): string {
	if (!reply) {
		return "(no reply)";
	}
	const parts = [reply.summary, reply.content?.trim()].filter((value): value is string => Boolean(value));
	return parts.join(" — ");
}

type ReviewerVerdict = "pass" | "fail" | "invalid";

type ReviewOutcome = "execution-failure" | "needs-revision" | "pass" | "protocol-failure";

function parseReviewerVerdict(reply?: RoomMessage): ReviewerVerdict {
	const summary = reply?.summary ?? "";
	if (/^VERDICT:\s*PASS\b/.test(summary)) {
		return "pass";
	}
	if (/^VERDICT:\s*FAIL\b/.test(summary)) {
		return "fail";
	}
	return "invalid";
}

function summarizeReviewOutcome(result: TaskTerminalWaitResult): ReviewOutcome {
	if (result.state === "completion") {
		const verdict = parseReviewerVerdict(result.reply);
		if (verdict === "pass") {
			return "pass";
		}
		if (verdict === "fail") {
			return "needs-revision";
		}
		return "protocol-failure";
	}
	return "execution-failure";
}

function getReviewerVerdictProtocolFailureDetail(result: TaskTerminalWaitResult, round: number): string {
	const summary = result.reply?.summary ?? "(missing summary)";
	return `reviewer ${result.handle.targetName} ended round ${round} without a valid verdict and violated the verdict contract (expected summary to start with VERDICT: PASS or VERDICT: FAIL, got ${JSON.stringify(summary)})`;
}

function buildReviewerTaskContent(
	template: CrewBatchTemplateName,
	round: number,
	authorReply: TaskTerminalWaitResult,
	authorWorktreePath?: string | null,
): string {
	const base = [
		`Review round ${round} for ${template}.`,
		"Return an explicit verdict envelope with crew_reply(kind=\"completion\", ...).",
		"- Pass: crew_reply(kind=\"completion\", summary=\"VERDICT: PASS — <short reason>\", content=\"<full review notes>\")",
		"- Fail: crew_reply(kind=\"completion\", summary=\"VERDICT: FAIL — <short reason>\", content=\"<full review notes>\")",
		"Use error/cancelled only when the review could not be completed; error/cancelled means review execution failed, not rejection.",
		"A missing or malformed verdict is a protocol failure.",
		"",
		`Author output: ${formatReplySummary(authorReply.reply)}`,
	];

	if (authorWorktreePath) {
		base.push(
			"",
			`Author worktree: ${authorWorktreePath}`,
			"You can inspect the author's changes with:",
			`  ls ${authorWorktreePath}`,
			`  read ${authorWorktreePath}/path/to/changed/file.cs`,
			`  grep "pattern" ${authorWorktreePath}`,
		);
	}

	return base.join("\n");
}

function buildRevisionTaskContent(
	template: CrewBatchTemplateName,
	round: number,
	authorReply: TaskTerminalWaitResult,
	reviewerReplies: ReadonlyArray<TaskTerminalWaitResult>,
): string {
	const feedback = reviewerReplies.map((reply) =>
		`- ${reply.handle.targetName}: ${summarizeReviewOutcome(reply)} (${reply.reply ? formatReplySummary(reply.reply) : reply.detail ?? reply.state})`);
	return [
		`Revise the ${template} work for round ${round + 1}.`,
		"Address all reviewer feedback in one revision.",
		"",
		`Latest author output: ${formatReplySummary(authorReply.reply)}`,
		"Reviewer feedback:",
		...feedback,
	].join("\n");
}

function formatReadyLine(result: ReviewLoopParticipantResult): string {
	if (result.queueError) {
		return `${result.role}: queue-failed (${result.queueError})`;
	}
	if (!result.queued || !result.ready) {
		return `${result.role}: not-queued`;
	}
	const detail = result.ready.detail ? ` (${result.ready.detail})` : "";
	return `${result.role}: ${result.participant.name} -> ${result.ready.state}${detail}`;
}

function formatRoundLines(result: ReviewLoopRoundResult): string[] {
	const lines = [
		`round ${result.round} author: ${result.authorReply.state} (${result.authorReply.reply ? formatReplySummary(result.authorReply.reply) : result.authorReply.detail ?? result.authorReply.state})`,
	];
	for (const reviewerReply of result.reviewerReplies) {
		lines.push(
			`round ${result.round} reviewer ${reviewerReply.handle.targetName}: ${summarizeReviewOutcome(reviewerReply)} (${reviewerReply.reply ? formatReplySummary(reviewerReply.reply) : reviewerReply.detail ?? reviewerReply.state})`,
		);
	}
	return lines;
}

function renderReviewLoopResult(
	template: CrewBatchTemplateName,
	options: {
		status: "passed" | "ready-timeout" | "reply-timeout" | "review-execution-failed" | "max-rounds-exhausted" | "protocol-failed" | "setup-failed";
		maxRounds: number;
		finalRound: number;
		participants: ReadonlyArray<ReviewLoopParticipantResult>;
		rounds: ReadonlyArray<ReviewLoopRoundResult>;
		detail?: string;
	},
): { content: Array<{ type: "text"; text: string }>; isError?: true } {
	const lines = [
		`status: ${options.status}`,
		`rounds: ${options.finalRound}/${options.maxRounds}`,
		...options.participants.map(formatReadyLine),
		...options.rounds.flatMap(formatRoundLines),
	];
	if (options.detail) {
		lines.push(`detail: ${options.detail}`);
	}
	return textResult(
		formatBatchText(template, lines),
		options.status !== "passed",
	);
}

async function executeParallelWorkAggregate(
	params: Record<string, unknown>,
	activeRoom: Awaited<ReturnType<typeof resolveAccessibleRoom>>,
	ctx: RoomExecCtx,
	adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter },
	batchContext: CrewBatchContext,
): Promise<CrewBatchToolResult> {
	if (!activeRoom) {
		return textResult("No active room for this session.", true);
	}
	const parsed = parseParallelWorkAggregateParams(params);
	const results: ParallelWorkAggregateWorkerResult[] = [];

	for (const worker of parsed.workers) {
		try {
			// ── Try reuse first ──────────────────────────────
			const existingIdle = await findIdleMemberByAlias(activeRoom.roomDir, worker.name, worker.type);
			if (existingIdle && worker.task) {
				// Reuse: assign task to existing idle member via crew_tell
				const tellResult = await queueCrewTell(
					{
						to: existingIdle.name,
						kind: "task",
						summary: worker.task,
						content: worker.task,
					},
					{ activeRoom, batchContext },
				);
				results.push({
					worker,
					queued: {
						memberName: existingIdle.name,
						memberLabel: formatMemberLabel(existingIdle),
						backend: existingIdle.backend,
						taskId: existingIdle.spawnTaskId ?? "",
						transient: false,
						initialTask: {
							messageId: tellResult.message.id,
							seq: tellResult.message.seq,
							targetName: existingIdle.name,
							batchId: batchContext?.id ?? null,
						},
						initialTaskBoardError:
							tellResult.unresolvedMentions.length > 0
								? `skipped unresolved mentions: ${tellResult.unresolvedMentions.join(", ")}`
								: undefined,
						unresolvedMentions: tellResult.unresolvedMentions,
					},
				});
				continue;
			}
			if (existingIdle) {
				// Reuse without task assignment (member presence only)
				results.push({
					worker,
					queued: {
						memberName: existingIdle.name,
						memberLabel: formatMemberLabel(existingIdle),
						backend: existingIdle.backend,
						taskId: existingIdle.spawnTaskId ?? "",
						transient: false,
						initialTask: undefined,
						unresolvedMentions: [],
					},
				});
				continue;
			}

			// ── Fallback: spawn new agent ───────────────────
			const queued = await queueCrewAdd(worker, {
				activeRoom,
				sessionId: activeRoom.sessionId,
				ctx,
				adapters,
				batchContext,
			});
			results.push({ worker, queued });
		} catch (error) {
			results.push({
				worker,
				queueError: error instanceof Error ? error.message : String(error),
			});
		}
	}

	const memberResults = await waitForMembersReady(
		activeRoom.roomDir,
		results
			.filter((result): result is ParallelWorkAggregateWorkerResult & { queued: QueuedCrewAddResult } => Boolean(result.queued))
			.map((result) => ({
				memberName: result.queued.memberName,
				memberLabel: result.queued.memberLabel,
			})),
	);
	const membersByName = new Map(memberResults.map((result) => [result.handle.memberName, result] as const));

	const taskResults = await waitForTaskTerminalReplies(
		activeRoom.roomDir,
		results
			.flatMap((result) => result.queued?.initialTask ? [result.queued.initialTask] : []),
	);
	const tasksByMessageId = new Map(taskResults.map((result) => [result.handle.messageId, result] as const));

	const lines = results.map((result) => {
		const member = result.queued
			? membersByName.get(result.queued.memberName)
			: undefined;
		const task = result.queued?.initialTask
			? tasksByMessageId.get(result.queued.initialTask.messageId)
			: undefined;
		const enriched: ParallelWorkAggregateWorkerResult = {
			...result,
			member,
			task,
		};
		return `- ${result.worker.name}: ${summarizeMemberResult(member)}; ${summarizeTaskResult(enriched)}`;
	});

	return textResult(formatBatchText("parallel-work-aggregate", lines));
}

async function executeReviewLoop(
	config: ReviewLoopTemplateConfig,
	params: Record<string, unknown>,
	activeRoom: Awaited<ReturnType<typeof resolveAccessibleRoom>>,
	ctx: RoomExecCtx,
	adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter },
	batchContext: CrewBatchContext,
): Promise<CrewBatchToolResult> {
	if (!activeRoom) {
		return textResult("No active room for this session.", true);
	}
	const parsed = parseReviewLoopParams(config.template, params);
	const participants: ReviewLoopParticipantResult[] = [];

	for (const participant of [
		{ role: "author" as const, participant: parsed.author },
		...parsed.reviewers.map((reviewer) => ({ role: "reviewer" as const, participant: reviewer })),
	]) {
		try {
			// ── Try reuse first ──────────────────────────────
			const existingIdle = await findIdleMemberByAlias(
				activeRoom.roomDir,
				participant.participant.name,
				participant.participant.type,
			);
			if (existingIdle) {
				// Reuse: no task assigned yet (tasks are assigned via queueCrewTell in the round loop)
				participants.push({
					role: participant.role,
					participant: participant.participant,
					queued: {
						memberName: existingIdle.name,
						memberLabel: formatMemberLabel(existingIdle),
						backend: existingIdle.backend,
						taskId: existingIdle.spawnTaskId ?? "",
						transient: false,
						initialTask: undefined,
						unresolvedMentions: [],
					},
				});
				continue;
			}

			// ── Fallback: spawn new agent ───────────────────
			const queued = await queueCrewAdd(participant.participant, {
				activeRoom,
				sessionId: activeRoom.sessionId,
				ctx,
				adapters,
				batchContext,
			});
			participants.push({
				role: participant.role,
				participant: participant.participant,
				queued,
			});
		} catch (error) {
			participants.push({
				role: participant.role,
				participant: participant.participant,
				queueError: error instanceof Error ? error.message : String(error),
			});
			return renderReviewLoopResult(config.template, {
				status: "setup-failed",
				maxRounds: parsed.maxRounds,
				finalRound: 0,
				participants,
				rounds: [],
				detail: `${participant.role} ${participant.participant.name} could not be queued`,
			});
		}
	}

	const readyResults = await waitForMembersReady(
		activeRoom.roomDir,
		participants
			.filter((result): result is ReviewLoopParticipantResult & { queued: QueuedCrewAddResult } => Boolean(result.queued))
			.map((result) => ({
				memberName: result.queued.memberName,
				memberLabel: result.queued.memberLabel,
			})),
	);
	const readyByName = new Map(readyResults.map((result) => [result.handle.memberName, result] as const));
	for (const participant of participants) {
		if (participant.queued) {
			participant.ready = readyByName.get(participant.queued.memberName);
		}
	}

	const unreadyParticipant = participants.find((participant) => participant.ready?.state !== "ready");
	if (unreadyParticipant) {
		return renderReviewLoopResult(config.template, {
			status: "ready-timeout",
			maxRounds: parsed.maxRounds,
			finalRound: 0,
			participants,
			rounds: [],
			detail: `${unreadyParticipant.role} ${unreadyParticipant.participant.name} did not become ready`,
		});
	}

	const author = participants.find((participant) => participant.role === "author");
	if (!author?.queued) {
		return renderReviewLoopResult(config.template, {
			status: "setup-failed",
			maxRounds: parsed.maxRounds,
			finalRound: 0,
			participants,
			rounds: [],
			detail: "author handle was not created",
		});
	}

	const reviewers = participants.filter((participant): participant is ReviewLoopParticipantResult & { queued: QueuedCrewAddResult } =>
		participant.role === "reviewer" && Boolean(participant.queued));
	const rounds: ReviewLoopRoundResult[] = [];
	let nextAuthorContent = parsed.initialAuthorTask;

	for (let round = 1; round <= parsed.maxRounds; round += 1) {
		const authorQueuedTask = await queueCrewTell(
			{
				to: author.queued.memberName,
				kind: "task",
				summary: `${round === 1 ? config.authorSummaryLabel : config.revisionSummaryLabel} round ${round}`,
				content: nextAuthorContent,
			},
			{ activeRoom, batchContext },
		);
		const [authorReply] = await waitForTaskTerminalReplies(
			activeRoom.roomDir,
			[toTaskHandle(authorQueuedTask.message)],
		);
		const roundResult: ReviewLoopRoundResult = {
			round,
			authorTask: toTaskHandle(authorQueuedTask.message),
			authorReply,
			reviewerTasks: [],
			reviewerReplies: [],
		};
		rounds.push(roundResult);

		if (authorReply.state !== "completion") {
			return renderReviewLoopResult(config.template, {
				status: "reply-timeout",
				maxRounds: parsed.maxRounds,
				finalRound: round,
				participants,
				rounds,
				detail: `author round ${round} ended with ${authorReply.state}`,
			});
		}

		// Look up author worktree path for reviewer access
		let authorWorktreePath: string | null = null;
		try {
			const authorMember = await loadRoomMemberState(activeRoom.roomDir, author.queued.memberName);
			authorWorktreePath = authorMember.worktree?.path ?? null;
		} catch {
			// loadRoomMemberState may throw if member state file is missing; treat as no worktree
		}

		for (const reviewer of reviewers) {
			const reviewerQueuedTask = await queueCrewTell(
				{
					to: reviewer.queued.memberName,
					kind: "task",
					summary: `${config.reviewerSummaryLabel} round ${round}`,
					content: buildReviewerTaskContent(config.template, round, authorReply, authorWorktreePath),
				},
				{ activeRoom, batchContext },
			);
			roundResult.reviewerTasks.push(toTaskHandle(reviewerQueuedTask.message));
		}

		roundResult.reviewerReplies = await waitForTaskTerminalReplies(
			activeRoom.roomDir,
			roundResult.reviewerTasks,
		);

		const timedOutReviewer = roundResult.reviewerReplies.find((reply) =>
			reply.state === "timeout" || reply.state === "missing");
		if (timedOutReviewer) {
			return renderReviewLoopResult(config.template, {
				status: "reply-timeout",
				maxRounds: parsed.maxRounds,
				finalRound: round,
				participants,
				rounds,
				detail: `reviewer ${timedOutReviewer.handle.targetName} ended round ${round} with ${timedOutReviewer.state}`,
			});
		}

		const executionFailedReviewer = roundResult.reviewerReplies.find((reply) =>
			reply.state === "error" || reply.state === "cancelled");
		if (executionFailedReviewer) {
			return renderReviewLoopResult(config.template, {
				status: "review-execution-failed",
				maxRounds: parsed.maxRounds,
				finalRound: round,
				participants,
				rounds,
				detail: `reviewer ${executionFailedReviewer.handle.targetName} ended round ${round} with ${executionFailedReviewer.state}`,
			});
		}

		const invalidVerdictReviewer = roundResult.reviewerReplies.find((reply) =>
			reply.state === "completion" && parseReviewerVerdict(reply.reply) === "invalid");
		if (invalidVerdictReviewer) {
			return renderReviewLoopResult(config.template, {
				status: "protocol-failed",
				maxRounds: parsed.maxRounds,
				finalRound: round,
				participants,
				rounds,
				detail: getReviewerVerdictProtocolFailureDetail(invalidVerdictReviewer, round),
			});
		}

		if (roundResult.reviewerReplies.every((reply) =>
			reply.state === "completion" && parseReviewerVerdict(reply.reply) === "pass")) {
			return renderReviewLoopResult(config.template, {
				status: "passed",
				maxRounds: parsed.maxRounds,
				finalRound: round,
				participants,
				rounds,
			});
		}

		if (round === parsed.maxRounds) {
			const exhausted = createMaxRoundsExhaustedResult(
				config.template,
				round,
				parsed.maxRounds,
				"final-rejected",
			);
			return renderReviewLoopResult(config.template, {
				status: exhausted.state,
				maxRounds: parsed.maxRounds,
				finalRound: round,
				participants,
				rounds,
				detail: exhausted.detail,
			});
		}

		nextAuthorContent = buildRevisionTaskContent(
			config.template,
			round,
			authorReply,
			roundResult.reviewerReplies,
		);
	}

	return renderReviewLoopResult(config.template, {
		status: "max-rounds-exhausted",
		maxRounds: parsed.maxRounds,
		finalRound: parsed.maxRounds,
		participants,
		rounds,
		detail: `crew_batch template "${config.template}" exhausted rounds without a terminal verdict`,
	});
}

function parseCrewBatchParams(rawParams: unknown): {
	template: CrewBatchTemplateName;
	params: Record<string, unknown>;
} {
	const params = rawParams as { template?: unknown; params?: unknown };
	if (!isNonEmptyString(params?.template)) {
		throw new ValidationError("crew_batch requires a non-empty template.");
	}
	if (!isKnownBatchTemplate(params.template)) {
		throw new ValidationError(`Unknown crew_batch template: ${String(params.template)}`);
	}
	if (!params.params || typeof params.params !== "object" || Array.isArray(params.params)) {
		throw new ValidationError("crew_batch requires params to be an object.");
	}
	return {
		template: params.template,
		params: params.params as Record<string, unknown>,
	};
}

function getBatchResultText(result: CrewBatchToolResult): string {
	return result.content
		.filter((entry) => entry.type === "text")
		.map((entry) => entry.text)
		.join("\n\n");
}

function buildStartedBatchText(template: CrewBatchTemplateName): string {
	return `Started crew_batch template "${template}". Watch crew messages for updates.`;
}

async function appendBatchAggregateMessage(
	roomDir: string,
	batchContext: CrewBatchContext,
	message: {
		kind: Extract<RoomMessage["kind"], "info" | "completion" | "error">;
		summary: string;
		content?: string;
		replyTo?: string | null;
	},
): Promise<RoomMessage> {
	return await appendMessage(roomDir, {
		from: "system",
		to: "room",
		batchId: batchContext.id,
		broadcast: true,
		replyTo: message.replyTo ?? null,
		kind: message.kind,
		summary: message.summary,
		content: message.content,
	});
}

function canPublishBatchUpdate(sessionId: string, roomDir: string): boolean {
	const current = getActiveRoom(sessionId);
	return Boolean(
		current
		&& current.role === "owner"
		&& current.roomDir === roomDir
		&& !current.shuttingDown,
	);
}

async function runCrewBatchTemplate(
	template: CrewBatchTemplateName,
	params: Record<string, unknown>,
	activeRoom: NonNullable<Awaited<ReturnType<typeof resolveAccessibleRoom>>>,
	ctx: RoomExecCtx,
	adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter },
	batchContext: CrewBatchContext,
): Promise<CrewBatchToolResult> {
	switch (template) {
		case "parallel-work-aggregate":
			return await executeParallelWorkAggregate(params, activeRoom, ctx, adapters, batchContext);
		case "plan-review-loop":
			return await executeReviewLoop({
				template: "plan-review-loop",
				authorSummaryLabel: "Plan author task",
				reviewerSummaryLabel: "Plan review task",
				revisionSummaryLabel: "Plan revision",
			}, params, activeRoom, ctx, adapters, batchContext);
		case "implement-review-loop":
			return await executeReviewLoop({
				template: "implement-review-loop",
				authorSummaryLabel: "Implementation author task",
				reviewerSummaryLabel: "Implementation review task",
				revisionSummaryLabel: "Implementation revision",
			}, params, activeRoom, ctx, adapters, batchContext);
		default: {
			const exhaustive: never = template;
			throw new Error(`Unsupported crew_batch template: ${String(exhaustive)}`);
		}
	}
}

async function runCrewBatchInBackground(options: {
	template: CrewBatchTemplateName;
	params: Record<string, unknown>;
	activeRoom: NonNullable<Awaited<ReturnType<typeof resolveAccessibleRoom>>>;
	ctx: RoomExecCtx;
	adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter };
	batchContext: CrewBatchContext;
	startedMessageId: string;
}): Promise<void> {
	const result = await runCrewBatchTemplate(
		options.template,
		options.params,
		options.activeRoom,
		options.ctx,
		options.adapters,
		options.batchContext,
	).catch((error) => textResult(error instanceof Error ? error.message : String(error), true));
	if (!canPublishBatchUpdate(options.activeRoom.sessionId, options.activeRoom.roomDir)) {
		return;
	}
	try {
		await appendBatchAggregateMessage(options.activeRoom.roomDir, options.batchContext, {
			kind: result.isError ? "error" : "completion",
			summary: result.isError
				? `crew_batch template "${options.template}" failed`
				: `crew_batch template "${options.template}" completed`,
			content: getBatchResultText(result),
			replyTo: options.startedMessageId,
		});
	} catch (error) {
		logCrewBatchFinalAggregateFailure({
			roomDir: options.activeRoom.roomDir,
			template: options.template,
			batchId: options.batchContext.id,
			error,
		});
	}
}

function logCrewBatchBackgroundFailure(options: {
	roomDir: string;
	template: CrewBatchTemplateName;
	batchId: string;
	error: unknown;
}): void {
	createRoomLogger(options.roomDir, "room").error("crew_batch background task failed", {
		template: options.template,
		batchId: options.batchId,
		error: options.error instanceof Error ? String(options.error) : String(options.error),
	});
}

function logCrewBatchFinalAggregateFailure(options: {
	roomDir: string;
	template: CrewBatchTemplateName;
	batchId: string;
	error: unknown;
}): void {
	createRoomLogger(options.roomDir, "room").error("crew_batch final aggregate publishing failed", {
		template: options.template,
		batchId: options.batchId,
		error: options.error instanceof Error ? String(options.error) : String(options.error),
	});
}

export async function executeCrewBatch(
	rawParams: unknown,
	pi: ExtensionAPI,
	ctx: RoomExecCtx,
	runtimeRoot: string,
	adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter },
	options: {
		ownerName?: string;
		beforeDeliverMessage?: (context: {
			roomDir: string;
			memberName: string;
			message: RoomMessage;
		}) => Promise<void> | void;
		beforeOwnerHeartbeatWrite?: (context: {
			roomDir: string;
			roomId: string;
			sessionId: string;
		}) => Promise<void> | void;
	},
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
	try {
		const params = parseCrewBatchParams(rawParams);
		const activeRoom = await resolveAccessibleRoom(
			pi,
			ctx,
			runtimeRoot,
			adapters,
			options.ownerName,
			options.beforeDeliverMessage,
			options.beforeOwnerHeartbeatWrite,
		);
		if (!activeRoom) {
			return textResult("No active room for this session.", true);
		}
		if (activeRoom.role !== "owner") {
			return textResult("Only the lead may run crew_batch.", true);
		}
		const batchContext = {
			id: randomUUID(),
			silentOwnerDelivery: true,
		};
		const startedText = buildStartedBatchText(params.template);
		const startedMessage = await appendBatchAggregateMessage(activeRoom.roomDir, batchContext, {
			kind: "info",
			summary: startedText,
			content: startedText,
		});
		void trackActiveRoomTask(activeRoom.sessionId, runCrewBatchInBackground({
			template: params.template,
			params: params.params,
			activeRoom,
			ctx,
			adapters,
			batchContext,
			startedMessageId: startedMessage.id,
		})).catch((error) => {
			logCrewBatchBackgroundFailure({
				roomDir: activeRoom.roomDir,
				template: params.template,
				batchId: batchContext.id,
				error,
			});
		});
		return textResult(startedText);
	} catch (error) {
		if (error instanceof ValidationError) {
			return textResult(error.message, true);
		}
		return textResult(error instanceof Error ? error.message : String(error), true);
	}
}
