# Output/Input 占位符系统实施方案

> **⚠️ 本文档已过时** — 实际实现采用了 `{input:#N}` 序列号占位符 + 模块级 `depIndex` + 自动通知系统，与本方案中描述的 `{output:@agent}` / `{input:@agent}` 代理名占位符架构截然不同。请参考 `tools.ts` 中的 `registerDeps`、`extractInputDeps`、`notifyDependentsIfAllReady` 等函数了解当前实现。本文档保留作为设计演进参考。

## 概述

本方案为 room/mail 系统增加 `{output:@agent}` 和 `{input:@agent}` 占位符支持，使 task 依赖链（多 agent 协作）更加自动化。核心思路：

- **`{output:@agent}`** — 放在 summary 中，展开为上游 agent completion 消息的 summary → 通过 board 推送机制让下游 agent 收到通知
- **`{input:@agent}`** — 放在 content 中，展开为上游 agent completion 消息的 seq+summary 指引 → 下游 agent 用 `crew_read` 读取详情

---

## 1. 占位符语法和解析

### 语法

```
{output:@agent-name}
{input:@agent-name}
```

其中 agent-name 必须匹配 `[a-z0-9][a-z0-9_-]*`（与现有 room member name 规则一致）。

### 解析函数

**文件：** `/home/thn/.pi/agent/extensions/subagent/tools.ts`

**新增辅助函数 `resolvePlaceholders`：**

```typescript
export async function resolvePlaceholders(
  roomDir: string,
  senderName: string,
  summary: string,
  content: string | undefined,
): Promise<{ summary: string; content?: string }> {
  const outputPattern = /\{output:@([A-Za-z0-9][A-Za-z0-9_-]*)\}/g;
  const inputPattern  = /\{input:@([A-Za-z0-9][A-Za-z0-9_-]*)\}/g;

  // Collect all unique agent names from both patterns
  const agentNames = new Set<string>();
  for (const match of summary.matchAll(outputPattern)) agentNames.add(match[1]);
  if (content) {
    for (const match of content.matchAll(inputPattern)) agentNames.add(match[1]);
  }

  // Self-reference detection: if sender references themselves
  if (agentNames.has(senderName)) {
    summary = summary.replace(new RegExp(`\\{output:@${senderName}\\}`, 'g'), `[self-reference: @${senderName}]`);
    if (content) {
      content = content.replace(new RegExp(`\\{input:@${senderName}\\}`, 'g'), `[self-reference: @${senderName}]`);
    }
    agentNames.delete(senderName);
  }

  // For each agent, find its latest completion/error message
  const completionResults = new Map<string, { seq: number; summary: string } | null>();
  for (const name of agentNames) {
    completionResults.set(name, await findLatestCompletion(roomDir, name));
  }

  // Resolve output placeholders in summary
  let resolvedSummary = summary;
  resolvedSummary = resolvedSummary.replace(outputPattern, (_, agentName) => {
    const result = completionResults.get(agentName);
    if (!result) return `{output:@${agentName}}`; // leave unresolved
    return result.summary;
  });

  // Resolve input placeholders in content
  let resolvedContent = content;
  let resolvedCount = 0;
  let unresolvedNames: string[] = [];
  if (resolvedContent) {
    resolvedContent = resolvedContent.replace(inputPattern, (_, agentName) => {
      const result = completionResults.get(agentName);
      if (!result) {
        unresolvedNames.push(agentName);
        return `{input:@${agentName}}`; // leave unresolved
      }
      resolvedCount++;
      return `[dependency ready] #${result.seq} from @${agentName}: ${result.summary}`;
    });
  }

  // Multi-dependency hint
  const totalDeps = resolvedCount + unresolvedNames.length;
  if (totalDeps >= 2 && resolvedContent) {
    if (unresolvedNames.length === 0) {
      resolvedContent += `\n\n---\n此任务有多个依赖。请在 board 上确认所有依赖的 completion 消息都出现后，再统一用 crew_read 读取每个依赖的完整内容，然后开始工作。`;
    } else if (resolvedCount > 0) {
      const unresolvedList = unresolvedNames.map(n => `{input:@${n}}`).join(', ');
      resolvedContent += `\n\n---\n此任务有多个依赖，部分依赖尚未就绪（${unresolvedList}）。等待所有依赖就绪后，再统一用 crew_read 读取每个依赖的完整内容，然后开始工作。`;
    }
  }

  return { summary: resolvedSummary, content: resolvedContent };
}
```

### 辅助函数 `findLatestCompletion`

```typescript
async function findLatestCompletion(
  roomDir: string,
  agentName: string,
): Promise<{ seq: number; summary: string } | null> {
  const allMessages = await listBoardEntries(roomDir, 0);
  const completions = allMessages
    .filter(m => m.from === agentName && (m.kind === "completion" || m.kind === "error"))
    .sort((a, b) => b.seq - a.seq);
  return completions.length > 0
    ? { seq: completions[0].seq, summary: completions[0].summary }
    : null;
}
```

### 注入位置

`resolvePlaceholders` 需要在 **message 写入 board 之前**调用。三处调用点：

1. **executeCrewTell** (line ~990-1005) — `appendDirectedTaskMessage` / `appendMessage` 调用前
2. **executeCrewReply** (line ~1110-1120) — `appendMessage` 调用前
3. **executeCrewAdd** (line ~369-378) — 当 add 带 initial task 时

---

## 2. output 占位符 → summary 注入

### 展开逻辑

`{output:@worker-A}` 在 summary 中展开为 **该 agent 最新 completion 消息的 summary 字段**。

例如：
- 原始 summary：`"@planner 探查完成。{output:@worker-A}"`
- 展开后：`"@planner 探查完成。登录页面已实现：手机号+验证码+OAuth"`

### 格式选择

仅展开 summary 纯文本，不附带 seq 号或前缀。summary 是 board 展示的短文本，不宜过长。seq 号等信息通过 content 中的 `{input:}` 传给下游。

### 未完成时

保持占位符原样（`{output:@worker-A}`），不展开、不报错。下游 agent 在 board 上看到占位符说明依赖尚未完成。

---

## 3. input 占位符 → content 注入

### 展开逻辑

`{input:@worker-A}` 在 content 中展开为：

```
[dependency ready] #<seq> from @<agent-name>: <summary>
```

例如：
```
你需要在 worker-A 完成后开始工作。

[dependency ready] #43 from @worker-A: 登录页面已实现：手机号+验证码+OAuth
```

### 下游 agent 的使用方式

agent 从 content 中看到 `[dependency ready]` 标记行，知道该依赖已完成。对于未完成的占位符（`{input:@agent}` 原样保留），agent 知道还需要等待。

### room-member SKILL.md 增加指引

在 "Reading Task Details" 部分增加：
```
### 依赖就绪标记

当 task content 中包含 `[dependency ready] #<seq> from @<agent>: <summary>` 行时，说明该依赖已完成。
使用 `crew_read { seq: <seq> }` 读取该依赖完成的完整内容（包含详细报告）。
```

---

## 4. 多依赖等待提示

### 注入逻辑

在 `resolvePlaceholders` 末尾自动注入。判断标准：

- **全部就绪** (resolvedCount >= 2, no unresolved): 追加 "此任务有多个依赖。请在 board 上确认所有依赖的 completion 消息都出现后，再统一用 crew_read 读取每个依赖的完整内容，然后开始工作。"
- **部分就绪** (resolvedCount > 0, unresolved > 0): 追加 "此任务有多个依赖，部分依赖尚未就绪（{input:@agent-B}）。等待所有依赖就绪后..."
- **无就绪** (resolvedCount === 0): 不追加提示（所有依赖都在等待，天然行为）

### 实现位置

直接在 `resolvePlaceholders()` 函数末尾实现。

---

## 5. executeCrewTell 改造点

### 改造位置 1：executeCrewTell (line ~990-1005)

```diff
+ // Resolve placeholders before writing to board
+ const { summary: resolvedSummary, content: resolvedContent } = await resolvePlaceholders(
+   activeRoom.roomDir, activeRoom.memberName, params.summary, params.content,
+ );

  message = params.kind === "task" && effectiveTarget !== "room"
    ? await appendDirectedTaskMessage(activeRoom.roomDir, {
        from: activeRoom.memberName,
        to: effectiveTarget,
        replyTo: params.replyTo ?? null,
-       summary: params.summary,
-       content: params.content,
+       summary: resolvedSummary,
+       content: resolvedContent,
      })
    : await appendMessage(activeRoom.roomDir, {
        from: activeRoom.memberName,
        to: effectiveTarget,
        mentions: summaryMentions.length > 0 ? summaryMentions : undefined,
        broadcast: params.broadcast ?? false,
        replyTo: params.replyTo ?? null,
        kind: params.kind ?? "info",
-       summary: params.summary,
-       content: params.content,
+       summary: resolvedSummary,
+       content: resolvedContent,
      });
```

⚠️ **重要：** `extractSummaryMentions` 仍然使用 **原始** `params.summary`（在 `resolvePlaceholders` 调用之前已经提取过了）。`@agent-name` 是 mentions 机制，不是占位符。

### 改造位置 2：executeCrewReply (line ~1110-1120)

在 `appendMessage` 调用前插入：
```typescript
const { summary: resolvedSummary, content: resolvedContent } = await resolvePlaceholders(
  activeRoom.roomDir, activeRoom.memberName, params.summary, params.content,
);
```
然后将 `resolvedSummary` / `resolvedContent` 传入 `appendMessage`。

同样，`replyMentions` 基于原始 params.summary 提取，不受影响。

### 改造位置 3：executeCrewAdd (line ~369-378)

在调用 `appendDirectedTaskMessage` 之前：
```typescript
if (params.task) {
  const { summary: resolvedSummary, content: resolvedContent } = await resolvePlaceholders(
    activeRoom.roomDir, activeRoom.memberName, truncated, params.task,
  );
  const taskMsg = await appendDirectedTaskMessage(activeRoom.roomDir, {
    from: activeRoom.memberName,
    to: params.name,
    replyTo: null,
    summary: resolvedSummary,
    content: resolvedContent,
  });
}
```

---

## 6. 与现有 @mention handoff 的关系

### 当前机制

`extractSummaryMentions()` 从 summary 提取 `@agent-name` 写入 message.mentions → dispatch.ts 根据 mentions 推送 steer 给目标 agent。

### 互补关系

| 特性 | `@agent-name` | `{output:@agent}` | `{input:@agent}` |
|------|--------------|-------------------|------------------|
| **位置** | summary | summary | content |
| **用途** | 推送通知 | 传递上游摘要 | 传递上游就绪标记 |
| **处理方** | dispatch.ts | resolvePlaceholders | resolvePlaceholders |

### 典型用法

```
# Lead 给 downstream agent 分配 task
crew_tell {
  to: "planner",
  kind: "task",
  summary: "@planner 制定计划",
  content: "等待 @scout 完成。收到通知后，基于 {input:@scout} 的内容制定计划，完成后 @worker。"
}
```

- `@planner` → mention 分配任务给 planner
- `@scout` → mention 让 planner 在收到 scout 完成时被通知
- `{input:@scout}` → 展开为 `[dependency ready] #43 from @scout: ...`
- `@worker` → planner 完成后 mention worker

### 最佳实践

- `@agent-name` → handoff 信号（谁该被唤醒）
- `{output:@agent}` → summary 中嵌入上游摘要
- `{input:@agent}` → content 中嵌入 "依赖就绪" 标记

---

## 7. 边界情况

### 7.1 自引用检测

在 `resolvePlaceholders` 中检测 senderName 是否出现在占位符中。如果出现，替换为 `[self-reference: @name]` 警告。

### 7.2 上游 agent 不存在 / 从未完成

`findLatestCompletion` 返回 null → 占位符保持原样。下游 agent 看到 `{input:@nonexistent}` 应视为未完成的依赖。

### 7.3 上游 agent 多次完成

取最近一条 completion/error 消息按 seq 降序。这是合理行为：下游关心的是最新结果。

### 7.4 消息写入时序

resolvePlaceholders 在 executeCrewTell 的 appendMessage 之前执行。此时 board 已有所有历史消息，上游 completion 消息在磁盘上可见。无竞态问题。

---

## 8. 改造清单

### 文件：`/home/thn/.pi/agent/extensions/subagent/tools.ts`

| # | 改动 | 大致位置 | 说明 |
|---|------|---------|------|
| 1 | 新增 `resolvePlaceholders()` | ~line 86 (extractSummaryMentions 附近) | 核心解析 |
| 2 | 新增 `findLatestCompletion()` | 紧邻 resolvePlaceholders | 查找上游 completion |
| 3 | 修改 `executeCrewTell` | ~line 990-1005 | 调用 resolvePlaceholders |
| 4 | 修改 `executeCrewReply` | ~line 1110-1120 | 调用 resolvePlaceholders |
| 5 | 修改 `executeCrewAdd` | ~line 369-378 | 调用 resolvePlaceholders |
| 6 | 添加 `listBoardEntries` 导入 | 文件顶部 | 确保已导入 |

### 文件：`/home/thn/.pi/agent/skills/room-member/SKILL.md`

| # | 改动 | 位置 | 说明 |
|---|------|------|------|
| 7 | 增加依赖就绪标记指引 | "Reading Task Details" 子节 | 指导 agent 识别 `[dependency ready]` |

### 文件：`/home/thn/.pi/agent/skills/room-orchestrator/SKILL.md`

| # | 改动 | 位置 | 说明 |
|---|------|------|------|
| 8 | 增加占位符用法 | "Pattern 3" 或新增子节 | 展示 `{input:@agent}` 用法 |

### 不需要改动

- **types.ts** — RoomMessage 接口无需修改
- **storage.ts** — appendMessage 无需修改
- **dispatch.ts** — 无需修改
