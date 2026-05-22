# 2026-05-03: Worktree 隔离 + 占位符系统 实现方案

## 概述

在 subagent extension 中并行实现了两个前瞻功能：
- **P1** — Git worktree 隔离 + `agents_worktree_merge` 工具
- **P2** — `{output:@agent}` / `{input:@agent}` 占位符系统

两个功能的改动点完全不重叠，独立测试通过。

---

## P1: Worktree 隔离

### 新增文件

**`worktree.ts`** — 4 个异步函数：

| 函数 | 功能 |
|------|------|
| `isGitRepo(cwd)` | 检测项目是否为 git 仓库 |
| `createWorktree(roomDir, agentName, cwd)` | 在 `/tmp/pi-agent-<name>-<random>` 创建 detached HEAD worktree |
| `cleanupWorktree(cwd, worktreePath, commitLabel)` | 提交变更到分支 + 删除 worktree（或无变更直接删除） |
| `pruneWorktrees(cwd)` | 清理孤儿 worktree |

**设计原则**：所有错误静默降级（返回 undefined / 不抛异常），保证非 git 项目、跨文件系统等极端情况不影响 agent spawn。

### 修改文件

| 文件 | 变更 |
|------|------|
| `types.ts` | RoomMemberState 新增 `worktree` 和 `worktreeResult` 字段 |
| `schemas.ts` | 新增 `AgentsWorktreeMergeSchema` |
| `tools.ts` | executeAgentsSpawn 嵌入 worktree 创建；Stop/Remove 增加 cleanup；新增 executeAgentsWorktreeMerge |
| `index.ts` | 注册 `agents_worktree_merge` 工具，过滤不让 subagent 调用 |

### 数据流

```
executeAgentsSpawn()
  → createWorktree() → worktree.path 设为 effectiveCwd
  → SpawnMemberRequest { cwd: effectiveCwd }
  → 子进程在隔离 worktree 中工作

executeAgentsStop() / executeAgentsRemove()
  → cleanupWorktree() → commit + branch + remove
  → worktreeResult 写入 member state

agents_worktree_merge { name, strategy }
  → 读 worktreeResult.branch
  → git merge/rebase/ff-only
  → 冲突时返回文件列表
  → 成功后删分支（可选项）
```

---

## P2: 占位符系统

### 新增函数（`tools.ts`）

| 函数 | 功能 |
|------|------|
| `findLatestCompletion(roomDir, agentName)` | 查找 agent 最新 completion/error 消息的 seq + summary |
| `resolvePlaceholders(roomDir, senderName, summary, content)` | 核心解析器：替换占位符 + 自引用检测 + 多依赖提示 |

### 占位符语义

| 占位符 | 位置 | 展开为 | 用途 |
|--------|------|--------|------|
| `{output:@agent}` | summary | upstream completion.summary | board 推送传递 |
| `{input:@agent}` | content | `[dependency ready] #seq from @agent: summary` | agent 编程判断 |

### 调用链

```
executeMailSend / executeMailReply / executeAgentsSpawn
  → resolvePlaceholders(raw summary, raw content)
  → 替换占位符
  → 如 ≥2 个 {input:} → 自动追加多依赖等待提示
  → 传入 appendMessage / appendDirectedTaskMessage
```

### skill 文档更新

- `room-member/SKILL.md` — 新增"依赖就绪标记"指引
- `room-orchestrator/SKILL.md` — Pattern 3 增加占位符用法示例

---

## 未来扩展方向

以下内容本次未实现，记录为后续演进参考：

1. **声明式 DAG YAML 编排器** — 将占位符系统拓展为完整的 workflow DSL + 调度引擎
2. **worktree 按任务创建** — 当前是 spawn 时创建，未来可按任务 DAG 决定共享/独立 worktree
3. **`kind: "progress"` TUI widget** — 已有 progress kind，未来可加实时 widget（参考 tintinweb）
4. **worktree merge 冲突 AI 解决** — 当前返回冲突列表给 LLM，可自动尝试解决
