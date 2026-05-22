# Crew Worktree Merge 改进方案

> **Status:** Superseded by the snapshot-OID-first implementation.
>
> See:
> - [plans/2026-05-06-crew-lead-merge-snapshot-plan.md](./plans/2026-05-06-crew-lead-merge-snapshot-plan.md)
> - [2026-05-06-crew-lead-merge-snapshot-implementation.md](./2026-05-06-crew-lead-merge-snapshot-implementation.md)
>
> This document describes an earlier branch-centric design. The implemented model now merges fixed snapshot OIDs, preserves terminal snapshot priority over cleanup fallback snapshots, and keeps archived removed members mergeable.

## 1. 问题描述

### 1.1 当前工作流

```
crew_add → createWorktree: git worktree add --detach → /tmp/pi-agent-xxx/
  ↓
代理在 detached HEAD worktree 中工作，变更不 commit
  ↓
crew_reply 完成任务 — 不触发任何 git 操作
  ↓
crew_remove → cleanupWorktree: git add -A + commit + 创建分支 + 删除 worktree
  ↓
crew_merge → 读 member.worktreeResult?.branch → 合并
  ↑
  ⚠️ 循环依赖：分支只在 crew_remove 后才存在，但 worktree 已经删了
```

### 1.2 根本原因

- `createWorktree` 创建的是 detached HEAD，没有命名分支
- 分支创建只在 `cleanupWorktree` 中（`crew_remove` 路径）
- `crew_merge` 需要分支，但分支仅在 remove 后才存在
- remove 后 worktree 已删除，代理不存在，merge 无意义

---

## 2. 总体设计

```
crew_add → 创建命名分支 + worktree (git branch + git worktree add)
  ↓
代理完成任务 → crew_reply → 自动 git commit
  ↓
crew_merge → 合并代理分支到当前主分支
  ↓  (可选) merge 成功后将 worktree rebase 到新 HEAD
代理继续下一个任务 → crew_reply → git commit（循环）
  ↓
crew_stop / crew_remove → 保存未提交变更 → 清理 worktree + 分支
```

**核心原则：**
- 分支随 spawn 创建，与代理同生命周期
- commit 在任务完成时自动发生，不依赖 remove
- merge 可在代理存活期间随时使用
- remove 只做清理，不做 commit/分支创建

---

## 3. 改动细节

### 3.1 改动一：`createWorktree` 改为创建命名分支

**涉及文件：** `worktree.ts`

**当前代码：**
```ts
await git(["worktree", "add", "--detach", worktreePath, "HEAD"], cwd);
```

**改为：**
```ts
const branch = `pi/crew/${roomId}/${memberName}`;
await git(["checkout", "-b", branch, "HEAD"], cwd);  // 在主仓库创建分支
await git(["branch", "-f", branch, "HEAD"], cwd);     // force: 覆盖已有同名分支
await git(["worktree", "add", worktreePath, branch], cwd);
```

**函数签名修改：**
```ts
export async function createWorktree(
  roomDir: string,
  memberName: string,      // 内部名如 "worker_1234"
  displayName: string,     // 用户别名如 "worker"
  cwd: string,
): Promise<{ path: string; branch: string } | undefined>
```

**返回的 branch 值写入 `member.worktree.branch`，供后续 merge 使用。**

**边界场景处理：**

| # | 场景 | 处理 |
|---|------|------|
| 1 | 分支名已存在（旧代理未清理残留） | `git branch -f` 强制覆盖 |
| 2 | 同一个 displayName 的不同 memberName（如 `explorer_1234` vs `explorer_5678`） | 以 memberName 为分支名唯一键，不冲突 |
| 3 | 仓库有未跟踪的脏文件 | `git checkout -b` 不受影响 |
| 4 | 仓库有已跟踪的脏文件（modified） | `git checkout -b` 不受影响（主仓库的变更不干扰 worktree） |
| 5 | 仓库没有 HEAD（空仓库） | `isGitRepo` 前置检查已处理，返回 undefined |
| 6 | `/tmp` 磁盘满 | `git worktree add` 失败，返回 undefined |
| 7 | 分支名中特殊字符 | `makeBranchName` 已 sanitize |

---

### 3.2 改动二：`crew_reply` 完成时自动 commit

**涉及文件：** `tools.ts`（`executeCrewReply` 函数）

**触发条件：**
- `kind === "completion"` 或 `kind === "error"`
- 成员有活跃 worktree（`member.worktree?.path` 存在）
- 成员不是 lead（`activeRoom.role !== "member"` 则跳过）

**实现：**
```ts
async function autoCommitWorktree(
  worktreePath: string,
  taskSummary: string,
  isError: boolean,
): Promise<void> {
  if (!existsSync(worktreePath)) return;

  try {
    const status = await git(["status", "--porcelain"], worktreePath, 10_000);
    if (!status) return; // 没有变更，跳过

    await git(["add", "-A"], worktreePath, 10_000);
    const prefix = isError ? "[error]" : "[done]";
    const msg = `pi-agent: ${prefix} ${taskSummary.slice(0, 200)}`;
    await git([
      "-c", "user.name=pi-agent",
      "-c", "user.email=pi-agent@local",
      "commit", "-m", msg,
    ], worktreePath, 10_000);
  } catch {
    // 非致命：commit 失败不阻塞 reply 流程
  }
}
```

**在 `executeCrewReply` 中的调用位置：**
- 在 `appendMessage` 写入消息**之后**
- 在 `recordTerminalTaskState` 之后
- 异步 fire-and-forget（不阻塞 reply 返回值）

**边界场景处理：**

| # | 场景 | 处理 |
|---|------|------|
| 8 | 工作目录没有变更 | `git status --porcelain` 为空 → 跳过，不报错 |
| 9 | git 未配置 user.name/email | 加 `-c user.name=pi-agent -c user.email=pi-agent@local` |
| 10 | worktree 中有合并冲突（`UU` 状态文件） | `git status` 非空但 commit 可能失败。先检查冲突再决定 |
| 11 | 代理 reply `kind=error`（任务失败） | 仍然 commit，message 加 `[error]` 前缀，保留部分工作成果 |
| 12 | commit 期间磁盘满 | `git commit` 抛错，catch 后不重试，reply 不受影响 |
| 13 | 并发场景：commit 与 lead 的 merge 同时发生 | commit 是原子的；merge 拿到已有的 commits，不包含正进行中的 commit |

---

### 3.3 改动三：`crew_merge` 改为从 worktree.branch 读取分支

**涉及文件：** `tools.ts`（`executeCrewMerge` 函数）

**数据源变更：**
```diff
- const branch = member.worktreeResult?.branch;
+ const branch = member.worktree?.branch;
```

**错误消息更新：**
```diff
- "No worktree branch found. The agent may not have been stopped yet."
+ "No worktree branch found. The agent may not have worktree isolation enabled."
```

**边界场景处理：**

| # | 场景 | 处理 |
|---|------|------|
| 14 | 代理还没完成过任务，分支上没有任何 commit | merge 返回 "Already up to date."，不是错误 |
| 15 | 代理正在工作（`state=running`），有未提交变更 | merge 拿到的是上一次 commit 的快照。这是**预期行为**——lead 应等代理 idle 后再 merge |
| 16 | `deleteBranchAfterMerge: true` 后代理还活着 | ⚠️ **见 3.5 改动五** |
| 17 | merge 冲突 | 返回冲突文件列表 `git diff --diff-filter=U --name-only`，让 lead 手动解决 |
| 18 | merge 成功，worktree 分支落后于 master（diverged） | merge 成功后自动 rebase worktree（见 3.5） |
| 19 | 代理 spawn 时 worktree 创建失败（member.worktree 为 null） | 返回 "no worktree to merge" |
| 20 | lead 连续两次 merge，第二次没有新 commit | 第二次 merge 返回 "Already up to date." |

---

### 3.4 改动四：`crew_remove` 和 `crew_stop` 简化清理逻辑

**涉及文件：** `tools.ts`、`watchdog.ts`

**`crew_remove` 清理逻辑：**

```ts
if (member.worktree?.path) {
  // 1) 保存尚未 commit 的变更（与 crew_reply 的 auto-commit 逻辑相同）
  if (existsSync(member.worktree.path)) {
    try {
      const status = await git(["status", "--porcelain"], member.worktree.path, 10_000);
      if (status) {
        await git(["add", "-A"], member.worktree.path, 10_000);
        await git([
          "-c", "user.name=pi-agent",
          "-c", "user.email=pi-agent@local",
          "commit", "-m", `pi-agent: [cleanup] ${member.displayName ?? member.name} removed`,
        ], member.worktree.path, 10_000);
      }
    } catch { /* best-effort */ }
  }

  // 2) 存储 worktreeResult 供 lead 参考
  // 仅当 worktreeResult 尚未设置时才写入（防止覆盖已有值）
  if (!member.worktreeResult?.hasChanges) {
    const hasCommittedChanges = branchOnRemoteCheck(member.worktree.branch);
    await updateRoomMemberState(roomDir, member.name, {
      worktreeResult: {
        hasChanges: hasCommittedChanges,
        branch: member.worktree.branch,
      },
    }).catch(() => {});
  }

  // 3) 删除 worktree 目录
  try {
    await git(["worktree", "remove", "--force", member.worktree.path], cwd, 10_000);
  } catch {
    try { await git(["worktree", "prune"], cwd, 5_000); } catch { /* ignore */ }
  }

  // 4) 清理分支
  // 注意：只清理本地分支，不删除已被 merge 的（可能在其他地方被引用）
  try {
    await git(["branch", "-D", member.worktree.branch], cwd, 5_000);
  } catch { /* ignore: 分支可能已被 merge 时删除 */ }
}
```

**`crew_stop` 清理逻辑：**
- 与 remove 相同，但**不清理分支**（代理可能后续被 merge）
- 只保存未提交变更（auto-commit）和清理 worktree 目录

**边界场景处理：**

| # | 场景 | 处理 |
|---|------|------|
| 21 | 代理还有未提交变更 | 先 `add -A` + `commit` 保存，再清理 |
| 22 | 分支已被 `crew_merge` + `deleteBranchAfterMerge=true` 删除 | `git branch -D` 返回 "not found"，忽略 |
| 23 | worktree 目录已不存在（崩溃/手动清理） | `existsSync` 检查，跳过 |
| 24 | worktree 在 remove 时正在被另一个进程使用 | `git worktree remove --force` 通常能处理 |
| 25 | 代理 `state=error`（崩溃），worktree 有脏文件 | watchdog 路径走相同逻辑，先保存再清理 |

---

### 3.5 改动五（新增）：merge 后 worktree rebase 回主分支

**问题：** merge 成功 + `deleteBranchAfterMerge=true` 后，代理的分支被删除，worktree 变成 detached HEAD。代理后续无法 commit。

**解决方案：** merge 成功后重建 worktree 分支到 master HEAD。

```ts
if (mergeSuccess && deleteBranchAfterMerge && member.worktree?.path) {
  // Checkout new branch from master HEAD, attach worktree
  const newBranch = `${member.worktree.branch}-v2`;
  await git(["checkout", "-b", newBranch, "master"], member.worktree.path);
  
  // Update member state
  await updateRoomMemberState(roomDir, member.name, {
    worktree: { ...member.worktree, branch: newBranch },
  }).catch(() => {});
}
```

**或不删分支，而是 rebase：**
```ts
if (mergeSuccess) {
  // Rebase worktree branch onto master (if worktree still exists)
  if (member.worktree?.path && existsSync(member.worktree.path)) {
    await git(["rebase", "master"], member.worktree.path, 30_000).catch(() => {
      // Rebase failed (conflicts) → warn via system message, don't block
    });
  }
}
```

**推荐方案：merge 成功后 worktree rebase 到 master，不删分支。** 这样：
- 代理继续工作时分基于最新代码
- 分支持久存在，后续 merge 不受影响
- `deleteBranchAfterMerge` 仍然有用（比如 lead 明确不再需要代理继续）

**边界场景处理：**

| # | 场景 | 处理 |
|---|------|------|
| 26 | rebase 到 master 时冲突 | 冲突留给代理，系统发 info 消息告知 "worktree has rebase conflicts, manual resolve required" |
| 27 | merge 后 lead 立即 stop 代理 | rebase 可能还在进行 — 应该等 rebase 完成后再清理，或 stop 时取消 rebase |
| 28 | 代理在 merge 期间继续编辑文件 | rebase 可能把代理的变更覆盖 — **应该只在代理 idle 时允许 merge** |

---

### 3.6 新增约束：只允许对 idle 成员执行 merge

```ts
if (member.state !== "idle" && member.state !== "error") {
  return textResult(
    `Member ${mergeLabel} is ${member.state}. Cannot merge while active. Stop the agent first, then merge.`,
    true,
  );
}
```

**允许 `state=error` 的理由：** 崩溃的代理可能有已 commit 但未 merge 的代码。

---

## 4. 改动汇总

| # | 改动 | 文件 | 复杂度 |
|---|------|------|:------:|
| 1 | `createWorktree` 创建命名分支 | `worktree.ts` | 中 |
| 2 | `crew_reply` 自动 commit | `tools.ts` | 低 |
| 3 | `crew_merge` 改为读 `worktree.branch` | `tools.ts` | 低 |
| 4 | `crew_remove`/`crew_stop` 简化清理 | `tools.ts`, `watchdog.ts` | 中 |
| 5 | merge 后 worktree rebase | `tools.ts`, `worktree.ts` | 中 |
| 6 | merge 限制 member state=idle/error | `tools.ts` | 低 |
| 7 | `cleanupWorktree` 简化（不再创建分支） | `worktree.ts` | 低 |

---

## 5. 影响的测试文件

| 文件 | 影响 |
|------|------|
| `worktree.test.ts` | 需要验证新分支创建逻辑 |
| `tools.ts` (spawn test) | 需要验证 worktree.branch 写入 |
| `tools.ts` (merge test) | 需要新增：idle 时 merge、running 时拒绝 merge |
| `tools.ts` (remove test) | 需要验证新清理逻辑 |
| `watchdog.test.ts` | 清理逻辑适配 |

---

## 6. 向后兼容性

- `member.worktree.branch` 为新字段，旧 member state 没有此字段 → merge 时返回 "no worktree to merge"（优雅降级）
- `member.worktreeResult?.branch` 仍保留写入（remove 时），但 merge 不再读取它
- 旧分支（`pi-agent-<name>` 格式）与新分支（`pi/crew/<roomId>/<memberName>` 格式）共存，互不干扰
- API 签名不变（`crew_merge` 参数不变），内部实现改进
