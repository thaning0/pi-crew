# Crew worktree merge 插件改进方案

**Status:** Implemented on 2026-05-06.

**Implementation:** [../2026-05-06-crew-lead-merge-snapshot-implementation.md](../2026-05-06-crew-lead-merge-snapshot-implementation.md)

> 目标：让 lead agent 能在 subagent 仍存活的生命周期内，稳定、可预期地接收和合并其工作成果，而不是依赖 stop/remove 后的清理副作用。

## 1. 现状与问题归纳

基于当前实现和参考文档，现状存在三个直接阻碍：

1. `extensions/crew/worktree.ts` 中 `createWorktree()` 只创建 detached HEAD worktree，不创建真实分支；`branch` 目前只是预计算出来的字符串。
2. `extensions/crew/tools.ts` 中 `executeCrewMerge()` 读取的是 `member.worktreeResult?.branch`，而 `worktreeResult` 只会在 `cleanupWorktree()` 之后出现，导致 merge 依赖 remove/agent lost。
3. `extensions/crew/tools.ts` 中 `executeCrewReply()` 在任务完成时不会把 worktree 改动持久化成 commit，lead 即使收到 completion，也拿不到“可 merge 的快照”。

这会形成错误的工作流：**reply 表示任务完成，但 merge 所需的 branch 与 commit 还不存在**。对 lead 来说，“看见完成”和“能接收结果”不是同一个时刻。

## 2. 设计目标

### 2.1 必须达成

- terminal `crew_reply` 之后，lead 可以立即 merge 对应成员的最新结果。
- merge 不依赖 `crew_remove` / watchdog 清理。
- merge 只作用于“稳定快照”，不读取运行中尚未持久化的工作目录状态。
- merge 成功后，subagent 如需继续工作，仍然保持可继续提交的分支/worktree 关系。
- lead 能看见“谁有可 merge 的工作、最新一次快照是什么、当前是否允许 merge”。

### 2.2 明确不做

- 不把 crew 体系改成 patch/PR 驱动；仍然基于本地 git branch + worktree。
- 不在本轮方案里引入远端同步、代码审查 UI 或自动冲突解决。
- 不改变任务闭环协议本身（`crew_tell` / `crew_reply` / 依赖通知机制保持原样）。

## 3. 方案选型

### 方案 A：维持 cleanup 时建分支，只新增“手动快照”命令

优点：改动最小。  
缺点：lead 仍需记住额外步骤，reply 与 merge 之间依然断裂，不符合“完成即可接收”的心智模型。

### 方案 B：spawn 即绑定分支，terminal reply 同步产出快照，并把 merge readiness 暴露给 lead（推荐）

优点：

- 最符合现有 worktree 架构；
- 修复根因而不是补一个旁路命令；
- 能把“任务完成 → 可 merge”做成一个强约束；
- 便于后续扩展到 `crew_who` / `crew_tasks` 的 merge readiness 展示。

缺点：需要同时调整 `worktree.ts`、`tools.ts`、`watchdog.ts` 以及若干测试。

### 方案 C：放弃长期分支，reply 时导出 patch 给 lead

优点：避免长期维护 worktree branch。  
缺点：偏离当前实现过大，lead 的接收动作也会从 git merge 退化为 patch apply / cherry-pick 风格，学习成本更高。

**结论：采用方案 B。**

## 4. 推荐设计

## 4.1 分支生命周期前移到 spawn，但分支按“成员生命周期实例”唯一化

**涉及文件**

- `extensions/crew/worktree.ts`
- `extensions/crew/tools.ts`
- `extensions/crew/spawn.test.ts`

**改动要点**

- `createWorktree()` 不再创建 detached-only worktree，而是：
  1. 基于 `roomId + memberName + spawnNonce` 生成**本次成员生命周期唯一分支名**；
  2. 在主仓库上创建该分支指向当前 `HEAD`；
  3. 用该分支创建 worktree；
  4. 返回真实可 merge 的 `branch`。
- 分支命名建议升级为更可定位、冲突率更低的格式，例如：`pi/crew/<roomId>/<memberName>/<spawnNonce>`。
- `executeCrewAdd()` 需要把 `roomId` 与稳定 nonce 传入 `createWorktree()`。

**为什么不用“稳定分支 + spawn 时 reset”**

- 同名成员重新 spawn 时，旧 branch 可能仍有未 merge 工作；
- 旧 branch 也可能仍被孤儿 worktree 占用；
- blind reset 会让“恢复”与“覆盖”语义混在一起，存在丢工作风险。

因此，本方案选择：**一个成员实例一条 branch**。lead 不需要猜分支名，只需通过成员状态使用当前 branch。

**关键约束**

- 不要通过 `git checkout -b` 改动 lead 当前仓库所在分支；应使用不切换工作树的 branch 创建方式。
- 分支创建失败时继续 graceful degradation：agent 可以退回普通 cwd，但状态里要明确 worktree 不可用。

## 4.2 把“terminal reply 产出 mergeable 快照”做成可恢复的事务式流程

**涉及文件**

- `extensions/crew/worktree.ts`
- `extensions/crew/tools.ts`
- `extensions/crew/room-feasibility.test.ts`

**改动要点**

- 提取共享 helper，例如 `persistWorktreeSnapshot()`：
  - 检查 worktree 是否存在；
  - `git status --porcelain` 判断是否有变更；
  - 无变更：不创建新 commit，但返回当前 branch tip 与 `hasNewSnapshot=false`；
  - 有变更：`git add -A` + `git -c user.name=pi-agent -c user.email=pi-agent@local commit -m ...`；
  - 返回快照元数据：`branch`、`commitOid`、`committedAt`、`summary`、`hasNewSnapshot`。
- 在 `RoomMemberState` 中新增一个**持久化中的 reply journal**（可命名为 `pendingTerminalReply`），最小包含：
  - `taskSeq`
  - `kind`
  - `snapshotOid`
  - `replyMessageId`
  - `handoffState`（`snapshot_pending` / `snapshot_done` / `reply_appended` / `owner_handoff_done`）
- `executeCrewReply()` 在 `kind in {"completion","error","cancelled"}` 且成员有 active worktree 时，必须在**同一条串行 mutation 路径**上走下面的顺序：

1. 在成员侧创建/恢复 `pendingTerminalReply` 记录。  
2. 调用 `persistWorktreeSnapshot()`，拿到固定的 `snapshotOid`。  
3. 将 `lastSnapshotTaskSeq/lastSnapshotOid/...` 写回成员状态，并把 journal 推进到 `snapshot_done`。  
4. 追加 terminal board reply，并在 journal 中记录 `replyMessageId`。  
5. 完成 owner handoff / dep 通知，并把 journal 标记为 `owner_handoff_done` 后清除。  

**重试语义**

- 如果 **snapshot 成功但 owner handoff 失败**：用户重试同一个 `crew_reply` 时，不应再次强制产生新 commit；只要 journal 里已有 `snapshotOid`，就直接从该状态恢复。
- 如果 **snapshot 失败**：本次 `crew_reply` 不应被当作“已可接收”成功返回；必须显式返回错误，要求修复后重试。
- 如果 **append reply 失败但 snapshot 已成功**：允许留下“已有快照但未闭环”的状态；重试时基于 journal 做幂等恢复，而不是重新提交。

这样可以保证：**lead 看到 terminal reply 时，对应的固定快照已经存在或被明确声明失败。**

## 4.3 为 lead 暴露“可证明正确”的 merge readiness

**涉及文件**

- `extensions/crew/types.ts`
- `extensions/crew/tools.ts`
- `extensions/crew/schemas.ts`（如需扩展 merge 相关参数）
- `extensions/crew/room-feasibility.test.ts`

**推荐最小模型**

- 保留：
  - `worktree`：当前活跃 worktree 绑定关系；
  - `worktreeResult`：成员结束/清理后的归档结果。
- 新增轻量快照元数据（可挂在 `worktree` 下，或新增 `worktreeSnapshot` 字段）：
  - `lastSnapshotOid`
  - `lastSnapshotAt`
  - `lastSnapshotSummary`
  - `lastSnapshotTaskSeq`
  - `lastMergedOid`

**不要持久化一个裸 `mergeReady` 布尔值**

- `mergeReady` 应由规则派生，而不是独立写入；
- 推荐规则：`lastSnapshotOid` 存在、`git cat-file -e <lastSnapshotOid>^{commit}` 通过，且 `lastSnapshotOid !== lastMergedOid`；
- 如果 terminal reply 没有新改动，则 `lastSnapshotOid` 不变，lead 看到的 readiness 也不会被错误抬高。

**对 lead 的直接收益**

- `crew_who` 可以显示：成员当前是否存在“尚未被 merge 的最新快照”、最近一次快照时间/摘要；
- lead 不需要猜“这个 idle 成员有没有可 merge 结果”；
- merge 完成后写回 `lastMergedOid`，状态能自动反映“这次结果已经接收过了”。

## 4.4 `crew_merge` 消费固定 snapshot OID，branch 只承担“继续工作”角色

**涉及文件**

- `extensions/crew/tools.ts`
- `extensions/crew/schemas.ts`
- `extensions/crew/room-feasibility.test.ts`

**改动要点**

- `executeCrewMerge()` 的主目标不再是 branch tip，而是：
  1. active 快照 `lastSnapshotOid`
  2. 若成员已无 active worktree，则回退到 archived snapshot / cleanup 记录中的固定 oid
- branch 仅用于：
  - 标识该成员后续继续工作的承载分支；
  - cleanup/recovery 时定位上下文；
  - 供调试/展示使用。
- merge 前增加 gate：
  - 只允许 `idle` 或 `error` 成员被 merge；
  - 还要同时考虑 `chatBusy`，避免 `state==="idle"` 但成员仍在忙；
  - 若成员 `running` / `spawning` / `stopping` / `chatBusy=true`，直接拒绝，并提示等待稳定快照；
  - 若推导出的 readiness 为 false，提示最近一次 snapshot 已经被 merge，或当前没有新快照。
- merge 成功后返回应包含：
  - snapshot oid；
  - branch 名（如存在）；
  - strategy；
  - merge 的 commit oid（若可获取）；
  - 是否已保留该分支供继续工作。

**merge 成功后的状态更新**

- 将 `lastMergedOid` 更新为本次被接收的 snapshot oid；
- 如果走的是 archived snapshot，也要同样更新，避免 lead 重复 merge 同一个归档结果。

**归档后的 snapshot 优先级**

- 如果 terminal reply 已成功产出固定 `lastSnapshotOid`，后续 remove/watchdog 的 cleanup 只能把它归档，**不能用更新的 cleanup fallback snapshot 覆盖它作为默认 merge 目标**。
- 只有在 terminal reply 没有成功完成、或根本不存在 terminal snapshot 时，cleanup 生成的 fallback snapshot 才能成为默认 merge 目标。
- 也就是说，默认 merge 优先级应为：
  1. `pendingTerminalReply.snapshotOid`（恢复未完成闭环时）
  2. terminal reply 成功产出的 `lastSnapshotOid`
  3. archived terminal snapshot
  4. cleanup-only fallback snapshot

**状态修复语义**

- 如果 git merge/rebase 实际已经成功，但 `lastMergedOid` 写状态失败，下一次 `crew_merge` 应先做修复检查：
  - `git merge-base --is-ancestor <snapshotOid> HEAD`
  - 若结果为真，则直接回填 `lastMergedOid=<snapshotOid>` 并返回“结果已接收，状态已修复”，而不是再次尝试 merge。

**参数语义建议**

- 当前 `deleteBranchAfterMerge` 默认值为 `true`，与“成员持续工作”目标冲突；
- 建议改为默认 `false`，并把文案改成“当确认成员不会继续在同一 worktree 上工作时才删除分支”。

## 4.5 merge 后默认让 subagent 保持可继续工作

**涉及文件**

- `extensions/crew/tools.ts`
- `extensions/crew/watchdog.ts`
- `extensions/crew/worktree.ts`

**推荐策略**

- 默认：**merge 后不删 branch**。
- 如果 merge 成功且成员 worktree 仍存在：
  - 可选执行 `rebase` / `reset --hard` 到 lead 当前分支的新 `HEAD`，但这一步需要明确策略；
  - 本轮建议先把“继续可 commit”放在优先级高于“自动追平主线”。

**推荐折中**

1. 默认保留 branch，不自动删除。  
2. 仅在成员 idle 且 worktree clean 时，提供可选 `syncAfterMerge` 行为（后续增强，不强制纳入首批改动）。  
3. 若用户显式要求 `deleteBranchAfterMerge=true`，则需要同时说明：
   - 成员后续继续工作前要重新绑定分支，或
   - 该成员将被视为一次性 worker。

这样能先解决“lead 能接收结果”，避免首版就引入复杂 rebase 冲突管理。

## 4.6 cleanup / watchdog 回归到“兜底保存固定 snapshot + 清理资源”

**涉及文件**

- `extensions/crew/worktree.ts`
- `extensions/crew/tools.ts`
- `extensions/crew/watchdog.ts`
- `extensions/crew/watchdog.test.ts`

**改动要点**

- `cleanupWorktree()` 不再负责“首次创建 branch”，只负责：
  - 如果有未提交变更，做最后一次 best-effort snapshot；
  - 删除 worktree 目录；
  - 返回 cleanup 结果用于归档。
- `crew_remove` / watchdog 的职责回归成“兜底保存 + 资源回收”。
- `worktreeResult` 继续保留，用于：
  - 成员已被 remove/error 后让 lead 知道最后一次 cleanup 是否保存了东西；
  - 兼容旧流程和异常恢复路径。
- cleanup 归档里也应保存**固定 snapshot oid**，而不只是 branch 名；这样 active worktree 消失后，lead 仍能接收最后一次稳定结果。

## 5. 具体实施任务

### 任务 1：重构 worktree 生命周期与 branch 生成策略

**文件**

- 修改：`extensions/crew/worktree.ts`
- 修改：`extensions/crew/tools.ts`
- 测试：`extensions/crew/spawn.test.ts`

**输出**

- `createWorktree()` 为每个成员生命周期创建唯一 branch 并返回；
- `cleanupWorktree()` 去掉“首次建分支”职责；
- 共用 snapshot helper 初步就位。

### 任务 2：把 terminal reply 与固定 snapshot 绑定，并做成可恢复流程

**文件**

- 修改：`extensions/crew/tools.ts`
- 测试：`extensions/crew/room-feasibility.test.ts`

**输出**

- `crew_reply` 在 terminal 场景下同步持久化 snapshot；
- snapshot 失败时，不再默默成功；
- reply 结果与 mergeability 对齐；
- 新增 journal / 恢复锚点，保证重试不会重复 commit 或丢失状态。

### 任务 3：让 lead 能看见并消费“未接收固定快照”

**文件**

- 修改：`extensions/crew/types.ts`
- 修改：`extensions/crew/tools.ts`
- 测试：`extensions/crew/room-feasibility.test.ts`

**输出**

- `crew_who`/相关状态中可见最近 snapshot 与是否“尚未被 merge”；
- `crew_merge` 读取 active/archived snapshot oid 并校验成员状态；
- `deleteBranchAfterMerge` 默认策略与持续协作场景一致。

### 任务 4：回收路径统一为兜底逻辑

**文件**

- 修改：`extensions/crew/worktree.ts`
- 修改：`extensions/crew/tools.ts`
- 修改：`extensions/crew/watchdog.ts`
- 测试：`extensions/crew/watchdog.test.ts`

**输出**

- remove / agent lost 统一走最后一次 snapshot + 清理；
- 不再依赖 cleanup 产出 branch 才能 merge。

## 6. 验证方案

### 6.1 行为测试

- spawn 一个启用 worktree 的成员后，状态里拿到真实存在的、对本次成员实例唯一的 branch。
- 成员 `crew_reply(kind=completion)` 后，branch 上能看到新 commit，且 lead 立刻可 merge。
- 成员 `crew_reply(kind=completion)` 后，记录固定 `snapshotOid`；lead merge 的是该 oid，而不是可继续前进的 branch tip。
- terminal reply 无代码改动时，不生成新 commit，也不会错误地把 readiness 置为“有新结果”。
- 成员仍处于 `running` 或 `chatBusy=true` 时执行 `crew_merge`，收到明确拒绝。
- merge 成功后，在默认配置下成员仍能继续在原 worktree 分支上提交下一轮结果。
- 已 merge 过同一 snapshot 后再次 merge，会收到“没有新的未接收快照”而不是重复成功。
- `crew_remove` / watchdog 在异常场景下仍能保存未提交变更并清理 worktree。
- 成员被 remove 或 agent lost 后，lead 仍可通过 archived snapshot 回退 merge 最后一次保存结果。
- terminal reply snapshot 已存在后再触发 remove/watchdog，默认 merge 目标仍保持为该 terminal snapshot，而不会被 cleanup fallback snapshot 顶掉。

### 6.2 回归测试

- worktree disabled 的 agent 完全不受影响。
- 非 git 仓库或没有 `HEAD` 的仓库，仍 graceful degradation。
- snapshot commit 失败时，reply 不会假装成功可 merge。
- append/handoff 失败后重试同一个 terminal reply，不会平白多出重复 commit。
- journal 存在时进程崩溃，再次执行同一个 terminal reply 能从中恢复，而不是创建新 snapshot。
- `deleteBranchAfterMerge=true` 与 `false` 两条路径都覆盖。
- merge conflict 路径仍能返回冲突文件列表。
- merge 已成功但 `lastMergedOid` 未写回时，下一次 merge 会修复状态而不是重复 merge。
- stop/remove/watchdog 三条 cleanup 路径保持一致。
- 原有依赖通知、任务关闭、mutation proxy 重试逻辑不被破坏。

## 7. 风险与取舍

- **最大风险**：把 snapshot 从 cleanup 前移到 reply 后，会把“git commit 失败”暴露到任务闭环里；但这是必要的，因为它直接决定 lead 是否真的能接收结果。
- **幂等风险**：terminal reply 重试必须与 snapshot 持久化对齐，否则容易出现重复 commit 或“有 commit 无 reply”的半完成状态；因此方案里必须引入 `lastSnapshotTaskSeq` 之类的恢复锚点。
- **目标漂移风险**：如果 lead merge 的仍是 branch tip 而不是 reply 固定快照，就会把 reply 之后的新改动一并接走；因此方案里必须把 merge 目标固定到 `snapshotOid`。
- **状态设计风险**：若为 merge readiness 引入太多字段，可能增加存储/兼容成本；因此建议先上最小快照元数据，而不是完整的 VCS 状态镜像。
- **branch 生命周期风险**：spawn 时复用/重置旧 branch 容易覆盖未接收成果；因此首版明确采用“成员实例唯一 branch”。
- **遗留清理风险**：成员实例唯一 branch 会增加分支数量；因此需要在成员 remove/reap 且 `lastSnapshotOid===lastMergedOid` 时，提供延迟清理策略。
- **merge 后同步风险**：自动 rebase 虽然看起来方便，但会引入更多冲突与恢复路径；建议首版先保证“可 merge、可继续提交”，再做自动追平。

## 8. 建议的验收标准

满足以下条件即可认为方案目标达成：

1. lead 在成员 `completion` 后无需 `stop/remove` 即可 merge；
2. lead 能从状态输出中判断某成员是否有可 merge 的最新快照；
3. 成员 merge 后仍可继续下一轮工作，不因默认删除 branch 而失效；
4. 异常退出/cleanup 仍保留兜底保存语义。
