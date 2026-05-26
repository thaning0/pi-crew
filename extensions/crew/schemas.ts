import {
	CREW_BATCH_TEMPLATE_PARAMETER_DESCRIPTION,
} from "./batch-templates.ts";

/** Combined schema for room tool validation (reserved for future use). */
export const RoomToolSchema = {
	type: "object",
	properties: {
		create: { type: "boolean" },
		spawn: {
			type: "object",
			properties: {
				name: { type: "string" },
				type: { type: "string" },
				model: { type: "string" },
				task: { type: "string" },
			},
			required: ["name", "type"],
			additionalProperties: false,
		},
		send: {
			type: "object",
			properties: {
				to: { anyOf: [{ const: "room" }, { type: "string" }] },
				summary: { type: "string" },
				content: { type: "string" },
				broadcast: { type: "boolean" },
				replyTo: { type: "string" },
				kind: { enum: ["task", "info", "question", "completion", "error"] },
			},
			required: ["summary"],
			additionalProperties: false,
		},
		board: { type: "boolean" },
		limit: { type: "number" },
		message: {
			type: "object",
			properties: {
				id: { type: "string" },
			},
			required: ["id"],
			additionalProperties: false,
		},
		members: { type: "boolean" },
		stop: {
			type: "object",
			properties: {
				name: { type: "string" },
			},
			required: ["name"],
			additionalProperties: false,
		},
		remove: {
			type: "object",
			properties: {
				name: { type: "string" },
			},
			required: ["name"],
			additionalProperties: false,
		},
	},
	additionalProperties: false,
};

export const CrewAddSchema = {
	type: "object",
	properties: {
		name: { type: "string", description: "Requested agent alias. Must start with letter/number, only [a-z0-9_-] allowed. The room stores a unique internal id automatically." },
		type: { type: "string", description: "Registered agent type from crew_roles list." },
		model: { type: "string", description: "Optional model override." },
		task: { type: "string", description: "Optional initial task to assign immediately on spawn." },
		transient: { type: "boolean", description: "Optional. If true with task, spawn blocks until agent is ready, skips 'Agent ready' notification, and auto-removes the agent after task completion/error. Requires task to be set." },
	},
	required: ["name", "type"],
	additionalProperties: false,
};

const CrewBatchParticipantSchema = {
	type: "object",
	properties: {
		name: { type: "string" },
		type: { type: "string" },
		model: { type: "string" },
	},
	required: ["name", "type"],
	additionalProperties: false,
};

const CrewBatchWorkerSchema = {
	type: "object",
	properties: {
		name: { type: "string" },
		type: { type: "string" },
		task: { type: "string" },
		model: { type: "string" },
	},
	required: ["name", "type"],
	additionalProperties: false,
};

export const CrewBatchSchema = {
	type: "object",
	oneOf: [
		{
			type: "object",
			properties: {
				template: {
					const: "parallel-work-aggregate",
					type: "string",
					description: CREW_BATCH_TEMPLATE_PARAMETER_DESCRIPTION,
				},
				params: {
					type: "object",
					description: "Template-specific parameters.",
					properties: {
						workers: {
							type: "array",
							items: CrewBatchWorkerSchema,
							minItems: 1,
						},
					},
					required: ["workers"],
					additionalProperties: false,
				},
			},
			required: ["template", "params"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: {
				template: {
					const: "plan-review-loop",
					type: "string",
					description: CREW_BATCH_TEMPLATE_PARAMETER_DESCRIPTION,
				},
				params: {
					type: "object",
					description: "Template-specific parameters.",
					properties: {
						author: CrewBatchParticipantSchema,
						reviewers: {
							type: "array",
							items: CrewBatchParticipantSchema,
							minItems: 1,
						},
						initialAuthorTask: { type: "string" },
						maxRounds: { type: "number" },
					},
					required: ["author", "reviewers", "initialAuthorTask"],
					additionalProperties: false,
				},
			},
			required: ["template", "params"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: {
				template: {
					const: "implement-review-loop",
					type: "string",
					description: CREW_BATCH_TEMPLATE_PARAMETER_DESCRIPTION,
				},
				params: {
					type: "object",
					description: "Template-specific parameters.",
					properties: {
						author: CrewBatchParticipantSchema,
						reviewers: {
							type: "array",
							items: CrewBatchParticipantSchema,
							minItems: 1,
						},
						initialAuthorTask: { type: "string" },
						maxRounds: { type: "number" },
					},
					required: ["author", "reviewers", "initialAuthorTask"],
					additionalProperties: false,
				},
			},
			required: ["template", "params"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: {
				template: {
					const: "review-fix-loop",
					type: "string",
					description: CREW_BATCH_TEMPLATE_PARAMETER_DESCRIPTION,
				},
				params: {
					type: "object",
					description: "Template-specific parameters.",
					properties: {
						reviewer: CrewBatchParticipantSchema,
						fixer: CrewBatchParticipantSchema,
						initialReviewTask: { type: "string" },
						maxRounds: { type: "number" },
					},
					required: ["reviewer", "fixer", "initialReviewTask"],
					additionalProperties: false,
				},
			},
			required: ["template", "params"],
			additionalProperties: false,
		},
	],
};

export const CrewStopSchema = {
	type: "object",
	properties: {
		name: { type: "string", description: "Member target to stop. Accepts alias, internal id, or alias#suffix label." },
	},
	required: ["name"],
	additionalProperties: false,
};

export const CrewRemoveSchema = {
	type: "object",
	properties: {
		name: { type: "string", description: "Member target to permanently remove. Accepts alias, internal id, or alias#suffix label." },
	},
	required: ["name"],
	additionalProperties: false,
};

export const CrewRolesSchema = {
	type: "object",
	properties: {},
	additionalProperties: false,
};

export const CrewTellSchema = {
	type: "object",
	properties: {
		to: { anyOf: [{ const: "room" }, { type: "string" }], description: "Target recipient. Use 'room' for board broadcast, or an alias, internal id, or alias#suffix label for direct message." },
		summary: { type: "string", description: "One-line message summary displayed on the board." },
		content: { type: "string", description: "Full message body with details." },
		broadcast: { type: "boolean", description: "Notify all active members (owner only)." },
		replyTo: { type: "string", description: "Message ID to reply to." },
		kind: { enum: ["task", "info", "question", "completion", "error"], description: "Message kind. 'task' assigns work, 'info' shares context, 'question' asks for help, 'completion'/'error' close tasks." },
	},
	required: ["summary"],
	additionalProperties: false,
};

export const CrewMessagesSchema = {
	type: "object",
	properties: {
		limit: { type: "number", description: "Max messages to show (default 20)." },
		before: { type: "number", description: "Only show messages before this sequence number." },
		filter: { enum: ["all", "me", "task", "completion", "error", "info", "question", "cancelled", "progress"], description: "Filter messages by kind or 'me' for messages relevant to you." },
	},
	additionalProperties: false,
};

export const CrewReplySchema = {
	type: "object",
	properties: {
		seq: { type: "number", description: "Sequence number of the task message to reply to." },
		summary: { type: "string", description: "One-line result displayed on the board. Include @agent-name to hand off." },
		content: { type: "string", description: "Full report body with details, findings, files changed, etc." },
		kind: { enum: ["completion", "error"], description: "'completion' for success, 'error' for failure." },
	},
	required: ["seq", "summary"],
	additionalProperties: false,
};

export const CrewReadSchema = {
	type: "object",
	properties: {
		seq: { type: "number", description: "Sequence number of the message to read." },
		offset: { type: "number", description: "1-indexed line number to start reading from (default: 1)." },
		limit: { type: "number", description: "Maximum lines of content to return (default: 50). Set to 0 for no limit." },
		tail: { type: "boolean", description: "If true, return the last N lines of content instead of the first N (requires limit; ignores offset)." },
	},
	required: ["seq"],
	additionalProperties: false,
};

export const CrewWhoSchema = {
	type: "object",
	properties: {},
	additionalProperties: false,
};

export const CrewTasksSchema = {
	type: "object",
	properties: {
		limit: { type: "number", description: "Max tasks to show (default 20)." },
		before: { type: "number", description: "Only show tasks before this sequence number." },
		status: { enum: ["assigned", "waiting_deps", "blocked_failed", "running", "completed", "error", "cancelled", "agentLost"], description: "Filter tasks by status." },
	},
	additionalProperties: false,
};

export const CrewMergeSchema = {
	type: "object",
	properties: {
		name: { type: "string", description: "Agent target whose worktree to merge. Accepts alias, internal id, or alias#suffix label." },
		strategy: { enum: ["merge", "rebase", "ff-only"], default: "merge", description: "Merge strategy (default: merge)." },
		deleteBranchAfterMerge: { type: "boolean", default: false, description: "Delete the worktree branch after successful merge (default: false). Only set to true when you are sure the member will not continue working on the same worktree branch." },
		commitMessage: { type: "string", description: "Optional custom commit message for the merge." },
	},
	required: ["name"],
	additionalProperties: false,
};
