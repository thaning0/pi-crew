# Subagent Mail / Room / Worktree Fixes Implementation Plan

**Status:** Implemented on 2026-05-05.

**Implementation notes:** [../2026-05-05-subagent-mail-room-worktree-fixes-implementation.md](../2026-05-05-subagent-mail-room-worktree-fixes-implementation.md)

> **For Agent:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复 subagent 扩展的 3 个已确认问题：未解析到 member 的 summary `@mention` 不再阻断 mail 工具、owner room 初始化消息改为静默写板、agent frontmatter 新增 `worktree` 开关且默认关闭专属 worktree。

**Architecture:** 变更限定在 `extensions/subagent` 和共享 agent 定义解析层 `extensions/lib/agents.ts`。邮件修复通过“复用现有 member target 解析逻辑，将有效 mention canonical 化到 internal member name，再输出 skipped warning”实现，不改变原始 summary 文本；room 初始化修复通过为 board message 增加静默投递标记实现；worktree 修复通过给 agent definition 增加布尔字段，并在 spawn 层按配置 gating `createWorktree()` 调用实现。

**Tech Stack:** TypeScript, Vitest, markdown frontmatter parsing, room board persistence.

---

## 已确认语义

- `mail_send` / `mail_reply` 的 summary 中出现 `@xxx` 时，只将“能解析到现有 member”的 mention 写入 `mentions`。
- 解析不到的 `@xxx` 不报错、不阻断 send/reply，只在工具 output 中追加 warning，原始 summary 文本保持不变。
- room 首次创建后给 owner 的 `roomId` 初始化消息仍然写入 board，`mail_list` 可见，但不触发 unread deliver，也不触发 run。
- `agents/*.md` 头部 frontmatter 新增 `worktree: true|false`，默认 `false`；仅在 `true` 时创建专属 worktree。

## 约束与非目标

- 不修改已有 public tool 名称，不改变 `mail_list` 展示格式。
- 不改变 task / completion / cancel 的既有协议，只修复 3 个确认问题。
- 不默认给任何现有 agent 开启专属 worktree；新增的是“能力”而不是“默认行为切换”。
- 不提交 git commit，除非用户后续明确要求。

## 验证策略

- 每个修复点先补失败测试，再做最小实现，再跑对应窄测试。
- 三个修复点全部完成后运行 `cd /home/thn/.pi/agent/extensions/subagent && npx vitest run`。
- 若共享解析逻辑新增 helper，需要保证该 helper 至少被一个 `extensions/subagent/*.test.ts` 覆盖到。

## 风险

- summary 中的 `@scope/pkg`、邮箱等文本仍可能被现有 tokenizer 识别成候选 mention；本次计划只修复“不可解析 mention 不得阻断发送”，不扩大到完整 NLP 级别的 mention 识别重写。实现时必须复用现有 `resolveMemberTarget()` 规则，把 mention 最终落成 internal member name，且对 `ambiguous alias` 走 skipped warning 而不是抛错。
- 初始化消息的“静默”语义必须同时经过 `types.ts`、`storage.ts`、`lifecycle.ts`，否则会出现消息重复处理或仍触发 steer。
- `worktree` 开关默认关闭后，现有依赖专属 worktree 的测试若存在隐式假设，需要显式改成只在 `worktree: true` 的 agent 上断言。

### Task 1: Fix mail mention tolerance

**Files:**
- Modify: `extensions/subagent/tools.ts`
- Test: `extensions/subagent/room-feasibility.test.ts`

**Step 1: Write the failing tests**

在 `extensions/subagent/room-feasibility.test.ts` 增加 2 个用例：

```typescript
it("mail_send keeps working when summary contains unresolved mentions", async () => {
  const result = await executeMailSend(
    { summary: "Check @worker and @missing before publish", kind: "info" },
    pi,
    ctx,
    runtimeRoot,
    adapters,
    {},
  );

  expect(result.isError).toBeUndefined();
  expect(result.content[0]?.text ?? "").toMatch(/seq:/i);
  expect(result.content[0]?.text ?? "").toMatch(/@missing/i);

  const board = await listBoardEntries(roomDir, 20);
  expect(board.at(-1)?.mentions ?? []).toEqual([internalWorkerName]);
  expect(board.at(-1)?.summary).toBe("Check @worker and @missing before publish");
});

it("mail_reply keeps working when summary contains unresolved mentions", async () => {
  const result = await executeMailReply(
    { seq: taskSeq, summary: "Done, handoff @worker and @missing", kind: "completion" },
    pi,
    ctx,
    runtimeRoot,
    adapters,
    {},
  );

  expect(result.isError).toBeUndefined();
  expect(result.content[0]?.text ?? "").toMatch(/seq:/i);
  expect(result.content[0]?.text ?? "").toMatch(/@missing/i);

  const board = await listBoardEntries(roomDir, 20);
  expect(board.at(-1)?.mentions ?? []).toEqual([internalWorkerName]);
});
```

**Step 2: Run the narrow test and verify it fails**

Run:

```bash
cd /home/thn/.pi/agent/extensions/subagent && npx vitest run room-feasibility.test.ts -t "unresolved mentions"
```

Expected: FAIL because unresolved summary mentions currently surface as `Member ... not found` and block the tool.

**Step 3: Write the minimal implementation**

在 `extensions/subagent/tools.ts`：

- 保留 `extractSummaryMentions()` 作为候选 mention 提取器。
- 新增一个局部 helper，形如：

```typescript
async function resolveSummaryMentions(roomDir: string, mentions: string[]): Promise<{
  validMentions: string[];
  unresolvedMentions: string[];
}> {
  // 逐个调用现有 resolveMemberTarget(roomDir, mention)
  // 成功时收集 canonical internal member name
  // MemberNotFound / ValidationError(ambiguous) 时收集 unresolvedMentions
}
```

- 在 `executeMailSend()` 和 `executeMailReply()` 中：
  - 先解析候选 mentions。
  - 仅将 `validMentions` 传给 `appendMessage()`。
  - `validMentions` 必须是 internal member name，不能写 alias / label。
  - 若有 `unresolvedMentions`，在 `textResult` 文本后追加 warning，例如：

```text
seq: 12
warning: skipped unresolved summary mentions: @missing
```

- 不修改原始 `summary` 文本。

**Step 4: Run the same narrow test and verify it passes**

Run:

```bash
cd /home/thn/.pi/agent/extensions/subagent && npx vitest run room-feasibility.test.ts -t "unresolved mentions"
```

Expected: PASS

**Step 5: Run the broader mail-target slice**

Run:

```bash
cd /home/thn/.pi/agent/extensions/subagent && npx vitest run room-feasibility.test.ts -t "direct member target resolution"
```

Expected: PASS; direct `to:` target resolution behavior unchanged.

### Task 2: Add agent frontmatter worktree switch

**Files:**
- Modify: `extensions/lib/agents.ts`
- Modify: `extensions/subagent/tools.ts`
- Test: `extensions/subagent/bootstrap.test.ts`
- Test: `extensions/subagent/spawn.test.ts`

**Step 1: Write the failing tests**

在 `extensions/subagent/bootstrap.test.ts` 增加 frontmatter 解析断言；在 `extensions/subagent/spawn.test.ts` 用 `vi.spyOn()` 对 `loadTypedRoomAgentDefinition()` 与 `createWorktree()` 做 gating 断言。

建议测试形状：

```typescript
it("defaults worktree to false when agent frontmatter omits it", () => {
  const def = loadTypedRoomAgentDefinition("worker");
  expect(def?.worktree ?? false).toBe(false);
});

it("parses explicit worktree frontmatter", () => {
  const parsed = parseAgentDefinitionForTest(`---\nworktree: true\n---\nbody`);
  expect(parsed.worktree).toBe(true);
});

it("does not call createWorktree when agent definition leaves worktree disabled", async () => {
  vi.spyOn(bootstrapModule, "loadTypedRoomAgentDefinition").mockReturnValue({
    type: "worker",
    systemPrompt: "test",
    worktree: false,
  });
  const createWorktreeSpy = vi.spyOn(worktreeModule, "createWorktree");

  await executeAgentsSpawn({ name: "worker-a", type: "worker" }, ...);

  expect(createWorktreeSpy).not.toHaveBeenCalled();
});

it("calls createWorktree only when agent definition enables it", async () => {
  vi.spyOn(bootstrapModule, "loadTypedRoomAgentDefinition").mockReturnValue({
    type: "worker",
    systemPrompt: "test",
    worktree: true,
  });
  vi.spyOn(worktreeModule, "createWorktree").mockResolvedValue({
    path: "/tmp/fake-worktree",
    branch: "pi-agent-worker-a",
  });

  await executeAgentsSpawn({ name: "worker-a", type: "worker" }, ...);

  expect(worktreeModule.createWorktree).toHaveBeenCalledTimes(1);
});
```

如果 `extensions/lib/agents.ts` 当前没有可直接测试的解析入口，则先在该文件导出一个仅供测试使用的小 helper，例如 `parseAgentDefinitionForTest(content: string)`，避免在测试中修改真实 `agents/*.md` 文件。不要依赖临时目录是否为 git repo 来判断默认关闭是否生效；gating 断言必须通过 spy 直接证明 `createWorktree()` 有没有被调用。

**Step 2: Run the narrow tests and verify they fail**

Run:

```bash
cd /home/thn/.pi/agent/extensions/subagent && npx vitest run bootstrap.test.ts -t "worktree"
cd /home/thn/.pi/agent/extensions/subagent && npx vitest run spawn.test.ts -t "worktree"
```

Expected: FAIL because `worktree` frontmatter is not parsed and spawn 当前无条件进入 `createWorktree()` 分支。

**Step 3: Write the minimal implementation**

在 `extensions/lib/agents.ts`：

- 给 `AgentDefinition` 新增字段：

```typescript
worktree?: boolean;
```

- 新增布尔解析 helper：

```typescript
function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.trim() === "true") return true;
    if (value.trim() === "false") return false;
  }
  return undefined;
}
```

- 在 `loadAgentDefinition()` 中读取 `frontmatter.worktree`，未配置时保持 `undefined`，调用方用 `?? false` 处理默认值。
- 导出一个仅供测试调用的解析 helper，例如 `parseAgentDefinitionForTest(content: string)`，直接复用生产解析逻辑。

在 `extensions/subagent/tools.ts` 的 `executeAgentsSpawn()` 中：

- 仅当 `typedAgent.worktree === true` 时才进入 `createWorktree()` 分支。
- 当 `worktree !== true` 时，保持 `effectiveCwd = ctx.cwd`，并且不写 `member.worktree`。
- 保留 worktree 创建失败时的 graceful degradation。

**Step 4: Run the same narrow tests and verify they pass**

Run:

```bash
cd /home/thn/.pi/agent/extensions/subagent && npx vitest run bootstrap.test.ts -t "worktree"
cd /home/thn/.pi/agent/extensions/subagent && npx vitest run spawn.test.ts -t "worktree"
```

Expected: PASS

**Step 5: Sanity-check existing spawn behavior**

Run:

```bash
cd /home/thn/.pi/agent/extensions/subagent && npx vitest run spawn.test.ts -t "persists paseo runtime"
```

Expected: PASS; disabling default worktree should not break existing spawn lifecycle tests.

### Task 3: Make owner-room initialization message silent

**Files:**
- Modify: `extensions/subagent/types.ts`
- Modify: `extensions/subagent/storage.ts`
- Modify: `extensions/subagent/owner-room.ts`
- Modify: `extensions/subagent/lifecycle.ts`
- Verify if needed: `extensions/subagent/mutation-proxy-types.ts`
- Verify if needed: `extensions/subagent/mutation-proxy.ts`
- Test: `extensions/subagent/lifecycle.test.ts`
- Test: `extensions/subagent/room-feasibility.test.ts`

**Step 1: Write the failing tests**

在 `extensions/subagent/lifecycle.test.ts` 新增“静默消息不投递”用例；在 `extensions/subagent/room-feasibility.test.ts` 新增 `mail_list` 可见性用例。

```typescript
it("does not deliver silent initialization messages as steer events", async () => {
  // create room
  // append a silent board message that targets room owner visibility
  // processUnreadMessages(...)
  // assert sendMessage was not called
  // assert lastSeenSeq advanced
});

it("still keeps silent initialization messages on the board", async () => {
  // ensure appendMessage persists silent message
  // listBoardEntries sees it
});

it("mail_list still shows the silent room initialization message", async () => {
  const result = await executeMailList({ limit: 20 }, pi, ctx, runtimeRoot, adapters, {});
  expect(result.isError).toBeUndefined();
  expect(result.content[0]?.text ?? "").toMatch(/Room initialized:/);
});
```

如果更容易做成 owner-room 级别测试，也可以在同一文件通过 `ensureOwnerRoom()` 创建 room，然后断言第一条系统消息未触发 `sendMessage`。

**Step 2: Run the narrow test and verify it fails**

Run:

```bash
cd /home/thn/.pi/agent/extensions/subagent && npx vitest run lifecycle.test.ts -t "silent"
```

Expected: FAIL because room initialization message currently会被当作普通 unread 消息处理。

**Step 3: Write the minimal implementation**

在 `extensions/subagent/types.ts` 的 `RoomMessage` 新增字段：

```typescript
silent?: boolean;
```

在 `extensions/subagent/storage.ts` 的 `appendMessage()` 中把 `silent` 持久化到 `complete` message。

如果类型检查在 mutation proxy 路径报错，则同步检查 `extensions/subagent/mutation-proxy-types.ts` 与 `extensions/subagent/mutation-proxy.ts`，确保扩展后的 `RoomMessage` 可以穿过代理层而不丢字段。

在 `extensions/subagent/owner-room.ts` 的 `initializeOwnerRoomBoard()` 中把初始化消息改成：

```typescript
await appendMessage(roomDir, {
  from: "system",
  to: "room",
  broadcast: false,
  replyTo: null,
  kind: "info",
  summary: `Room initialized: ${roomId}`,
  silent: true,
});
```

在 `extensions/subagent/lifecycle.ts` 的 `processUnreadMessages()` 中：

- 在计算 `deliverable` 前先判断 `message.silent === true`。
- 对 silent message：
  - 不加入 `deliverable`；
  - 仍然推进 `member.lastSeenSeq`；
  - 不写 `Starting:` auto-confirm，不触发 `deliverRoomMessagesBatch()`。

不要改 `executeMailList()` 的筛选逻辑；它应该天然能看到 persisted silent message。

**Step 4: Run the same narrow test and verify it passes**

Run:

```bash
cd /home/thn/.pi/agent/extensions/subagent && npx vitest run lifecycle.test.ts -t "silent"
```

Expected: PASS

**Step 5: Run an owner-room sanity slice**

Run:

```bash
cd /home/thn/.pi/agent/extensions/subagent && npx vitest run lifecycle.test.ts -t "activateBootstrapRoom|compatibility guards"
```

Expected: PASS; message delivery changes do not break bootstrap room activation.

### Task 4: Full verification and plan-close review

**Files:**
- Final close-out adds one implementation note file and updates this plan file status.

**Step 1: Run the complete subagent test suite**

Run:

```bash
cd /home/thn/.pi/agent/extensions/subagent && npx vitest run
```

Expected: PASS

**Step 2: Inspect changed files for scope drift**

Expected changed files should be limited to:

```text
extensions/lib/agents.ts
extensions/subagent/dispatch.ts
extensions/subagent/dispatch.test.ts
extensions/subagent/tools.ts
extensions/subagent/types.ts
extensions/subagent/storage.ts
extensions/subagent/owner-room.ts
extensions/subagent/lifecycle.ts
extensions/subagent/bootstrap.test.ts
extensions/subagent/spawn.test.ts
extensions/subagent/lifecycle.test.ts
extensions/subagent/room-feasibility.test.ts
extensions/subagent/docs/api.md
extensions/subagent/docs/2026-05-05-subagent-mail-room-worktree-fixes-implementation.md
extensions/subagent/docs/plans/2026-05-05-subagent-mail-room-worktree-fixes.md
```

**Step 3: Run post-implementation reviews**

- Review A: plan consistency review against this file.
- Review B: code quality review for regression risk and missing coverage.

**Step 4: Report completion**

在最终汇报中明确：

- 计划文件路径
- 每个窄测试命令的结果
- `npx vitest run` 结果
- 任何残余风险（例如 mention tokenizer 仍非完整语义解析器）
