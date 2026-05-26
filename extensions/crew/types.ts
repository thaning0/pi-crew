export type RoomState = "creating" | "active" | "closing" | "orphaned" | "reaped";
export type RoomBackend = "pi" | "paseo";
export type CrewAddActivation = "immediate" | "manual";
export type RoomMemberLifecycleState = "spawning" | "idle" | "running" | "stopping" | "error" | "removed";
export type RoomSpawnJobState =
	| "starting"
	| "external_created"
	| "claimed"
	| "completed"
	| "timed_out_pending_external_resolution"
	| "timed_out_pending_member_claim"
	| "failed"
	| "cancelled";
export type CrewReplayLifecyclePhase = "request" | "spawn" | "delivery" | "activation";
export type CrewReplayLifecycleEventName =
	| "pending"
	| "claimed"
	| "held"
	| "enabled"
	| "ended"
	| "activated"
	| "aborted"
	| "rejected"
	| "spawned"
	| "failed";
export type CrewReplayDeliveryState = "pending" | "held" | "enabled" | "ended";
export type CrewControlVerb = "release" | "abort";
export type RoomMessageKind = "task" | "info" | "question" | "completion" | "error" | "cancelled" | "progress";
export type PendingTerminalReplyHandoffState = "snapshot_pending" | "snapshot_done" | "reply_appended" | "owner_handoff_done";

export interface PendingTerminalReplyState {
	taskSeq: number;
	kind: Extract<RoomMessageKind, "completion" | "error" | "cancelled">;
	snapshotOid?: string | null;
	replyMessageId?: string | null;
	handoffState: PendingTerminalReplyHandoffState;
}

export interface RoomMetadata {
	roomId: string;
	ownerName: string;
	ownerSessionId: string;
	ownerPid: number;
	cwd: string;
	createdAt: string;
	state: RoomState;
	nextSeq: number;
}

export interface RoomMemberState {
	name: string;
	displayName?: string | null;
	requestId?: string | null;
	type: string;
	backend: RoomBackend;
	runtimeId: string | null;
	state: RoomMemberLifecycleState;
	spawnTaskId: string | null;
	spawnBatchId?: string | null;
	transient?: boolean | null;
	currentTask: string | null;
	currentTaskMessageId?: string | null;
	chatBusy?: boolean | null;
	lastCompletedTask: string | null;
	lastError: string | null;
	lastSeenSeq: number;
	joinedAt: string;
	updatedAt: string;
	/** @deprecated Since heartbeat-refactor.
	 *  Liveness now uses independent heartbeats/{member}.json.
	 *  Retained as fallback when heartbeat file doesn't exist (transitional). */
	heartbeatAt?: string | null;
	/** Last user-visible activity timestamp (ISO 8601). Updated on spawn complete, message send, or reply. */
	lastActiveAt?: string | null;
	sessionId: string | null;
	bootstrapToken?: string | null;
	runtimeIdentitySource?: "none" | "owner" | "member-pid";
	bootstrapClaimedAt?: string | null;
	pendingSelfAckMessageId?: string | null;
	taskClosureSteeredMessageId?: string | null;
	todoProgress?: { done: number; total: number; lastText: string } | null;
	/** Active git worktree for isolated execution. */
	worktree?: { path: string; branch: string } | null;
	lastSnapshotOid?: string | null;
	lastSnapshotAt?: string | null;
	lastSnapshotSummary?: string | null;
	lastSnapshotTaskSeq?: number | null;
	lastMergedOid?: string | null;
	pendingTerminalReply?: PendingTerminalReplyState | null;
	queuedDeliveryMessageIds?: string[] | null;
	queuedTaskMessageIds?: string[] | null;
	/** Cleanup result from a completed worktree session. */
	worktreeResult?: { hasChanges: boolean; branch?: string; snapshotOid?: string | null } | null;
}

export interface RoomSpawnJob {
	taskId: string;
	memberName: string;
	requestId?: string | null;
	backend: RoomBackend;
	runtimeId?: string | null;
	bootstrapToken?: string | null;
	state: RoomSpawnJobState;
	createdAt: string;
	updatedAt: string;
	error: string | null;
}

export interface RoomMessage {
	seq: number;
	id: string;
	from: string;
	to: "room" | string;
	batchId?: string;
	silent?: boolean;
	mentions?: string[];
	broadcast: boolean;
	replyTo: string | null;
	kind: RoomMessageKind;
	summary: string;
	content?: string;
	createdAt: string;
}

export interface RoomBootstrap {
	version: 1;
	roomId: string;
	roomDir: string;
	memberName: string;
	memberType: string;
	ownerName: string;
	ownerSessionId: string;
	token: string;
	spawnTaskId?: string | null;
}

/** Environment variable names passed from owner to spawned member agents. */
export const ROOM_ENV = {
	ROOM_ID: "PI_ROOM_ID",
	ROOM_DIR: "PI_ROOM_DIR",
	MEMBER_NAME: "PI_ROOM_MEMBER_NAME",
	MEMBER_TYPE: "PI_ROOM_MEMBER_TYPE",
	BOOTSTRAP_TOKEN: "PI_ROOM_BOOTSTRAP_TOKEN",
	OWNER_NAME: "PI_ROOM_OWNER_NAME",
	OWNER_SESSION_ID: "PI_ROOM_OWNER_SESSION_ID",
} as const;

export interface RoomExecutionContext {
	cwd: string;
	hasUI: boolean;
	model?: string;
	sessionId?: string | null;
}

export interface RoomToolParams {
	create?: true;
	spawn?: { name: string; type: string; model?: string; task?: string };
	send?: {
		to?: "room" | string;
		summary: string;
		content?: string;
		broadcast?: boolean;
		replyTo?: string;
		kind?: RoomMessageKind;
	};
	board?: true;
	limit?: number;
	context?: { seq: number };
	members?: true;
	tasks?: {
		limit?: number;
		before?: number;
		status?: "assigned" | "waiting_deps" | "blocked_failed" | "running" | "completed" | "error" | "cancelled" | "agentLost";
	};
	stop?: { name: string };
	remove?: { name: string };
}

export interface SpawnMemberRequest {
	roomDir: string;
	roomId: string;
	memberName: string;
	memberLabel?: string;
	memberType: string;
	parentSessionId?: string;
	cwd: string;
	systemPrompt?: string;
	systemPromptPath?: string;
	extensionPath?: string;
	model?: string;
	tools?: string[];
	getInvocation?: (args: string[]) => { command: string; args: string[] };
	/** Initial task to embed in the first prompt, with board message seq for reply tracking. */
	initialTask?: { task: string; boardMessageSeq: number };
	/** Thinking level for the spawned member: off, minimal, low, medium, high, xhigh. */
	thinkingLevel?: import("@mariozechner/pi-agent-core").ThinkingLevel;
	/** Room bootstrap data for env var injection into the spawned process.
	 *  All fields (roomId, roomDir, memberName, token, etc.) are extracted
	 *  into PI_ROOM_* env vars by each adapter. */
	bootstrap?: RoomBootstrap;
	/** Owner's Paseo agent ID (from PASEO_AGENT_ID). Passed directly to the
	 *  Paseo adapter so sub-agents are linked to the parent in the UI. */
	parentPaseoAgentId?: string;
}

export interface QueuedTaskHandle {
	messageId: string;
	seq: number;
	targetName: string;
	batchId?: string | null;
}

export interface QueuedCrewTellResult {
	message: RoomMessage;
	unresolvedMentions: string[];
}

export interface QueuedCrewAddRequest {
	name: string;
	type: string;
	model?: string;
	task?: string;
	transient?: boolean;
	request_id?: string;
	activation?: CrewAddActivation;
	hold_timeout_ms?: number;
	metadata?: Record<string, unknown>;
}

export interface CrewAddReplaySeed {
	request_id: string;
	requested_name: string;
	type: string;
	model: string | null;
	task: string | null;
	transient: boolean;
	metadata?: Record<string, unknown> | null;
	activation: CrewAddActivation | null;
	hold_timeout_ms: number | null;
}

export interface CrewAddReplayableEvent {
	event_id: string;
	event: CrewReplayLifecycleEventName;
	phase: CrewReplayLifecyclePhase;
	request_id: string | null;
	command_id: string | null;
	requested_name: string | null;
	member_target: string | null;
	member_type: string | null;
	room_id: string | null;
	spawn_task_id: string | null;
	runtime_id: string | null;
	activation: CrewAddActivation | null;
	metadata: Record<string, unknown> | null;
	delivery_state: CrewReplayDeliveryState | null;
	hold_expires_at: string | null;
	error: string | null;
	reason: string | null;
}

export interface CrewAddReplayDeliveryGate {
	activation: CrewAddActivation;
	state: CrewReplayDeliveryState;
	hold_expires_at: string | null;
	opened_at: string | null;
	released_at: string | null;
	aborted_at: string | null;
	ended_at: string | null;
}

export interface CrewAddReplayLifecycleSnapshot {
	event_id: string | null;
	event: CrewReplayLifecycleEventName | null;
	phase: CrewReplayLifecyclePhase | null;
	request_id: string | null;
	command_id: string | null;
	requested_name: string | null;
	member_target: string | null;
	member_type: string | null;
	room_id: string | null;
	spawn_task_id: string | null;
	runtime_id: string | null;
	activation: CrewAddActivation | null;
	metadata: Record<string, unknown> | null;
	delivery_state: CrewReplayDeliveryState | null;
	hold_expires_at: string | null;
	delivery?: CrewAddReplayDeliveryGate | null;
	error: string | null;
	reason: string | null;
	member_state: RoomMemberLifecycleState | null;
	job_state: RoomSpawnJobState | null;
	updated_at: string;
}

export interface CrewAddReplayRecord {
	request_id: string;
	material: {
		requested_name: string;
		type: string;
		model: string | null;
		task: string | null;
		transient: boolean;
	};
	metadata: Record<string, unknown> | null;
	activation: CrewAddActivation | null;
	hold_timeout_ms: number | null;
	member_name: string;
	member_label: string;
	backend: RoomBackend;
	spawn_task_id: string;
	bootstrap_token?: string | null;
	replay: CrewAddReplayLifecycleSnapshot | null;
	created_at: string;
	updated_at: string;
}

export interface CrewControlReplayRecord {
	verb: CrewControlVerb;
	spawn_task_id: string;
	command_id: string;
	request_id: string | null;
	outcome: CrewAddReplayableEvent;
	created_at: string;
	updated_at: string;
}

export interface QueuedCrewAddResult {
	memberName: string;
	memberLabel: string;
	taskId: string;
	backend: RoomBackend;
	transient: boolean;
	replayed?: boolean;
	replayedLifecycleEvent?: CrewAddReplayableEvent | null;
	request_id?: string;
	activation?: CrewAddActivation;
	hold_timeout_ms?: number;
	metadata?: Record<string, unknown>;
	initialTask?: QueuedTaskHandle;
	initialTaskBoardError?: string;
	unresolvedMentions: string[];
}

export interface SpawnMemberResult {
	runtimeId: string;
	backend: RoomBackend;
	process?: unknown;
}

export interface MemberLivenessObservation {
	live: boolean;
	authoritative: boolean;
	source: "pi-pid" | "paseo-daemon" | "optimistic";
	detail?: string | null;
}

export interface RoomSpawnAdapter {
	kind: RoomBackend;
	isAvailable?: (ctx: RoomExecutionContext) => Promise<boolean>;
	spawn: (request: SpawnMemberRequest) => Promise<SpawnMemberResult>;
	stopKeepsRuntime?: boolean;
	stop?: (member: RoomMemberState) => Promise<void>;
	remove?: (member: RoomMemberState) => Promise<void>;
	observeLiveness?: (member: RoomMemberState) => Promise<MemberLivenessObservation>;
	/** Check whether this member's runtime is still alive.
	 *  Returns true if alive, false if dead/gone.
	 *  If not implemented, watchdog falls back to runtimeAlive=true
	 *  (pure optimism — heartbeat freshness is always a separate check). */
	checkLiveness?: (member: RoomMemberState) => Promise<boolean>;
}
