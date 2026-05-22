# 测试覆盖分析报告：watchdog.test.ts、room-feasibility.test.ts、spawn.test.ts

## 主题 1: paseo checkLiveness/fetchAgent 的慢/错/正向结果

### 现有测试锚点

| 测试名称 | 文件位置 | 描述 |
|---------|---------|------|
| `checkLiveness returns true → member stays idle` | [watchdog.test.ts#L1560-L1574](watchdog.test.ts#L1560) | ✅ 正向结果：checkLiveness 返回 true，成员保持 idle 状态 |
| `checkLiveness returns false → member transitions to error` | [watchdog.test.ts#L1577-L1599](watchdog.test.ts#L1577) | ✅ 错误结果：checkLiveness 返回 false，成员转为 error 状态 |
| `checkLiveness throws → optimistic fallback` | [watchdog.test.ts#L1601-L1616](watchdog.test.ts#L1601) | ✅ 异常情况：checkLiveness 抛出异常，降级到乐观模式，成员保持 idle |
| `no checkLiveness → optimistic fallback` | [watchdog.test.ts#L1618-L1633](watchdog.test.ts#L1618) | ✅ 无实现情况：adapter 未实现 checkLiveness，成员保持 idle |

### 可复用的 Helper
- `createTestRoom()` - [L1419-L1430](watchdog.test.ts#L1419) - 创建测试房间
- `createTestMember()` - [L1432-L1449](watchdog.test.ts#L1432) - 创建测试成员（支持指定状态和后端）
- `createPiAdapter()` - [L1451-L1458](watchdog.test.ts#L1451) - 创建 Pi adapter（支持覆盖）

### 缺失覆盖
1. **慢响应/超时**：没有测试 checkLiveness 响应缓慢（>某个时限）的场景
2. **fetchAgent**：没有找到 fetchAgent 相关的测试（可能是在 spawn.ts 中实现）
3. **Paseo 后端特定错误**：没有测试 paseo 特定的错误类型（如 daemon 不可达）
4. **并发 checkLiveness**：没有测试多个成员并发调用 checkLiveness 的场景
5. **heartbeat + checkLiveness 组合**：没有测试 checkLiveness 与心跳状态不一致的场景

---

## 主题 2: spawn timeout 和 late success

### 现有测试锚点

| 测试名称 | 文件位置 | 关键断言 |
|---------|---------|--------|
| `spawn-timeout-clean` | [watchdog.test.ts#L217-L244](watchdog.test.ts#L217) | member.state="error"，spawn job.state="failed" |
| `spawn-timeout-pre-runtime-watermark` | [watchdog.test.ts#L274-L316](watchdog.test.ts#L274) | 保留 lastSeenSeq，触发 task 消息序列号保护 |
| `spawn-timeout-watermark` | [watchdog.test.ts#L336-L391](watchdog.test.ts#L336) | 带 runtimeId 的超时，member 清理 |
| `spawn-timeout-remove-race` | [watchdog.test.ts#L430-L513](watchdog.test.ts#L430) | **并发竞争**：owner 移除与 watchdog 清理的竞争，最终 member.state="removed" |
| `spawn-timeout-race` | [watchdog.test.ts#L517-L678](watchdog.test.ts#L517) | **Late success**：spawn 超时期间，job 完成并 member 转 idle，watchdog 不会清理已成功的成员 |
| Paseo states 保护 | [watchdog.test.ts#L681-L741](watchdog.test.ts#L681) | 对 "claimed" 和 "external_created" 状态的 spawn jobs 不进行超时清理 |

### 可复用的 Helper
- `withTempDir()` - [L32-L39](watchdog.test.ts#L32) - 创建临时目录并清理
- `createRoom()` - storage.ts 导入 - 创建房间结构
- `createSpawnJob()` - storage.ts 导入 - 创建 spawn job 文件
- `writeJsonAtomic()` - storage.ts 导入 - 原子写入 JSON
- `loadRoomMemberState()` - storage.ts 导入 - 读取成员状态
- `readSpawnJob()` - storage.ts 导入 - 读取 spawn job

### 缺失覆盖
1. **多层级超时**：没有测试嵌套超时场景（e.g., owner timeout + member timeout）
2. **超时恢复机制**：没有测试超时后的自动恢复/重试
3. **部分 late success**：没有测试 job 完成但 member state 更新失败的场景
4. **Paseo 特定超时行为**：spawn.test.ts 中有 paseo 相关测试但缺少与 watchdog timeout 的集成

---

## 主题 3: tombstone/保留 member 文件

### 现有测试锚点

| 测试名称 | 文件位置 | 保留字段 |
|---------|---------|--------|
| `spawn-timeout-pre-runtime-watermark` | [watchdog.test.ts#L303-L310](watchdog.test.ts#L303) | **lastSeenSeq**：保留最后看到的消息序列号 |
| 跨 spawn 重用 | [watchdog.test.ts#L311-L316](watchdog.test.ts#L311) | 新 spawn 继承前一个 spawn 的 lastSeenSeq |
| spawn job 状态转换 | watchdog.test.ts 各处 | starting → failed, starting → completed, etc. |
| Paseo 运行时身份 | [room-feasibility.test.ts#L695-L707](room-feasibility.test.ts#L695) | runtimeId, runtimeIdentitySource, bootstrapClaimedAt 的保留 |

### Spawn Job 状态转换覆盖
```
✅ starting → failed (timeout clean)
✅ starting → completed (late success)
✅ claimed → (no cleanup for claimed state)
✅ external_created → (no cleanup for external_created state)
❌ timed_out_pending_external_resolution → ?
❌ timed_out_pending_member_claim → ?
```

### 可复用的 Helper
- `appendDirectedTaskMessage()` - storage.ts 导入 - 用于创建消息序列
- `getRoomMemberStatePath()` - storage.ts 导入
- `writeRoomMemberState()` - storage.ts 导入

### 缺失覆盖
1. **其他 tombstone 字段**：
   - currentTask/currentTaskMessageId 清理验证不完整
   - lastError 保留验证缺失
   - joinedAt 保留验证缺失
2. **Worktree 相关 tombstone**：没有测试 member.worktree 字段的保留
3. **Task 进度（todoProgress）**：没有测试任务进度的保留
4. **Member 文件完全删除场景**：没有测试在某些情况下成员文件应该完全删除的场景
5. **Spawn job 完整生命周期**：缺少从 starting → external_created → claimed → completed 的完整路径测试

---

## 主题 4: watchdog tick logging 相关断言

### 现有覆盖
🔴 **未找到任何 logging 相关的测试断言**

### 详细分析
- watchdog.test.ts 中没有 log 或 tick 相关的断言
- room-feasibility.test.ts 中也没有相关内容
- spawn.test.ts 中没有 logging 验证

### 可能的 logging 需求
根据 watchdog.ts 实现中的注释，以下 logging 点应该被测试：
- L492: `checkLiveness failed, falling back to optimistic`
- L533: `checkLiveness overrides heartbeat — agent is dead`
- L538: `checkLiveness failed, keeping heartbeat result`
- L648: heartbeat 不新鲜时的恢复日志
- 其他 watchdog tick 执行的日志

### 缺失覆盖（全部）
1. **checkLiveness 失败日志**
2. **heartbeat stale 日志**
3. **spawn timeout 检测日志**
4. **member removal/cleanup 日志**
5. **room reap 日志**
6. **watchdog tick 执行时间/性能日志**

---

## 汇总表：每个主题的测试覆盖完整性

| 主题 | 覆盖完整性 | 现有测试数量 | 缺失测试数量 |
|------|----------|-----------|-----------|
| checkLiveness 结果 | ⚠️ 中 | 4 | 5+ |
| spawn timeout & late success | ✅ 较好 | 6+ | 3+ |
| tombstone/member 保留 | ⚠️ 中 | 3+ | 5+ |
| watchdog logging | 🔴 零 | 0 | 10+ |

---

## 推荐的新增测试（优先级）

### 高优先级
1. **spawn timeout slow checkLiveness** - 验证响应超过阈值的行为
2. **tombstone 完整字段保留** - 验证所有字段的保留策略
3. **watchdog tick logging** - 完整覆盖日志断言

### 中优先级
4. **多层级 spawn timeout 竞争**
5. **Paseo checkLiveness 特定错误** 
6. **worktree/todoProgress 保留**

### 低优先级
7. **spawn job 完整生命周期**
8. **并发 checkLiveness**
9. **timeout 恢复机制**

