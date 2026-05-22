# Crew Extension API Reference

## Extension Entry Point

### `roomExtension(pi, options?)`

```typescript
import roomExtension from "@mariozechner/pi-coding-agent/extensions/room";

export default function roomExtension(
  pi: ExtensionAPI,
  options?: RoomExtensionOptions,
): void
```

Registers the `crew` tools, hooks into session lifecycle events (`session_start`, `before_agent_start`, `turn_start`, `turn_end`, `session_shutdown`), and manages room/member lifecycle.

### `RoomExtensionOptions`

```typescript
interface RoomExtensionOptions {
  /** Override the filesystem root for room runtime data.
   *  Default: ~/.pi/agent/runtime/rooms */
  runtimeRoot?: string;

  /** Override one or both spawn adapters. If not provided, defaults are used:
   *  - pi: createPiMemberAdapter()
   *  - paseo: createPaseoPiMemberAdapter() */
  adapters?: Partial<Record<"pi" | "paseo", RoomSpawnAdapter>>;

  /** Name to use for the room lead in the message board.
   *  Default: "lead" (option key retained as ownerName for config compatibility) */
  ownerName?: string;

  /** Called synchronously before delivering a message to the agent.
   *  Use for custom validation, logging, or transformation. */
  beforeDeliverMessage?: (context: {
    roomDir: string;
    memberName: string;
    message: RoomMessage;
  }) => Promise<void> | void;

  /** Called before the owner heartbeat is written.
   *  Use for custom pre-heartbeat checks (e.g., verifying session validity). */
  beforeOwnerHeartbeatWrite?: (context: {
    roomDir: string;
    roomId: string;
    sessionId: string;
  }) => Promise<void> | void;

  /** Called during session_shutdown, before the room is marked "closing".
   *  Use for custom cleanup that must happen before room state transitions. */
  beforeOwnerShutdownMarkClosing?: (context: {
    roomDir: string;
    roomId: string;
    sessionId: string;
  }) => Promise<void> | void;
}
```

## Tools

### `crew` Member Management

**Name**: `crew_add` / `crew_stop` / `crew_remove` / `crew_merge` / `crew_roles`
**Description**: Manage crew members: add, stop, remove, merge snapshots, list roles. Lead room initialization happens in `before_agent_start`; lead-only actions fail fast until it is available.

**Schema**:

```typescript
// crew_add: add a new member
{
  name: string;     // Required. Must match /^[a-z0-9][a-z0-9_-]*$/i
  type: string;     // Required. Must match a known crew role (Markdown files in agents/)
  model?: string;   // Optional. Overrides agent definition model and current model
  task?: string;    // Optional. Initial task to assign (written to board, embedded in prompt)
}

// crew_stop: stop a member
{
  name: string;     // Required. Target to stop: alias, internal id, or alias#suffix label
}

// crew_remove: remove a member
{
  name: string;     // Required. Target to remove: alias, internal id, or alias#suffix label
}

// crew_merge: merge a member snapshot
{
  name: string;                    // Required. Alias, internal id, or alias#suffix label
  strategy?: "merge" | "rebase" | "ff-only";
  deleteBranchAfterMerge?: boolean; // Optional. Default: false
  commitMessage?: string;
}

// crew_roles: list available roles
boolean
```

**Semantics**:

| Tool | Permissions | Behavior |
|------|------------|----------|
| `crew_add` | Lead only | Creates a spawning member and a spawn job. The requested `name` is treated as a user alias; the room persists a unique internal member id such as `explorer_1234` and renders it as `explorer#1234` in user-facing output. Resolves the crew role to a system prompt + tools list. Selects the appropriate backend adapter (paseo preferred when available, pi as fallback). Writes the initial task to the message board before spawning so the member has a message seq to reply to. Member bootstraps itself via the `<!-- PI_ROOM_BOOTSTRAP ... -->` block in its system prompt. |
| `crew_stop` | Lead only | Resolves the target from alias, internal id, or alias#suffix label, then transitions that member to `stopping`. Cancels any pending spawn job. Calls adapter's `stop()` (or `remove()` if a spawn task is still pending). If the runtime is reusable (`stopKeepsRuntime: true`), transitions to `idle`. Otherwise transitions to `error`, clears the runtime/session, archives any remaining worktree changes into `worktreeResult`, clears `worktree`, and keeps the alias reserved until explicit `crew_remove`. Paseo RPC timeouts are treated as degraded stops (runtime likely cleaned up already). |
| `crew_remove` | Lead only | Resolves the target from alias, internal id, or alias#suffix label, then removes that member. Like `crew_stop` but calls adapter's `remove()` if available. If the member was running a task, that task is closed as `cancelled` before the member transitions to `removed`. Removes heartbeat file, archives cleanup fallback work into `worktreeResult`, and clears `worktree`. Removed archived members remain mergeable through `crew_merge`. |
| `crew_merge` | Lead only | Resolves an active member normally, or falls back to an archived removed member when no active target matches. Merges a fixed snapshot OID instead of a live branch tip. Snapshot priority is `pendingTerminalReply.snapshotOid` → `lastSnapshotOid` → archived `worktreeResult.snapshotOid`. Only stable members (`idle` or `error`, not `chatBusy`) are mergeable. On success, updates `lastMergedOid`. `deleteBranchAfterMerge` defaults to `false`. |
| `crew_roles` | Any | Lists available crew role names, their descriptions, and allowed tools. Reads from Markdown files in the `agents/` directory. |

**Lead restrictions**: The lead cannot stop or remove itself. Attempting to do so returns an error.

**Owner room lifecycle**: `session_start` only handles bootstrap/member setup. Owner room materialization moved to `before_agent_start`, where the extension uses the resolved system prompt to distinguish bootstrap members from owner sessions. New owner rooms also write the first system board entry there, so the room id is initialized before any tool uses the room. If neither `event.systemPrompt` nor `ctx.getSystemPrompt()` yields a usable prompt, the session fails closed: owner-only tools return an initialization error and do not recover an indexed owner room at tool time. Once a session has already completed owner classification, later owner recovery paths reuse the same owner-room helper instead of bypassing refresh or infrastructure setup.

**Owner room lookup**: owner sessions use an `ownerSessionId -> roomId` index under the runtime root. Lookups validate indexed hits, fall back to a one-time scan on invalid or stale hits, and repair the index deterministically by preferring `active + fresh heartbeat` rooms, then lexical `roomId` tie-breaks.

**Stale room cleanup**: once owner infrastructure is ready, the extension schedules a one-shot background stale-room reap. That scan explicitly skips the current owner `roomId` and `ownerSessionId`, and `reapRoom()` revalidates stale state again under the cleanup lock before deleting anything.

**Return values**: Each action returns a human-readable text result. Spawn returns the task ID. Stop/remove return confirmation. Types returns a formatted list.

### `crew` Communication

**Name**: `crew_tell` / `crew_reply` / `crew_messages` / `crew_read` / `crew_who` / `crew_tasks`
**Description**: Crew communication: tell, reply, messages, read, who, tasks.

**Schemas**:

```typescript
// crew_tell: send a message
{
  to?: string | "room";  // "room" for broadcast, or an alias/internal id/alias#suffix target. Default: "room"
  summary: string;        // Required. Message summary
  content?: string;       // Optional. Full message body
  broadcast?: boolean;    // If true, delivered to all members. Lead-only.
  replyTo?: string;       // Message ID being replied to
  kind?: "task" | "info" | "question" | "completion" | "error";  // Kind of message. Default: "info"
}

// crew_reply: reply to a message
{
  seq: number;            // Required. Message seq number to reply to
  summary: string;        // Required. One-line summary
  content?: string;       // Optional. Full report body
  kind?: "completion" | "error";  // Optional. Default: "completion"
}

// crew_messages: list messages
{
  limit?: number;         // Maximum entries to return (default: 20)
  before?: number;        // Only entries with seq < before
  filter?: "all" | "me" | "task" | "completion" | "error" | "info" | "question" | "cancelled";
}

// crew_read: read a message's full content
{
  seq: number;            // Required. Message seq to read full content
}

// crew_who: list room members
boolean

// crew_tasks: list tasks
{
  limit?: number;         // Maximum entries (default: 20)
  before?: number;        // Only tasks with seq < before
  status?: "assigned" | "waiting_deps" | "blocked_failed" | "running" | "completed" | "error" | "cancelled" | "agentLost";
}
```

**Semantics**:

| Tool | Description |
|------|-------------|
| `crew_tell` | Appends a message to the room board. **Task messages** directed to a specific member bind the task metadata (`currentTask`, `currentTaskMessageId`) but do not force the member into `running` state — the member transitions to `running` only when it actually starts executing a ready task (dependency-driven). **Broadcast** (`to: "room"`) is lead-only. `@mentions` in the summary are extracted and populated in `mentions[]` for targeted delivery; for directed tasks they remain metadata and do not add extra assignees. Mention parsing supports alias, internal id, and copy-pasteable labels such as `worker#1234`. Sender's own mentions are excluded. |
| `crew_reply` | Shorthand for replying to a specific message by seq. Resolves the original message, extracts `from` as the target, and calls `crew_tell` with `replyTo` set. Public `kind` remains `completion` or `error`; internal stop/watchdog paths may append `cancelled` or `error` terminal replies through the same closure helper. Terminal replies persist a fixed worktree snapshot first, then append the board reply, so lead-side mergeability matches the terminal reply the lead sees. Dependency state is updated so downstream tasks can receive `All dependencies ready`, `Dependency failed`, or `Dependency cancelled` notices, and upstream tasks that fail/cancel proactively notify downstream tasks via `blocked_failed` propagation. Returns the new message seq. |
| `crew_messages` | Returns a formatted board view with emoji indicators: 📋 task, ✅ completion, ❌ error, ❓ question, 🛑 cancelled, 💬 info. Supports filtering by kind, "me" (own messages), and cursor-based pagination via `before`. |
| `crew_read` | Reads the full content of a message by seq. Includes `Seq`, `From`, `To`, `Summary`, `ReplyTo`, `Mentions`, and the full content body. |
| `crew_who` | Returns a JSON array of non-removed members. `name` is the internal id, `displayName` is the user alias, and `label`/`target` are the copy-pasteable target token shown to users, such as `explorer#1234`. The payload also includes `type`, `state`, `currentTask`, `lastCompletedTask`, `lastError`, optional `lastActiveAt`, optional `progress`, `lastSnapshotAt`, `lastSnapshotSummary`, `lastMergedOid`, and derived `mergeReady`. `state` is a **derived display state**: `spawning`, `idle`, `assigned`, `waiting_deps`, `blocked_failed`, `chatting`, `running`, `stopping`, `error`, or `removed`. Members holding a task but not yet executing it show as `assigned`, `waiting_deps`, or `blocked_failed` instead of `running`. Members with `chatBusy: true` and no running task show as `chatting`. |
| `crew_tasks` | Returns a formatted list of tasks with status emojis: ⏳ assigned, ⏸️ waiting_deps, 🚫 blocked_failed, 🏃 running, ✅ completed, ❌ error, 🛑 cancelled, 💀 agentLost. Status is derived deterministically by checking, in priority order: (1) terminal reply existence (completion/error/cancelled), (2) member liveness — `agentLost` if the member is gone and no longer holds the task, (3) dependency state — `blocked_failed` if any upstream is already `error`/`cancelled`, otherwise `waiting_deps` while any dependency is still pending, (4) whether the member has started execution — `assigned` if raw state is still `idle`, and (5) default `running`. Supports filtering by any of the 8 status values. |

**Target resolution**: direct member tool parameters accept alias (`explorer`), internal id (`explorer_1234`), or display label (`explorer#1234`). Duplicate active aliases are rejected at spawn time; a non-removed member keeps its alias reserved until explicit `crew_remove`. `crew_merge` uses a merge-specific resolver: it still prefers active members, but it can fall back to archived removed members so cleanup snapshots remain mergeable.

**Dependency scope (Phase 1 / Phase 2)**: the authoritative dependency index currently covers **Phase 1 only** — owner-created directed tasks sent through `crew_tell` / `crew_reply`. Those tasks fully support `assigned`, `waiting_deps`, `blocked_failed`, dependency-ready notifications, and the delayed `Starting:` transition. **Phase 2** (member-originated dependent tasks) is not yet owner-registered automatically; if a member emits a new task containing `{input:#N}` directly, the dependency-derived states and notifications are not guaranteed until a dedicated owner/proxy registration path is added.

**Auto-mark as read**: When the poll cycle delivers messages to a member, `lastSeenSeq` is updated. Messages with `seq <= lastSeenSeq` are not re-delivered.

**Self-reply deduplication**: When a member sends a `completion` or `error` reply, a `pendingSelfAckMessageId` guard prevents the member from seeing its own reply as a new task on the next poll cycle.

**Board message format** (Emoji legend for `crew_messages` output):

```
#42 📋 from: owner to: worker-1 - 实现登录页
#43 ✅ from: worker-1 to: owner - 登录页已完成
#44 💬 from: reviewer to: worker-1 - 密码强度校验需要加强
```

<!-- Covered in the crew communication section above -->


## `RoomSpawnAdapter` Interface

Implement this interface to provide custom subagent backends:

```typescript
export interface RoomSpawnAdapter {
  /** Identifier for this backend: "pi" or "paseo" */
  kind: RoomBackend;

  /** Optional: check if this backend is available in the current environment.
   *  When the room has no UI: paseo is preferred if available, pi is the fallback.
   *  When the room has UI (interactive mode): pi is always used. */
  isAvailable?: (ctx: RoomExecutionContext) => Promise<boolean>;

  /** Spawn a new member agent. Receives full context including room dir,
   *  system prompt, model, thinking level, tools, and optional initial task. */
  spawn: (request: SpawnMemberRequest) => Promise<SpawnMemberResult>;

  /** If true, stop() leaves the runtime usable for future tasks.
   *  If false, stop() kills the runtime and the member remains in error
   *  until explicit remove or a new alias is chosen.
   *  paseo: true (agent persists on daemon)
   *  pi: false (child process is killed) */
  stopKeepsRuntime?: boolean;

  /** Stop a running member. Called during crew_stop() and liveness cleanup. */
  stop?: (member: RoomMemberState) => Promise<void>;

  /** Remove a member entirely. Called during crew_remove() and room reaping.
   *  Should clean up all resources associated with the runtime. */
  remove?: (member: RoomMemberState) => Promise<void>;

  /** Optional backend-specific liveness provider.
   *  `paseo` uses this to report daemon-authoritative liveness without doing RPC under the room mutation lock. */
  observeLiveness?: (member: RoomMemberState) => Promise<MemberLivenessObservation>;
}
```

### Implementor Guidance

- **`spawn()`** must return the backend runtime handle. For `pi`, the adapter still writes the child pid immediately. For `paseo`, `spawn()` must not write member state; owner finalization is the only path allowed to persist `runtimeId`.
- **`stop()`** should be idempotent — safe to call on an already-stopped runtime.
- **`remove()`** should fully clean up. After remove, the member's resources should be released.
- **`isAvailable()`** should be a fast, non-destructive probe. The extension calls it to decide which backend to use for a spawn.
- For `paseo`, `observeLiveness()` should return daemon-authoritative status. RPC timeout or transport failure must be reported as inconclusive rather than coerced to dead.
- The `SpawnMemberRequest.initialTask` field, when present, contains the task text and the board message seq the member should use for `crew_reply`.

## Public Exports

```typescript
// From index.ts:
export default function roomExtension(pi: ExtensionAPI, options?: RoomExtensionOptions): void;
export function resetActiveRoomsForTests(): void;

// From types.ts (all type-only exports):
export type RoomState;
export type RoomBackend;
export type RoomMemberLifecycleState;
export type RoomSpawnJobState;
export type RoomMessageKind;
export type RoomMetadata;
export type RoomMemberState;
export type RoomSpawnJob;
export type RoomMessage;
export type RoomBootstrap;
export type RoomExecutionContext;
export type RoomToolParams;  // (@internal, implementation-only)
export type SpawnMemberRequest;
export type SpawnMemberResult;
export type MemberLivenessObservation;
export type RoomSpawnAdapter;

// From spawn.ts (adapter factories):
export function createPiMemberAdapter(options?: { spawnProcess?: typeof spawn }): RoomSpawnAdapter;
export function createPaseoPiMemberAdapter(): RoomSpawnAdapter;
export function getPiInvocation(args: string[]): { command: string; args: string[] };

// From storage.ts (select utilities):
export function getDefaultRoomRuntimeRoot(): string;
export function isValidRoomMemberName(memberName: string): boolean;
export function withRoomMutationLock<T>(roomDir: string, fn: () => Promise<T>, options?: FileLockOptions): Promise<T>;
export function updateRoomMemberState(roomDir: string, memberName: string, patch: Partial<RoomMemberState>): Promise<RoomMemberState>;

// From watchdog.ts (liveness utilities):
export function getOwnerHeartbeatIntervalMs(): number;
export function getOwnerHeartbeatStaleMs(): number;
export function getMemberHeartbeatIntervalMs(): number;
export function getMemberHeartbeatStaleMs(): number;
export function getRoomSpawnJoinTimeoutMs(): number;
export function getRoomPaseoExternalCreateTimeoutMs(): number;
export function getRoomPaseoBootstrapClaimTimeoutMs(): number;

// From lock.ts:
export function withFileLock<T>(lockPath: string, roomId: string, fn: () => Promise<T>, options?: FileLockOptions): Promise<T>;
export function setFileLockTestHooksForTests(hooks: FileLockTestHooks | null): void;

// From errors.ts (error classes):
export class RoomError extends Error;
export class RoomNotFoundError extends RoomError;
export class MemberNotAvailableError extends RoomError;
export class MemberNotFoundError extends RoomError;
export class SpawnFailedError extends RoomError;
export class LockTimeoutError extends RoomError;
export class BootstrapTokenError extends RoomError;
export class RoomNotClaimableError extends RoomError;
export class ValidationError extends RoomError;
export class MemberAlreadyExistsError extends RoomError;
export class AgentProxyDisconnectedError extends RoomError;
```

## Owner-Authoritative Paseo Notes

- `RoomMemberState.runtimeIdentitySource` indicates whether the current runtime handle came from owner finalize, member pid metadata, or no authority yet.
- `RoomMemberState.bootstrapClaimedAt` records when bootstrap claim was observed for the current member generation.
- `paseo` spawn jobs may use `external_created`, `timed_out_pending_external_resolution`, and `timed_out_pending_member_claim`. `pi` intentionally remains on the old subset.

## Usage Example

### Basic Extension Consumer

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import roomExtension from "@mariozechner/pi-coding-agent/extensions/room";

export default function myExtension(pi: ExtensionAPI) {
  roomExtension(pi, {
    runtimeRoot: "/custom/path/to/rooms",
    ownerName: "orchestrator",
    beforeDeliverMessage: async ({ roomDir, memberName, message }) => {
      console.log(`Delivering message #${message.seq} to ${memberName}`);
    },
  });
}
```

### Custom Spawn Adapter

```typescript
import type { RoomSpawnAdapter, SpawnMemberRequest, SpawnMemberResult, RoomMemberState, RoomExecutionContext } from "@mariozechner/pi-coding-agent/extensions/room";

const myAdapter: RoomSpawnAdapter = {
  kind: "pi",

  async isAvailable(_ctx: RoomExecutionContext): Promise<boolean> {
    return true;
  },

  async spawn(request: SpawnMemberRequest): Promise<SpawnMemberResult> {
    // Launch your agent process here
    const runtimeId = "my-runtime-123";
    return { runtimeId, backend: "pi" };
  },

  stopKeepsRuntime: false,

  async stop(member: RoomMemberState): Promise<void> {
    // Stop the agent
  },

  async remove(member: RoomMemberState): Promise<void> {
    // Clean up all resources
  },
};

// Use it via adapters option
roomExtension(pi, {
  adapters: { pi: myAdapter },
});
```
