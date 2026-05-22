export type RoomState = "creating" | "active" | "closing" | "orphaned" | "reaped";
export type RoomBackend = "pi" | "paseo";
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
	/** Cleanup result from a completed worktree session. */
	worktreeResult?: { hasChanges: boolean; branch?: string; snapshotOid?: string | null } | null;
}

export interface RoomSpawnJob {
	taskId: string;
	memberName: string;
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

export interface QueuedCrewAddResult {
	memberName: string;
	memberLabel: string;
	taskId: string;
	backend: RoomBackend;
	transient: boolean;
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
