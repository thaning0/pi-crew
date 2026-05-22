# Fix: mail_reply kind:error 的 member state 语义修正

> **For Agent:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 agent 通过 `mail_reply(kind:"error")` 报告 task 失败后的 member state 从 `"error"` 改为 `"idle"`，以区分"task 级别错误"和"agent 级别丢失"。

**Architecture:** 修改 `dispatch.ts` 的 `applyOutgoingMessageState` 中 `kind:"error"` 分支：agent state 变为 `"idle"`（agent 本身存活且可接受新任务），`lastError` 保留供查询。Board 消息不变，`mail_tasks` 的 task status 推导不变。Watchdog self-heal 无需修改。

**Tech Stack:** TypeScript, Vitest

---

## 背景

### 两个不同概念被混淆在同一个 `state:"error"` 里

| | Task-level error | Agent-level lost |
|---|---|---|
| 触发 | `mail_reply(kind:"error")` | watchdog 心跳超时 / 进程死亡 |
| Agent 状态 | **仍然活着**，可以接新任务 | **真的挂了**，需要 respawn |
| Board 记录 | 有 error reply 消息 | 无 reply，member 消失 |
| mail_tasks 显示 | ❌ error | 💀 agentLost |
| 合理的 member state | **idle**（agent 没事） | error（agent 挂了） |
| 应该 self-heal 吗 | 不适用（不是 error） | 应该（心跳恢复即 idle） |

### 当前 Bug 链

```
mail_reply(kind:"error") → dispatch: state="error" → watchdog self-heal: state="idle", lastError=null
                                    ↑                                              ↑
                              错误地把 task error             无条件清除了 agent 主动报告的
                              映射成 agent error              lastError
```

### 修复逻辑

`mail_reply(kind:"error")` 后 agent 应该回到 `"idle"` —— agent 本身没有故障，只是当前 task 无法完成。task 的错误信息保存在 board 消息中（`mail_tasks` 可查询），`lastError` 字段保留在 member state 中供 `mail_members` 查询。

---

### Task 1: 修改 dispatch.ts 的 applyOutgoingMessageState

**Files:**
- Modify: `/home/thn/.pi/agent/extensions/subagent/dispatch.ts:89-97`

**Step 1: 修改 kind:"error" 分支**

将 `state: "error"` 改为 `state: "idle"`：

```typescript
// 修改前
if (message.kind === "error") {
    return {
        ...member,
        state: "error",
        lastError: message.summary,
        currentTask: null,
        currentTaskMessageId: null,
        taskClosureSteeredMessageId: null,
    };
}

// 修改后
if (message.kind === "error") {
    return {
        ...member,
        state: "idle",
        lastError: message.summary,
        currentTask: null,
        currentTaskMessageId: null,
        taskClosureSteeredMessageId: null,
    };
}
```

**Step 2: 运行现有测试确认哪些失败**

```bash
cd /home/thn/.pi/agent/extensions/subagent && npx vitest run dispatch.test.ts
```

预期：`transitions to error on error matching replyTo` 测试失败（因为期望 `state` 为 `"error"`，现在变为 `"idle"`）

---

### Task 2: 更新 dispatch.test.ts 中的测试

**Files:**
- Modify: `/home/thn/.pi/agent/extensions/subagent/dispatch.test.ts:218-227`

**Step 1: 修改测试期望**

```typescript
// 修改前
it("transitions to error on error matching replyTo", () => {
    const member = makeMember({ state: "running", currentTask: "task A", currentTaskMessageId: "msg-5" });
    const msg = makeMessage({ kind: "error", from: "worker-1", replyTo: "msg-5", summary: "Failed" });
    const result = applyOutgoingMessageState(member, msg);
    expect(result.state).toBe("error");
    expect(result.lastError).toBe("Failed");
    expect(result.currentTask).toBeNull();
    expect(result.currentTaskMessageId).toBeNull();
});

// 修改后
it("transitions to idle on error matching replyTo, preserves lastError", () => {
    const member = makeMember({ state: "running", currentTask: "task A", currentTaskMessageId: "msg-5" });
    const msg = makeMessage({ kind: "error", from: "worker-1", replyTo: "msg-5", summary: "Failed" });
    const result = applyOutgoingMessageState(member, msg);
    expect(result.state).toBe("idle");
    expect(result.lastError).toBe("Failed");
    expect(result.currentTask).toBeNull();
    expect(result.currentTaskMessageId).toBeNull();
});
```

**Step 2: 运行测试确认通过**

```bash
cd /home/thn/.pi/agent/extensions/subagent && npx vitest run dispatch.test.ts
```

预期：全部 PASS

---

### Task 3: 运行完整测试套件

**Files:**
- 无新建或修改文件

**Step 1: 运行所有 subagent 测试**

```bash
cd /home/thn/.pi/agent/extensions/subagent && npx vitest run
```

**Step 2: 检查是否有其他测试因语义变更而失败**

如果有其他测试期望 `mail_reply(kind:"error")` 后 member state 为 `"error"`，需要逐一更新为期望 `"idle"`。

预期：只有 `dispatch.test.ts` 中的测试需要修改（如果 task 2 已做）。

---

### Task 4: 提交

```bash
cd /home/thn/.pi/agent
git add extensions/subagent/dispatch.ts extensions/subagent/dispatch.test.ts
git commit -m "fix: mail_reply kind:error transitions agent to idle instead of error

Task-level error (mail_reply kind:error) is distinct from agent-level
loss (heartbeat timeout). After reporting a task error, the agent is
still alive and ready for new tasks — member state should be 'idle',
not 'error'. The error is preserved in lastError and the board message.

This prevents watchdog self-heal from incorrectly clearing agent-reported
errors and resolves the mail_tasks/mail_members state inconsistency."
```

---

## 影响分析

### 哪些行为会改变

| 场景 | 修改前 | 修改后 |
|------|--------|--------|
| `mail_reply(kind:"error")` 后 member state | `"error"` | `"idle"` |
| 能否立即接受新任务 | 不能（state=error 被 `assertTaskTargetAvailable` 拒绝） | 能（state=idle） |
| watchdog self-heal 会误覆盖吗 | 会 | 不会（state 不是 error） |
| `mail_tasks` 显示 task status | ❌ error（不变） | ❌ error（不变） |
| `mail_members` 显示 lastError | 会被 self-heal 清为 null | 保留 agent 报告的 error summary |
| `lastCompletedTask` | 不设置 | 不设置（语义不是 completion） |

### 哪些不受影响

- `mail_tasks` status 推导逻辑（基于 board 消息 reply kind，不基于 member state）
- watchdog 检测心跳超时 → member state = error 的逻辑
- `kind:"completion"` → idle 的逻辑
- `kind:"cancelled"` → idle 的逻辑
- Board 消息结构
- `mail_send` / `mail_reply` / `mail_context` 工具行为
