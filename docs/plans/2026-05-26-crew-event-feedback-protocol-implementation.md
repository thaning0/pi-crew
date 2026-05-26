# Crew Event Feedback Protocol Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> **Status:** ✅ Implemented — see [docs/crew-external-integration-protocol.md](../crew-external-integration-protocol.md) and the Event-Driven examples in the root README files.

**Goal:** Implement the public `crew:event` lifecycle protocol with safe request/control replay, canonical follow-up routing handles, and optional controlled activation, without introducing business-specific semantics into `pi-crew`.

**Architecture:** Extend the existing event-bus command surface so `crew:add` carries request correlation, activation mode, and hold lease hints, then emit a stable `crew:event` lifecycle stream keyed by `event_id`. Persist a small replay layer beside existing spawn/member state so `request_id` can replay add requests and `command_id` can replay `crew:release` / `crew:abort` controls after restart or timeout. Keep manual activation as a delivery-gate concern layered on top of current room lifecycle rather than a new workflow system.

**Tech Stack:** TypeScript, pi `EventBus` (`pi.events.on` / `pi.events.emit`), existing crew storage/lifecycle/mutation-proxy/watchdog modules, Vitest.

---

## Constraints

- `pi-crew` must remain a generic subagent coordination plugin.
- No business concepts may appear in event names, payload names, or state semantics.
- Existing `crew:add` and `crew:tell` emitters must remain backward compatible.
- The default product behavior must remain “add member, member starts working.”
- Public follow-up routing must use `member_target`; generation control must use `spawn_task_id`.
- v1 must not introduce a separate public durable `member_id`.
- `request_id` reuse with the same normalized material payload must replay, not respawn.
- `command_id` reuse for the same control verb and `spawn_task_id` must replay, not re-run cleanup.
- While held, caller-directed `task`, `info`, and `question` traffic must remain blocked from the runtime and must not mutate member running state.
- External integrations must not need to read room files or spawn-job files directly.
- The implementation should prefer small, composable changes over a broad lifecycle rewrite.

## Verification Reality

This repository already has focused Vitest-based tests and a local typecheck entrypoint under `extensions/crew/package.json`.

The implementation should therefore validate in three layers:

1. helper-level tests for lifecycle envelope shaping and replay helpers
2. focused integration tests for `crew:add`, `crew:release`, `crew:abort`, claim transitions, hold gating, and replay behavior
3. manual end-to-end smoke verification in a real `pi` session for final event-bus behavior

Recommended commands:

- `cd /home/thn/pi-crew/extensions/crew && npm run typecheck`
- `cd /home/thn/pi-crew/extensions/crew && npx vitest run`

Targeted tests that should exist by the end of the work:

- `extensions/crew/integration-events.test.ts`
- `extensions/crew/event-feedback.test.ts`
- `extensions/crew/state-derivation.test.ts`
- `extensions/crew/storage.test.ts`
- `extensions/crew/mutation-integration.test.ts`
- `extensions/crew/watchdog.test.ts`

## Task 1: Add the public lifecycle-event helper

**Files:**
- Create: `/home/thn/pi-crew/extensions/crew/integration-events.ts`
- Create: `/home/thn/pi-crew/extensions/crew/integration-events.test.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/index.ts`

**Step 1: Define the public protocol envelope**

Add a helper module that defines the public protocol types and helpers for:

- `CrewAddActivation = "immediate" | "manual"`
- `CrewDeliveryState = "pending" | "held" | "enabled" | "ended"`
- `CrewLifecycleEvent` with `event_id`, `request_id`, `command_id`, `requested_name`, `member_target`, `spawn_task_id`, `delivery_state`, `hold_expires_at`, and generic error/reason fields
- lifecycle-event factory helpers that keep `member_target` and `spawn_task_id` distinct
- a best-effort `emitCrewLifecycleEvent(...)` wrapper
- `setCrewEventEmitter(...)`

Do not define or expose a public `member_id`.

For v1, define `member_target` explicitly as the existing internal member record name returned by `createSpawningMember(...).member.name`. `requested_name` remains the caller alias, and formatted labels stay display-only.

**Step 2: Centralize event-id generation**

The helper should generate `event_id` inside the shared emission path so every lifecycle event has a stable deduplication key.

**Step 3: Register the event sink from the extension entrypoint**

In `index.ts`, initialize the helper with a no-throw wrapper around `pi.events.emit("crew:event", payload)`.

The sink must be best-effort: outbound feedback must never crash crew lifecycle handling.

**Step 4: Verification**

Run:

- `cd /home/thn/pi-crew/extensions/crew && npx vitest run integration-events.test.ts`
- `cd /home/thn/pi-crew/extensions/crew && npm run typecheck`

## Task 2: Extend inbound `crew:add` with request correlation and request-time rejection

**Files:**
- Create: `/home/thn/pi-crew/extensions/crew/event-feedback.test.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/index.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/tools.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/types.ts`

**Step 1: Extend the event data shape in `index.ts`**

Add optional fields to the `crew:add` listener payload:

- `request_id?: string`
- `activation?: "immediate" | "manual"`
- `hold_timeout_ms?: number`
- `metadata?: Record<string, unknown>`

Validation rules:

- omit means default behavior
- unknown activation values reject the request cleanly
- `hold_timeout_ms` must be a positive bounded integer when present
- `metadata` must be object-like when present

**Step 2: Normalize material request fields before queueing**

Normalize the material request fields exactly once before they enter the spawn path:

- trimmed `name`, `type`, `model`, `task`
- normalized boolean `transient`
- normalized activation mode
- `hold_timeout_ms` participating only when activation is manual

`metadata` is not part of material identity for replay conflicts.

**Step 3: Emit `rejected` when the request is invalid before generation creation**

When any pre-generation request branch fails before a member generation exists, emit `crew:event` with:

- `event: "rejected"`
- `phase: "request"`
- `request_id` and `requested_name` when available
- no invented `member_target` or `spawn_task_id`

This must cover all current log-and-return branches in the event-bus entrypoint, including:

- invalid payload shape
- missing project cwd / no initialized owner session
- no active owner room
- any other pre-generation validation failure such as unknown agent type

**Step 4: Thread the new fields into `queueCrewAdd`**

Extend the queue input and any intermediate types so request correlation, hold lease hints, and metadata reach the spawn path without reinterpretation.

**Step 5: Verification**

Run:

- `cd /home/thn/pi-crew/extensions/crew && npx vitest run event-feedback.test.ts`
- `cd /home/thn/pi-crew/extensions/crew && npm run typecheck`

Add focused tests for:

- request-time rejection for invalid activation and invalid metadata
- request-time rejection when there is no active owner room
- immediate requests normalizing away `hold_timeout_ms`
- `rejected` emitting no invented generation handles

## Task 3: Persist request replay state for `crew:add`

**Files:**
- Modify: `/home/thn/pi-crew/extensions/crew/types.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/storage.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/tools.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/mutation-proxy.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/storage.test.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/event-feedback.test.ts`

**Step 1: Add persisted request replay state**

Introduce the minimum persisted shape needed to recover add requests after timeout or restart. It must retain at least:

- `request_id`
- normalized material request fields
- first accepted `metadata`
- activation mode and any effective hold timeout
- `spawn_task_id`
- latest replayable lifecycle snapshot fields needed for re-emission

Prefer the narrowest storage shape that works with the existing owner proxy and restart reconciliation paths.

**Step 2: Persist request state on first accepted add**

On the first accepted `crew:add` with a `request_id`, write the request replay record in the same room-mutation-serialized generation-reservation path that creates the spawning member record so later retries can replay instead of double-spawn.

Do not implement replay-record creation as a separate best-effort side effect around `queueCrewAdd`; it must share the same locked write boundary as concrete generation reservation.

**Step 3: Implement replay and conflict detection**

When a new `crew:add` arrives with an existing `request_id`:

- if material fields match, do not spawn a second generation
- replay the latest known lifecycle event for that request
- if material fields conflict, emit `rejected` with a conflict reason

**Step 4: Keep replay state current through later lifecycle transitions**

Whenever spawn/claim/activation/abort/termination advances, update the replay record so the latest known state can be re-emitted.

**Step 5: Verification**

Run:

- `cd /home/thn/pi-crew/extensions/crew && npx vitest run storage.test.ts event-feedback.test.ts`
- `cd /home/thn/pi-crew/extensions/crew && npm run typecheck`

Add focused tests for:

- repeated identical `crew:add` returns replay instead of respawn
- conflicting `request_id` reuse emits `rejected`
- first accepted `metadata` wins for replay
- replay survives delayed reconciliation or proxy-mediated writes

## Task 4: Emit `spawned` and spawn-level `failed` with aligned public fields

**Files:**
- Modify: `/home/thn/pi-crew/extensions/crew/tools.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/transient.test.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/event-feedback.test.ts`

**Step 1: Emit `spawned` only after a concrete generation exists**

Hook emission at the point where crew has:

- created the concrete member record
- resolved `member_target`
- created `spawn_task_id`
- resolved runtime identity when available

The payload must include when available:

- `request_id`
- `requested_name`
- `member_target`
- `member_type`
- `room_id`
- `spawn_task_id`
- `runtime_id`
- `activation`
- `metadata`
- `delivery_state`
- `hold_expires_at` for manual held generations

Do not emit `member_id`.

`member_target` must be the internal member record name, not the caller alias and not the formatted member label.

**Step 2: Emit `failed` from the generation-failure path**

Reuse the current catch/failure reconciliation path in `queueCrewAdd` and emit a `failed` lifecycle event with:

- `phase: "spawn"`
- human-readable `error`
- any known request/generation correlation fields

This event is distinct from request-time `rejected` because a concrete member generation was already attempted.

**Step 3: Update the request replay snapshot**

After emitting `spawned` or spawn-level `failed`, persist the latest replayable event shape for the request record.

**Step 4: Verification**

Run:

- `cd /home/thn/pi-crew/extensions/crew && npx vitest run transient.test.ts event-feedback.test.ts`
- `cd /home/thn/pi-crew/extensions/crew && npm run typecheck`

Add focused tests for:

- successful `crew:add` emits `spawned` with `member_target`
- invalid `crew:add` emits `rejected`
- forced adapter failure after generation creation emits `failed`

## Task 5: Emit `claimed` from the first persisted session-claim transition

**Files:**
- Modify: `/home/thn/pi-crew/extensions/crew/storage.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/mutation-proxy.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/lifecycle.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/mutation-integration.test.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/event-feedback.test.ts`

**Step 1: Anchor claim emission on persisted `sessionId` acquisition**

`claimed` should be emitted on the first persisted transition where the active generation gains a non-null `sessionId`, including proxy-finalized and timeout-recovery paths.

**Step 2: Emit only once per generation**

Use persisted member/spawn/request state to guard first-claim emission across retries, replay, reattach, and stale-session reconciliation.

**Step 3: Include held-state fields when relevant**

For manual activation, `claimed` should continue to echo:

- `delivery_state: "held"`
- `hold_expires_at`

It must not imply work has already started.

**Step 4: Verification**

Run:

- `cd /home/thn/pi-crew/extensions/crew && npx vitest run mutation-integration.test.ts event-feedback.test.ts`
- `cd /home/thn/pi-crew/extensions/crew && npm run typecheck`

Add focused tests for:

- `claimed` arrives only after a concrete `sessionId` exists
- duplicate claim reconciliation does not double-emit
- held members remain held after claim

## Task 6: Persist manual-activation state and gate held delivery correctly

**Files:**
- Modify: `/home/thn/pi-crew/extensions/crew/types.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/storage.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/lifecycle.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/dispatch.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/event-feedback.test.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/storage.test.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/state-derivation.test.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/dispatch.test.ts`

**Step 1: Add explicit delivery-gate state**

Persist enough activation state to answer:

- is this generation immediate or manual?
- what is the current `delivery_state`?
- when does the hold expire?
- has the generation already been released, aborted, or ended?

Keep this separate from task status and room business semantics.

**Step 2: Gate held traffic at both owner-write and member-delivery boundaries**

In the owner-side append/assignment path and in `processUnreadMessages(...)`, held caller-directed `task`, `info`, and `question` messages must be excluded before they can:

- transition the member to `running`
- assign `currentTaskMessageId`
- assign or overwrite `currentTask`
- generate auto-start notifications
- wake the runtime through normal delivery

Bootstrap-safe lifecycle traffic, cancellation reconciliation, dependency coordination that is explicitly required for held cleanup, and owner-side observation must continue to work.

**Step 3: Decide queue-vs-reject at one boundary and document it in code**

The protocol requires blocking delivery, not silently waking the runtime. Implement this as queued-but-undelivered board traffic unless a narrower existing validation boundary already rejects the message. Do not let held delivery semantics vary by message kind accidentally.

**Step 4: Emit `activated` for immediate generations when delivery first opens**

For immediate activation, emit `activated` on the first authoritative transition where the delivery gate opens for normal caller-directed traffic.

- anchor this to the same state change that flips the generation from `delivery_state: "pending"` to `delivery_state: "enabled"`
- do not wait for `crew:release`
- do not tie it to task completion or later running-state transitions
- emit it at most once per generation and update request replay state at the same time

**Step 5: Verification**

Run:

- `cd /home/thn/pi-crew/extensions/crew && npx vitest run state-derivation.test.ts dispatch.test.ts`
- `cd /home/thn/pi-crew/extensions/crew && npm run typecheck`

Add focused tests for:

- manual members claim but remain held
- immediate members emit `activated` without a manual release path
- held task assignment does not eagerly mutate `currentTask` / `currentTaskMessageId` in storage-side writes
- held `task`, `info`, and `question` traffic does not wake the runtime
- held traffic does not mutate running-state derivation prematurely
- release later allows queued caller-directed traffic to flow normally

## Task 7: Add `crew:release` / `crew:abort` with control replay and activation outcomes

**Files:**
- Modify: `/home/thn/pi-crew/extensions/crew/index.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/tools.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/types.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/storage.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/mutation-proxy.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/event-feedback.test.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/storage.test.ts`

**Step 1: Register inbound control listeners**

In `index.ts`, add `crew:release` and `crew:abort` listeners that accept:

- required `spawn_task_id`
- optional `command_id`
- optional `request_id`
- optional abort `reason`

**Step 2: Persist replayable control-command records**

Add the minimum persisted control replay state keyed by:

- control verb
- `spawn_task_id`
- `command_id`

Use it to replay prior outcomes after timeout or restart.

**Step 3: Implement release and abort semantics**

`crew:release` should:

- open the delivery gate for the held generation
- emit `activated`
- update request replay state with the latest replayable lifecycle event

`crew:abort` should:

- discard the held generation before normal work starts
- emit `aborted`
- use a machine-readable reason such as `caller_abort`
- update request replay state with the latest replayable lifecycle event

**Step 4: Implement control conflict and replay rules**

Handle these cases explicitly:

- identical repeated `command_id` replays prior outcome
- repeated release after activation may replay `activated`
- repeated abort after abort may replay `aborted`
- conflicting reuse of the same `command_id` for a different verb or different `spawn_task_id` emits `failed` with `phase: "activation"`
- invalid release/abort against non-held or opposite-terminal generations emits `failed` with `phase: "activation"`

**Step 5: Verification**

Run:

- `cd /home/thn/pi-crew/extensions/crew && npx vitest run event-feedback.test.ts storage.test.ts`
- `cd /home/thn/pi-crew/extensions/crew && npm run typecheck`

Add focused tests for:

- manual `crew:add` followed by `crew:release` emits `activated`
- manual `crew:add` followed by `crew:abort` emits `aborted`
- repeated identical `command_id` replays prior outcome
- conflicting `command_id` reuse emits activation-phase `failed`

## Task 8: Emit terminal outcomes and auto-abort expired holds

**Files:**
- Modify: `/home/thn/pi-crew/extensions/crew/index.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/tools.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/storage.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/mutation-proxy.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/watchdog.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/watchdog.test.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/storage.test.ts`
- Modify: `/home/thn/pi-crew/extensions/crew/event-feedback.test.ts`

**Step 1: Identify the minimal irreversible terminal sources**

Terminal feedback should come from the smallest set of places that already own irreversible generation reconciliation, for example:

- member session shutdown in `index.ts` when the active member generation is torn down
- member session shutdown paths that destroy the active generation
- watchdog stale cleanup / reap paths
- explicit generation-destroying remove paths
- transient auto-remove paths that actually end the current generation

Do not attempt to mirror every transient log line as a public event. Do not treat archival-only worktree cleanup as a lifecycle authority unless another path has already decided the generation is terminal.

**Step 2: Emit one public `terminated` event per generation**

Include generic fields only:

- `request_id` when known
- `member_target` when still known
- `spawn_task_id`
- runtime/session identifiers when known
- generic `reason`
- `delivery_state: "ended"`

Prevent duplicate terminal events for the same generation.

**Step 3: Auto-abort expired held generations**

Add lease-expiry reconciliation that:

- detects held generations past `hold_expires_at`
- emits `aborted` with `reason: "hold_expired"`
- does not emit `terminated` for that path
- updates both request replay and control replay state as needed

**Step 4: Keep replay state correct for terminal and expiry paths**

After terminal or expiry reconciliation, the latest replayable outcome must survive restart and re-emit correctly for later `request_id` or `command_id` retries.

**Step 5: Verification**

Run:

- `cd /home/thn/pi-crew/extensions/crew && npx vitest run watchdog.test.ts storage.test.ts event-feedback.test.ts`
- `cd /home/thn/pi-crew/extensions/crew && npm run typecheck`

Add focused tests for:

- watchdog-driven stale cleanup emits `terminated`
- explicit generation-destroying remove emits `terminated`
- held lease expiry emits `aborted` with `hold_expired`
- duplicate cleanup does not emit duplicate terminal events for the same generation

## Task 9: Update operator-facing documentation

**Files:**
- Modify: `/home/thn/pi-crew/README.md`
- Modify: `/home/thn/pi-crew/README_ZH.md`
- Modify: `/home/thn/pi-crew/docs/crew-external-integration-protocol.md`

**Step 1: Update README examples**

Add:

- one immediate-activation example using `request_id`
- one manual-activation example using `hold_timeout_ms`
- one control example using `spawn_task_id` and `command_id`

**Step 2: Document public handles and replay semantics**

Document clearly:

- `member_target` for follow-up routing
- `spawn_task_id` for generation control
- `request_id` replay semantics
- `command_id` replay semantics
- best-effort event delivery and replayed terminal outcomes

**Step 3: Document the integration boundary**

State clearly that external integrations should subscribe to `crew:event` rather than reading room files or spawn-job state directly.

**Step 4: Verification**

Run a manual smoke pass against the documented examples in a real `pi` session.

## Suggested Sequencing

Implement in this order:

1. lifecycle-event helper and outbound emitter plumbing
2. inbound `crew:add` shape plus request-time `rejected`
3. request replay persistence and conflict detection
4. `spawned` and spawn-level `failed`
5. `claimed`
6. held delivery-gate state and message gating
7. `crew:release` / `crew:abort` plus `activated` / `aborted`
8. `terminated` and hold-expiry auto-abort
9. README updates and final smoke matrix

This keeps the first usable slice small and lets the stricter replay and hold semantics land on top of the already useful feedback channel.

## Smoke Matrix

The final implementation should be manually verified with at least these scenarios:

1. default `crew:add` succeeds and emits `spawned -> claimed -> activated`
2. invalid `crew:add` emits `rejected`
3. repeated identical `crew:add` with the same `request_id` replays instead of respawning
4. conflicting `request_id` reuse emits `rejected`
5. manual `crew:add` emits `spawned -> claimed` with `delivery_state: "held"` and does not activate work
6. `crew:release` on a held member emits `activated`
7. repeated identical `crew:release` with the same `command_id` replays prior `activated`
8. `crew:abort` on a held member emits `aborted`
9. held lease expiry emits `aborted` with `reason: "hold_expired"`
10. activated member later exits or is reaped and emits `terminated`

## Risks

- Request replay state may drift from the live generation unless every lifecycle edge updates the stored replay snapshot.
- Held-start gating may accidentally block too much system traffic or too little caller-directed traffic if the filter boundary is chosen poorly.
- Duplicate lifecycle emission is easy to introduce when owner, member, proxy, and watchdog all observe related state transitions.
- `command_id` replay may become inconsistent after restart unless control outcomes are persisted with the same rigor as request replay.
- Lease expiry must not be conflated with irreversible runtime termination.

## Explicit Non-Goals For This Plan

- No domain-specific event names or payload fields.
- No durable queue or exactly-once protocol on top of `pi.events`.
- No attempt to expose room file formats as public API.
- No rewrite of room/task semantics beyond what is necessary for request replay, held delivery gating, and control replay.