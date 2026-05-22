# Crew Batch Template Workflow Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `crew_batch` tool that runs built-in lightweight workflow templates for bulk add/tell/review loops while suppressing per-branch owner noise and reporting only aggregated batch results.

**Architecture:** Keep room messages and member state as the source of truth. Reuse the existing `silent` delivery suppression instead of inventing a second owner filter, and add only the minimum batch metadata required to propagate silence/tagging across spawn, join, starting, and terminal reply messages. Implement `crew_batch` on top of new private structured helper APIs that return deterministic member/task handles, then layer one generic batch runner plus three thin built-in templates: `parallel-work-aggregate`, `plan-review-loop`, and `implement-review-loop`.

**Tech Stack:** TypeScript, Node.js, Vitest, existing crew room storage/lifecycle/tooling

---

## Scope and non-goals

- Reuse existing room, board, member, and spawn logic; do not redesign crew into a general workflow engine.
- Ship only built-in named templates with per-template params; no inline DSL, no arbitrary branching language, no persistence across process restart.
- Aggregate **all** batch feedback, including failures; do not emit special immediate failure notifications.
- Keep raw batch-managed board entries queryable for debugging, but suppress owner delivery noise via the already-supported `silent` flag on batch-tagged messages.
- Correlate every awaited unit of work by explicit task message id / seq handles returned from internal helpers; do not infer rounds from summaries or broad board scans.

## Template set for this batch

### `parallel-work-aggregate`

- Spawn multiple workers, optionally with initial tasks.
- Wait for spawn readiness for all workers.
- Wait for each assigned task to reach terminal reply.
- Return one aggregated summary with per-worker result status and selected reply excerpts.

### `plan-review-loop`

- Run one author task.
- Run one or more reviewer tasks against the author output.
- If any reviewer rejects, send a single aggregated revision task back to the author and repeat.
- Exit only when all reviewers pass or max rounds is reached.

### `implement-review-loop`

- Same orchestrator as `plan-review-loop`, but tuned for implementation / fix-review wording defaults.
- Reuse the same generic review-loop engine; keep template-specific logic to parameter defaults and summary text.

## Task 1: Extract structured helper APIs and lock down message-handle correlation

**Files:**
- Modify: `extensions/crew/tools.ts`
- Modify: `extensions/crew/types.ts`
- Modify: `extensions/crew/room-feasibility.test.ts`

**Step 1: Write the failing structured-helper tests**

Add tests that assert:

```ts
it("queueCrewAdd returns structured member handles for batch orchestration", async () => {
  const queued = await queueCrewAdd({ name: "worker", type: "researcher", task: "Draft findings" }, ...);
  expect(queued.memberName).toMatch(/^worker/);
  expect(queued.memberLabel).toContain("worker");
  expect(queued.initialTask?.messageId).toBeTruthy();
  expect(queued.initialTask?.seq).toBeGreaterThan(0);
});

it("queueCrewTell returns the exact task handle needed for later reply correlation", async () => {
  const queued = await queueCrewTell({ to: "worker", kind: "task", summary: "Review", content: "..." }, ...);
  expect(queued.message.id).toBeTruthy();
  expect(queued.message.seq).toBeGreaterThan(0);
  expect(queued.message.kind).toBe("task");
});
```

**Step 2: Run the focused tests to verify they fail**

Run:

```bash
cd /home/thn/.pi/agent/extensions/crew && npx vitest run dispatch.test.ts room-feasibility.test.ts
```

Expected: FAIL because the internal queue helpers and structured handle return types do not exist yet.

**Step 3: Add minimal type surface**

Extend the shared types with only the fields needed by the tests:

```ts
export interface RoomMemberState {
  // ...
  spawnBatchId?: string | null;
}

export interface RoomMessage {
  // ...
  batchId?: string | null;
}

type QueuedTaskHandle = {
  messageId: string;
  seq: number;
  targetName: string;
  batchId?: string | null;
};
```

**Step 4: Make the tests pass with private helper extraction**

Implement:

- private `queueCrewAdd()` that performs validation / member creation / optional initial task write and returns structured handles.
- private `queueCrewTell()` that appends the message and returns the exact created `RoomMessage`.
- public `executeCrewAdd()` / `executeCrewTell()` become thin text-format wrappers around those helpers.

**Step 5: Re-run the focused tests**

Run:

```bash
cd /home/thn/.pi/agent/extensions/crew && npx vitest run dispatch.test.ts room-feasibility.test.ts
```

Expected: PASS for the new structured-helper coverage.

## Task 2: Propagate batch tags through spawn, join, starting, tell, and reply flows

**Files:**
- Modify: `extensions/crew/tools.ts`
- Modify: `extensions/crew/lifecycle.ts`
- Modify: `extensions/crew/storage.ts`
- Modify: `extensions/crew/types.ts`
- Test: `extensions/crew/room-feasibility.test.ts`

**Step 1: Write the failing end-to-end propagation tests**

Add focused tests that assert:

```ts
it("marks batch-tagged spawn status messages as silent and batch-tagged", async () => {
  // run executeCrewAdd under a batch helper
  // simulate adapter success
  // inspect board messages
  // expect ready/join messages to carry batchId and silent=true
});

it("propagates task batchId into Starting and terminal reply messages", async () => {
  // create batch-tagged task
  // simulate member running transition + crew_reply terminal close
  // inspect board entries
  // expect Starting and completion/error messages to inherit batchId and silent=true
});
```

**Step 2: Run the focused propagation tests and verify failure**

Run:

```bash
cd /home/thn/.pi/agent/extensions/crew && npx vitest run room-feasibility.test.ts -t "batch-tagged"
```

Expected: FAIL because spawn/join/starting/reply messages do not yet inherit batch context.

**Step 3: Add a tiny internal batch context helper in `tools.ts`**

Add a private helper shape:

```ts
type CrewBatchContext = {
  id: string;
  silentOwnerDelivery: boolean;
};
```

and optional internal parameters/helpers so `queueCrewAdd()` / `queueCrewTell()` can tag messages without changing public tool contracts.

**Step 4: Propagate tags at each emission point**

Implement the minimum propagation rules:

- `executeCrewAdd()` writes `spawnBatchId` onto the member while spawning and tags initial task messages.
- spawn success / failure system messages inherit `batchId` and `silent`.
- member join message in `lifecycle.ts` inherits `member.spawnBatchId`.
- auto `Starting:` message inherits the original task message `batchId`.
- `queueCrewTell()` tags batch-created task/info messages.
- `executeCrewReply()` inherits `batchId` from the replied task and marks the raw terminal reply silent for batch-managed tasks.
- clear `spawnBatchId` on successful finalize, spawn failure, cancelled spawn, late cleanup, stop/remove, and any path that permanently detaches the member from the batch-managed spawn.

**Step 5: Re-run the propagation tests**

Run:

```bash
cd /home/thn/.pi/agent/extensions/crew && npx vitest run room-feasibility.test.ts -t "batch-tagged"
```

Expected: PASS for the new propagation coverage.

## Task 3: Add the new `crew_batch` tool surface and shared runner primitives

**Files:**
- Modify: `extensions/crew/schemas.ts`
- Modify: `extensions/crew/index.ts`
- Create: `extensions/crew/batch.ts`
- Test: `extensions/crew/room-feasibility.test.ts`

**Step 1: Write the failing registration / validation tests**

Add tests that assert:

```ts
it("registers crew_batch", () => {
  // extension bootstrap
  // expect registered tool names to include crew_batch
});

it("rejects unknown crew_batch templates", async () => {
  const result = await executeCrewBatch({ template: "unknown", params: {} }, ...);
  expect(result.isError).toBe(true);
});
```

**Step 2: Run the focused tests to verify failure**

Run:

```bash
cd /home/thn/.pi/agent/extensions/crew && npx vitest run room-feasibility.test.ts -t "crew_batch"
```

Expected: FAIL because no schema, registration, or executor exists.

**Step 3: Add the schema and registration**

Add:

```ts
export const CrewBatchSchema = {
  type: "object",
  properties: {
    template: { enum: ["parallel-work-aggregate", "plan-review-loop", "implement-review-loop"] },
    params: { type: "object" },
  },
  required: ["template", "params"],
  additionalProperties: false,
};
```

and register `crew_batch` in `extensions/crew/index.ts`.

**Step 4: Add the minimal executor shell in `extensions/crew/batch.ts`**

Implement:

- template dispatch
- shared `waitForMembersReady()` / `waitForTaskTerminalReplies()` polling helpers that take exact member/task handles instead of rescanning by summary text
- aggregated text result formatting
- no template-specific logic beyond a stub switch yet
- explicit timeout/result states for ready wait, reply wait, and max-round exhaustion so hung work is still reported in the final aggregate

**Step 5: Re-run the focused tool-surface tests**

Run:

```bash
cd /home/thn/.pi/agent/extensions/crew && npx vitest run room-feasibility.test.ts -t "crew_batch"
```

Expected: PASS for registration + unknown-template validation, with template behavior tests still failing until Task 4 lands.

## Task 4: Implement `parallel-work-aggregate`

**Files:**
- Modify: `extensions/crew/batch.ts`
- Test: `extensions/crew/room-feasibility.test.ts`

**Step 1: Write the failing template test**

Add a test like:

```ts
it("parallel-work-aggregate returns one aggregated result and suppresses raw owner delivery", async () => {
  // create room and owner context
  // run crew_batch with two workers/tasks using a fake adapter
  // simulate worker replies
  // expect one text result containing both workers
  // expect sentMessages not to contain per-worker ready/starting/reply notifications
});
```

**Step 2: Run the focused template test and verify failure**

Run:

```bash
cd /home/thn/.pi/agent/extensions/crew && npx vitest run room-feasibility.test.ts -t "parallel-work-aggregate"
```

Expected: FAIL because the template does not yet orchestrate add/tell/wait/aggregate.

**Step 3: Implement the template minimally**

Implementation shape:

```ts
for (const worker of params.workers) {
  const queued = await queueCrewAdd({ ...worker }, ...);
  handles.push(queued);
}
await waitForMembersReady(handles.map((h) => h.memberName), ...);
await waitForTaskTerminalReplies(handles.flatMap((h) => h.initialTask ? [h.initialTask] : []), ...);
return textResult(renderParallelAggregateSummary(results));
```

Do not emit extra board messages from the batch tool itself.

**Step 4: Re-run the focused template test**

Run:

```bash
cd /home/thn/.pi/agent/extensions/crew && npx vitest run room-feasibility.test.ts -t "parallel-work-aggregate"
```

Expected: PASS with one aggregated return and suppressed raw owner delivery.

## Task 5: Implement the reusable review-loop engine and the two named review templates

**Files:**
- Modify: `extensions/crew/batch.ts`
- Test: `extensions/crew/room-feasibility.test.ts`

**Step 1: Write the failing review-loop tests**

Add tests that cover:

```ts
it("plan-review-loop iterates until all reviewers pass, then returns one final summary", async () => {
  // simulate author task -> reviewer reject -> aggregated revision task -> reviewer pass
});

it("implement-review-loop shares the same engine with implementation-specific defaults", async () => {
  // same structure, different template name / labels
});
```

**Step 2: Run the focused review-loop tests and verify failure**

Run:

```bash
cd /home/thn/.pi/agent/extensions/crew && npx vitest run room-feasibility.test.ts -t "review-loop"
```

Expected: FAIL because the loop engine and retry aggregation do not exist yet.

**Step 3: Implement a small generic review-loop helper**

Implement one engine with these fixed phases:

```ts
author round -> reviewers in parallel -> aggregate reviewer verdicts
if all pass: return final aggregate
else: send one aggregated revision task to author and continue
```

Keep it intentionally narrow:

- max rounds default 3
- reviewer verdicts derived from the exact reviewer task handles created in the current round; never match across rounds by summary text alone
- author and reviewer waits each carry explicit timeout outcomes (`ready_timeout`, `reply_timeout`, `max_rounds_exhausted`) that are aggregated into the final batch result instead of surfacing as separate notifications
- no arbitrary branching or retries outside the fixed loop

**Step 4: Map the two named templates onto the shared engine**

Keep template-specific differences to wording/default labels only.

**Step 5: Re-run the focused review-loop tests**

Run:

```bash
cd /home/thn/.pi/agent/extensions/crew && npx vitest run room-feasibility.test.ts -t "review-loop"
```

Expected: PASS for both named templates.

## Task 6: Cover cleanup edge cases, finish docs, run the focused suite, then the full crew verification

**Files:**
- Modify: `extensions/crew/docs/api.md`
- Modify: `extensions/crew/docs/architecture.md`
- Modify: `extensions/crew/room-feasibility.test.ts`
- Test: `extensions/crew/dispatch.test.ts`
- Test: `extensions/crew/room-feasibility.test.ts`

**Step 1: Add cleanup / stale-tag edge-case tests**

Cover:

- late spawn success cleanup does not leak `spawnBatchId`
- stop/remove clear batch-managed spawn metadata
- cancelled terminal replies preserve correlation but do not leak into later unrelated tasks
- owner-authoritative append paths still preserve `batchId` on batch-managed messages

**Step 2: Update public docs**

Document:

- `crew_batch` schema
- supported templates
- aggregation semantics
- silent raw message behavior for batch-managed workflows

**Step 3: Run the focused regression suite**

Run:

```bash
cd /home/thn/.pi/agent/extensions/crew && npx vitest run dispatch.test.ts room-feasibility.test.ts
```

Expected: PASS.

**Step 4: Run the full crew suite**

Run:

```bash
cd /home/thn/.pi/agent/extensions/crew && npx vitest run
```

Expected: PASS.

**Step 5: Run type-check**

Run:

```bash
cd /home/thn/.pi/agent/extensions/crew && npm run typecheck
```

Expected: PASS.

**Step 6: Commit**

```bash
git add extensions/crew/types.ts \
        extensions/crew/storage.ts \
        extensions/crew/lifecycle.ts \
        extensions/crew/tools.ts \
        extensions/crew/batch.ts \
        extensions/crew/schemas.ts \
        extensions/crew/index.ts \
        extensions/crew/dispatch.test.ts \
        extensions/crew/room-feasibility.test.ts \
        extensions/crew/docs/api.md \
        extensions/crew/docs/architecture.md \
        extensions/crew/docs/plans/2026-05-20-crew-batch-template-workflow.md
git commit -m "feat(crew): add batch workflow templates"
```
