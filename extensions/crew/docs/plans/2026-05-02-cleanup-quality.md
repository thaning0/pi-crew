# Subagent Extension Quality Cleanup Plan

> **For Agent:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan.
> Each area is an independent task group that can run in parallel.

**Goal:** Bring the subagent extension to production quality by improving test coverage, maintainability, logging, error handling, and documentation.

**Architecture:** The extension (~1800 lines in index.ts) orchestrates multi-agent rooms with spawn/stop/remove lifecycle, message board, heartbeat-based liveness, and file-lock concurrency. Cleanup focuses on: splitting index.ts into focused modules, adding warn/debug log levels, creating typed error classes, filling test gaps, and writing architecture docs.

**Tech Stack:** TypeScript, Node.js, vitest (tests), file-system JSON storage, child_process spawn

---

## Area A: Logging Improvements (logger.ts)

### Task A1: Add warn and debug log levels

**Files:**
- Modify: `extensions/subagent/logger.ts`

**Step 1: Add warn and debug methods to RoomLogger**

Current logger has only `info` and `error`. Add:
- `warn(message, data?)` — always logged (like error), indicates non-fatal issues
- `debug(message, data?)` — logged only when `PI_ROOM_LOG_LEVEL=debug`

**Step 2: Update existing console.warn calls to use logger**

Files using `console.warn` directly:
- `dispatch.ts:applyOutgoingMessageState` — stale replyTo warning
- Replace with `createRoomLogger(null, "dispatch").warn(...)`

**Step 3: Run tests to verify no regressions**

```bash
cd /home/thn/.pi/agent/extensions/subagent && npx vitest run --reporter=verbose 2>&1 | tail -30
```

---

## Area B: Error Handling (all files)

### Task B1: Create typed error classes

**Files:**
- Create: `extensions/subagent/errors.ts`

Define error hierarchy:

```typescript
export class RoomError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "RoomError";
  }
}

export class RoomNotFoundError extends RoomError {
  constructor(roomId: string) {
    super(`Room ${roomId} not found`, "ROOM_NOT_FOUND");
  }
}

export class MemberNotAvailableError extends RoomError {
  constructor(memberName: string, reason: string) {
    super(`Member ${memberName} is not available: ${reason}`, "MEMBER_NOT_AVAILABLE");
  }
}

export class MemberNotFoundError extends RoomError {
  constructor(memberName: string) {
    super(`Member ${memberName} not found`, "MEMBER_NOT_FOUND");
  }
}

export class SpawnFailedError extends RoomError {
  constructor(memberName: string, reason: string) {
    super(`Spawn failed for ${memberName}: ${reason}`, "SPAWN_FAILED");
  }
}

export class LockTimeoutError extends RoomError {
  constructor(lockPath: string) {
    super(`Timed out acquiring lock ${lockPath}`, "LOCK_TIMEOUT");
  }
}
```

### Task B2: Replace magic error strings with typed errors

**Files:**
- Modify: `storage.ts`, `index.ts`, `watchdog.ts`, `lock.ts`

Replace all `throw new Error("...")` patterns with appropriate typed errors. Key locations:
- `storage.ts:assertTaskTargetAvailable` → `MemberNotAvailableError`
- `storage.ts:assertDirectedTargetAvailable` → `MemberNotAvailableError`
- `lock.ts:withFileLock` → `LockTimeoutError`
- `index.ts` spawn failure paths → `SpawnFailedError`

### Task B3: Remove silent error swallowing

**Files:**
- Modify: `index.ts`, `watchdog.ts`, `spawn.ts`

Review all `.catch(() => {})` and `.catch(() => null)` patterns:
- Keep only where errors are truly non-actionable
- Add at least a `log.warn()` for every ignored error
- Replace `.catch(() => {})` with `.catch((err) => log.warn("...", { error: String(err) }))` where appropriate

---

## Area C: Test Coverage Gaps

### Task C1: Add dispatch.test.ts with unit tests

**Files:**
- Create: `extensions/subagent/dispatch.test.ts`

Test coverage for pure functions:
- `isMessageTargetedToMember` — direct, mention, room-only, self-message
- `shouldDeliverMessage` — targeted, broadcast, self-sent
- `applyIncomingMessageState` — task, cancelled matching task, cancelled non-matching, info
- `applyOutgoingMessageState` — completion matching replyTo, error matching replyTo, stale replyTo
- `formatRoomMessageContent` — with/without content, with/without replyTo

### Task C2: Add lock.test.ts with edge case tests

**Files:**
- Create: `extensions/subagent/lock.test.ts`

Test coverage:
- Race between two lock attempts on same path
- Heartbeat renewal during long critical section
- Stale lock takeover (cross-hostname and same-hostname)
- Lock release after fn throws
- Concurrent heartbeat write + lock mutation isolation

### Task C3: Add bootstrap.test.ts

**Files:**
- Create: `extensions/subagent/bootstrap.test.ts`

Test coverage:
- `parseRoomBootstrapBlock` — valid, invalid JSON, missing markers, wrong version
- `buildRoomBootstrapBlock` — round-trip with parse
- `buildRoomMemberSystemPrompt` — includes skill body, agent prompt, bootstrap block
- `loadTypedRoomAgentDefinition` — existing agent, non-existent

### Task C4: Add logger.test.ts

**Files:**
- Create: `extensions/subagent/logger.test.ts`

Test coverage:
- `info` writes to file when roomDir set
- `info` suppressed when `PI_ROOM_LOG_LEVEL=silent`
- `error` always writes
- `debug` only writes when `PI_ROOM_LOG_LEVEL=debug`
- Stream pooling (same logPath → same stream)
- `closeLogStream` cleans up

### Task C5: Add errors.test.ts

**Files:**
- Create: `extensions/subagent/errors.test.ts`

Test coverage:
- Each error class has correct name and code
- Error instances are instanceof base RoomError

### Task C6: Run all tests and fix existing failures

```bash
cd /home/thn/.pi/agent/extensions/subagent && npx vitest run --reporter=verbose 2>&1
```

Verify all tests pass. Fix any pre-existing failures.

---

## Area D: Maintainability (Refactoring index.ts)

### Task D1: Extract tool handler functions

**Files:**
- Create: `extensions/subagent/tools.ts`
- Modify: `extensions/subagent/index.ts`

Move from index.ts:
- `AgentsToolSchema`, `MailToolSchema` constants
- `executeAgentsTool` function
- `executeMailTool` function
- `resolveRoomAndSession` helper
- `textResult`, `ownerOnlyError`, `isNonEmptyString`, `extractSummaryMentions` helpers
- `RoomExecCtx` interface

### Task D2: Extract room lifecycle management

**Files:**
- Create: `extensions/subagent/lifecycle.ts`
- Modify: `extensions/subagent/index.ts`

Move from index.ts:
- `ActiveRoomContext` interface
- `activeRooms` map + `getActiveRoom`/`setActiveRoom`/`clearActiveRoom`
- `startPolling`, `startOwnerHeartbeat`, `startMemberHeartbeat`
- `resolveAccessibleRoom`, `activateBootstrapRoom`
- `processUnreadMessages`
- `trackActiveRoomTask`

### Task D3: Extract tool schemas

**Files:**
- Create: `extensions/subagent/schemas.ts`
- Modify: `extensions/subagent/tools.ts`

Move schema JSON objects to separate file for cleaner module boundaries.

### Task D4: Update imports in index.ts

After extraction, index.ts should be ~200 lines acting as the extension entry point:
- Extension registration
- Re-exports
- Session lifecycle hooks

---

## Area E: Documentation

### Task E1: Write architecture overview

**Files:**
- Create: `extensions/subagent/docs/architecture.md`

Cover:
- Module structure (which file does what)
- Data flow: owner spawns member → bootstrap → join → message delivery
- State machine diagram for RoomMemberLifecycleState
- File layout under runtime/rooms/{roomId}/
- Concurrency model (file locks, atomic writes)

### Task E2: Write configuration reference

**Files:**
- Create: `extensions/subagent/docs/configuration.md`

Document all environment variables:
- `PI_ROOM_OWNER_HEARTBEAT_INTERVAL_MS` (default 1000)
- `PI_ROOM_OWNER_HEARTBEAT_STALE_MS` (default 5000)
- `PI_ROOM_MEMBER_HEARTBEAT_INTERVAL_MS` (default 1000)
- `PI_ROOM_MEMBER_HEARTBEAT_STALE_MS` (default 5000)
- `PI_ROOM_SPAWN_JOIN_TIMEOUT_MS` (default 15000)
- `PI_ROOM_LOG_LEVEL` (silent | default | debug)
- `PI_ROOM_PASEO_CLI_PATH`
- `PI_ROOM_OWNER_SHUTDOWN_TASK_GRACE_MS`

### Task E3: Write API reference for extension consumers

**Files:**
- Create: `extensions/subagent/docs/api.md`

Document:
- `roomExtension` function signature and options
- Room tool schema (agents tool + mail tool)
- RoomSpawnAdapter interface
- Public exports

---

## Execution Order

Areas A, B, C, D, E are independent and can run in parallel.
Within each area, tasks are sequential.

```
Parallel:
  Area A (Logging):    A1 → verify
  Area B (Errors):     B1 → B2 → B3 → verify
  Area C (Tests):      C1 → C2 → C3 → C4 → C5 → C6 (all add new test files, can run in parallel within C)
  Area D (Refactor):   D1 → D2 → D3 → D4 → verify
  Area E (Docs):       E1 → E2 → E3 (can run in parallel within E)

After all complete: full test suite + final review
```
