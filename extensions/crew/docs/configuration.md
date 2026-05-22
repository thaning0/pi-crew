# Subagent Extension Configuration

All configuration is via environment variables. No config files or runtime setters are used.

## Environment Variables

### Heartbeat Intervals

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PI_ROOM_OWNER_HEARTBEAT_INTERVAL_MS` | `number` (positive integer) | `1000` | Interval in milliseconds at which the owner writes its heartbeat file (`heartbeat.json`). Controls how frequently the owner signals liveness. |
| `PI_ROOM_OWNER_HEARTBEAT_STALE_MS` | `number` (positive integer) | `5000` | Maximum age in milliseconds after which an owner heartbeat is considered stale. If the owner's heartbeat is older than this, members initiate orphan cleanup and the watchdog considers the room candidate for reaping. |
| `PI_ROOM_MEMBER_HEARTBEAT_INTERVAL_MS` | `number` (positive integer) | `1000` | Interval in milliseconds at which each member writes its individual heartbeat file (`heartbeats/{name}.json`). |
| `PI_ROOM_MEMBER_HEARTBEAT_STALE_MS` | `number` (positive integer) | `5000` | Maximum age in milliseconds after which a member heartbeat is considered stale. Stale members are marked `error` by `reconcileMemberLiveness()`. |

### Spawn

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PI_ROOM_SPAWN_JOIN_TIMEOUT_MS` | `number` (positive integer) | `15000` | Maximum time in milliseconds from spawn job creation to bootstrap claim (member join). If the member process does not join within this window, the spawn is considered failed. |
| `PI_ROOM_PASEO_EXTERNAL_CREATE_TIMEOUT_MS` | `number` (positive integer) | `45000` | Maximum time in milliseconds the owner waits for paseo external agent creation before moving the spawn job to `timed_out_pending_external_resolution`. This does not delete the member record; it preserves a cleanup tombstone until the original create promise resolves. |
| `PI_ROOM_PASEO_BOOTSTRAP_CLAIM_TIMEOUT_MS` | `number` (positive integer) | `15000` | Maximum time in milliseconds the owner waits for bootstrap claim after paseo external creation succeeds. Jobs in `external_created` or `claimed` move to `timed_out_pending_member_claim` when this deadline expires. |

### Logging

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PI_ROOM_LOG_LEVEL` | `string` (`silent` \| `default` \| `debug`) | `default` | Controls log verbosity for the structured JSON-line logger written to `runtime/rooms/{roomId}/agent.log`:<br>• `silent` — only `error` and `warn` messages are written.<br>• `default` — `error`, `warn`, and `info` messages are written.<br>• `debug` — all messages including `debug` are written. |

### Paseo Backend

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PI_ROOM_PASEO_CLI_PATH` | `string` (absolute path) | _(auto-detected from `$PATH`)_ | Override the path to the Paseo CLI binary. When set, the paseo adapter uses this path instead of resolving `paseo` from `$PATH`. Falls back to `PI_SUBAGENT_PASEO_CLI_PATH` if the room-specific variable is not set. |
| `PI_SUBAGENT_PASEO_CLI_PATH` | `string` (absolute path) | _(none)_ | Legacy alias for `PI_ROOM_PASEO_CLI_PATH`. Used as fallback when the room-specific variable is not set. |
| `PASEO_HOST` | `string` (host:port) | _(daemon default)_ | Paseo daemon host passed to `connectToDaemon({ host })`. |

### Shutdown

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PI_ROOM_OWNER_SHUTDOWN_TASK_GRACE_MS` | `number` (non-negative integer) | `250` | Grace period in milliseconds the owner waits for inflight tool tasks to settle during `session_shutdown`. After this grace period, the room is reaped regardless of pending tool results. |

### Test-Only Variables

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PI_ROOM_SKIP_REAL_PASEO` | `boolean` | `false` | When truthy, tests that require real paseo daemon connectivity are skipped. Set in test environments that don't have the paseo daemon running. |
| `PI_ROOM_STRICT_REAL_PASEO` | `boolean` | `false` | When truthy, tests enforce that the real paseo daemon path exists and is functional. Used to catch configuration drift in CI environments where paseo should always be available. |

## Internal Constants (Not Configurable)

These values are hardcoded and not exposed as environment variables:

| Constant | Value | Location | Description |
|----------|-------|----------|-------------|
| Poll interval | `200` ms | `index.ts` → `startPolling()` | Interval between poll cycles that check for new messages and liveness. |
| File lock staleness | `5000` ms | `lock.ts` → `withFileLock()` | Default `staleMs` for `withFileLock` when caller doesn't override. |
| File lock retry interval | `25` ms | `lock.ts` → `withFileLock()` | Sleep time between lock acquisition retries. |
| File lock timeout | `5000` ms | `lock.ts` → `withFileLock()` | Maximum time to wait for lock acquisition before throwing. |
| Pi stop grace | `500` ms | `spawn.ts` → `terminatePid()` | Time to wait between SIGTERM and forced exit check for pi processes. |
| Pi remove grace | `500` ms | `spawn.ts` → `terminatePid()` | Time to wait between SIGTERM and SIGKILL for pi remove operations. |
| Default runtime root | `~/.pi/agent/runtime/rooms` | `storage.ts` → `getDefaultRoomRuntimeRoot()` | Default directory for room runtime files. Can be overridden via `RoomExtensionOptions.runtimeRoot`. |
