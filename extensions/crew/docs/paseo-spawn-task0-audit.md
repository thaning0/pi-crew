# Paseo Spawn Consumer Audit

This note records the final post-remediation consumer matrix for the three state anchors introduced in Task 0:

- `RoomSpawnJob.state`
- `member.spawnTaskId`
- `member.runtimeId`

The Task 0 baseline is now fully implemented. Current behavior must be read together with [paseo-spawn-watchdog-maintenance.md](./paseo-spawn-watchdog-maintenance.md).

## Recovery Gate

- `spawn.ts::getPaseoSpawnRecoveryContract()` remains hard-coded to `fallback`.
- Paseo still has no label scan or orphan rediscovery surface, so timeout recovery depends only on the original create promise and late-success cleanup.

## `RoomSpawnJob.state` Consumers

| Consumer | Final dependency | Legacy compatibility |
| --- | --- | --- |
| `storage.ts::assertDirectedTargetAvailable()` | Accepts only dispatchable spawning states for directed delivery. Timeout tombstones are preserved for recovery but rejected for task or message delivery. Paseo still never infers runtime identity from heartbeat data. | Yes. Old persisted `starting/claimed/completed` jobs still load. |
| `storage.ts::claimMemberSession()` | Claim-only. Moves paseo jobs to `claimed` only when the job is still claim-transitionable; preserves `timed_out_pending_external_resolution` tombstones so owner can distinguish “late claim, then finalize” from “unclaimed late success, then cleanup”. | Yes. |
| `storage.ts::finalizeMemberRuntime()` | Owner-authoritative runtime writer. `starting/claimed -> external_created/completed` depending on whether bootstrap already claimed. | Yes. |
| `storage.ts::markMemberJoined()` | Compatibility-only bridge. `pi` keeps direct completion semantics; paseo ignores caller-supplied runtimeId and only records claim metadata. | Yes. |
| `tools.ts::executeAgentsSpawn()` | Reads adapter result, routes persistence through `finalizeMemberRuntime()`, and only late-cleans timed-out external creates when the timed-out generation never claimed bootstrap. Claimed generations still finalize to `completed`; unclaimed generations reserve cleanup under owner authority before `remove()`, and successful late cleanup closes the job as `cancelled`. | Yes. |
| `tools.ts::executeAgentsStop()` / `executeAgentsRemove()` | Treat `timed_out_pending_*` as non-terminal and cancel them before stop/remove proceeds. | Yes. |
| `watchdog.ts::cancelPendingSpawnJobsLocked()` | Cancels every non-terminal job, including timeout tombstones. | Yes. |
| `watchdog.ts::reconcileSpawnTimeouts()` | Phase-aware timeout handler: `starting -> timed_out_pending_external_resolution`; `external_created/claimed -> timed_out_pending_member_claim`. | Yes. |

## `member.spawnTaskId` Consumers

| Consumer | Final dependency | Legacy compatibility |
| --- | --- | --- |
| `bootstrap.ts::parseRoomBootstrapBlock()` | Continues parsing `spawnTaskId` from bootstrap payloads. | Yes. |
| `lifecycle.ts::activateBootstrapRoom()` | Uses `claimMemberSession()` for paseo bootstrap and `markMemberJoined()` for `pi`. | Yes. |
| `storage.ts::claimMemberSession()` / `finalizeMemberRuntime()` | Use `spawnTaskId` as the owner/member handoff anchor and clear it only when the attempt reaches a terminal/retryable end-state. | Yes. |
| `tools.ts::executeAgentsSpawn()` | Seeds the generation and rechecks ownership before finalize, late cleanup, or failure handling. | Yes. |
| `tools.ts::executeAgentsStop()` / `executeAgentsRemove()` | Use `spawnTaskId` to identify in-flight work and determine whether respawn is required. | Yes. |
| `watchdog.ts::cancelPendingSpawnJobsLocked()` / `reconcileSpawnTimeouts()` | Preserve member/job ownership boundaries by only mutating the member that still carries the matching `spawnTaskId`. | Yes. |

## `member.runtimeId` Consumers

| Consumer | Final dependency | Legacy compatibility |
| --- | --- | --- |
| `spawn.ts::createPiMemberAdapter()` | Continues returning a pid-backed runtime handle for `pi`. | Yes. |
| `spawn.ts::createPaseoPiMemberAdapter()` | Returns paseo `agentId` without mutating member state. | Yes. |
| `spawn.ts::stop/remove/observeLiveness()` | Treat runtimeId as the live backend handle. Paseo liveness is daemon-authoritative; `pi` remains pid-based. | Yes. |
| `storage.ts::finalizeMemberRuntime()` | Sole writer of paseo `runtimeId`. | Yes. |
| `storage.ts::markMemberJoined()` | Legacy `pi` compatibility path still merges runtime/session; paseo remains claim-only. | Yes. |
| `tools.ts::executeAgentsSpawn()` | Surfaces runtimeId in user-visible status only after owner finalize or external create completion. | Yes. |
| `tools.ts::executeAgentsStop()` / `executeAgentsRemove()` | Use runtimeId to stop/remove existing runtimes and decide whether a member remains reusable. | Yes. |
| `watchdog.ts::handleStaleOwnerForMember()` / `reconcileMemberLiveness()` | `pi` may still recover runtimeId from heartbeat pid; paseo never does. Paseo liveness decisions depend on daemon results, not heartbeat pid inference. | Yes. |

## No Remaining Deferred Switches

The Task 1-5 switches that were deferred during the initial audit are now complete:

- bootstrap activation has moved to claim-only for paseo;
- owner spawn finalization is runtime-authoritative;
- watchdog timeout handling is phase-aware and fallback-contract aware.