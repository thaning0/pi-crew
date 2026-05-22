# ADR-0001: Owner Mutation Proxy — 消除跨进程文件锁竞争

## Status

Accepted

## Context

房间 (room) 系统使用文件锁 `mutation.lock` 序列化所有写操作。锁实现为基于 `fs.open("wx")` 的悲观文件锁，带心跳续期。

### 问题

当 5 个 agent 子进程并发运行时，日志中出现 **35 次 LockTimeoutError / 8 分钟**：

- 单一 `mutation.lock` 文件被 30+ 个 callsite 争夺
- 每个 agent 的子进程独立运行 extension/subagent 插件
- 所有进程共享同一个文件锁目录
- 默认参数 `timeoutMs: 5000, staleMs: 5000, retryIntervalMs: 25` 在高并发下不够用
- 忙等轮询导致 "thundering herd" 效应

### 约束

- Agent 是独立的 paseo 子进程，各有独立内存空间
- Daemon 是上游服务，无法修改
- 只能在 extension/subagent 插件内实现
- 不能引入外部依赖（Redis、数据库等）

## Decision Drivers

- **必须消除 LockTimeoutError** — 35 次/8分钟不可接受
- **应保持非破坏性** — 现有 agent 能正常工作
- **应有降级路径** — 新功能故障时自动回退
- **不应增加外部依赖** — 纯 Node.js 内置能力

## Considered Options

### Option 1: 改良文件锁（锁拆分 + 公平队列 + 参数调优）

- 将 `mutation.lock` 拆为 `messages.lock` / `members/{name}.lock` / `watchdog.lock`
- 公平锁队列避免 thundering herd
- 调整 `staleMs: 10000, timeoutMs: 800, retryIntervalMs: 10`

**Pros**: 改动最小，无架构变化
**Cons**: 仍有文件 I/O，仍有竞争可能，天花板低

### Option 2: Owner Mutation Proxy（选定）

- Owner 进程在 `session_start` 时起 Unix domain socket 服务
- 所有写操作由 agent 通过 socket 发给 owner
- Owner 内部用 `PQueue({ concurrency: 1 })` 串行执行
- 只有一个进程写文件，零文件锁竞争

**Pros**:
- 彻底消除文件锁竞争
- 保留现有 agent 架构不变
- Unix socket 延迟极低（~100μs）
- 降级路径明确：socket 失败自动回退文件锁
- 无需外部依赖，纯 Node.js `net` 模块 + `p-queue`

**Cons**:
- Owner 成为单点（但 owner 崩溃时 agent 降级，且 daemon 会重启 owner）
- 新增 ~400 行代码

### Option 3: 纯内存队列（p-queue + async-mutex）

**Pros**: 最快，零 I/O
**Cons**: 不适用 — agent 是独立进程，内存不共享

## Decision

采用 **Option 2: Owner Mutation Proxy**。

## Architecture

```
Agent 进程 (worker/explorer)           Owner 进程 (主 session)
┌──────────────────────┐              ┌──────────────────────────┐
│ tools.ts             │              │ mutation-proxy.ts         │
│ lifecycle.ts         │── socket ──→ │   PQueue({ concurrency:1})│
│ watchdog.ts          │   JSON-line  │   ┌────────────────────┐ │
│                      │              │   │ append_message     │ │
│ mutation-client.ts   │              │   │ update_member      │ │
│  → connect / send    │              │   │ create_spawn_job   │ │
│  → fallback to lock  │              │   │ write_metadata     │ │
└──────────────────────┘              │   │ ...                │ │
                                      │   └────────────────────┘ │
                                      │   唯一写文件进程           │
                                      └──────────────────────────┘
```

- **传输**: Unix domain socket, JSON-line 协议
- **队列**: p-queue (concurrency=1)
- **降级**: socket 连接失败 → 自动回退 `withFileLock`
- **生命周期**: owner `session_start` 启动，`session_shutdown` 关闭

## Consequences

### Positive

- 并发写进程从最多 N+1 降到 1，彻底消除 LockTimeoutError
- Unix socket 延迟远低于文件锁轮询
- Agent 端调用接口不变（`sendMutationCommand` 是 `withRoomMutationLock` 的 drop-in 替换）
- 保留文件锁作为降级路径

### Negative

- Owner 成为写入单点（接受：owner 崩溃时降级 + daemon 会重启）
- 新增 ~400 行代码，增加维护面
- 引入 p-queue 依赖（已有，周下载 22.8M）

### Risks

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Owner 进程崩溃 | 低 | agent 无法写 | 自动降级到文件锁 |
| Socket 消息积压 | 低 | 写入延迟增加 | PQueue 队列长度监控 |
| 请求-响应丢失 | 极低 | 请求挂起 | 5s 超时 + 降级 |

## Implementation Notes

1. 新增文件：`mutation-proxy.ts` (owner 端), `mutation-client.ts` (agent 端)
2. 修改 `storage.ts`：`withRoomMutationLock` 加 proxy 检测层
3. 修改 `index.ts`：owner session_start 启动 proxy, shutdown 关闭
4. 保留 `lock.ts` 不变作为降级路径
5. 心跳写入保持本地 `temp+rename` 原子操作，不经过 proxy

## Related Decisions

- 现有 `mutation.lock` 实现: `/extensions/subagent/lock.ts`
- 调研报告: `research-lock-patterns` (最佳实践) + `research-lock-libs` (开源库)

## References

- [p-queue](https://github.com/sindresorhus/p-queue) — Promise queue with concurrency control
- [Node.js net module](https://nodejs.org/api/net.html) — Unix domain socket

## Reviewer Notes

以下审计基于 ADR 设计及当前代码库状态（lock.ts, storage.ts, index.ts, lifecycle.ts, watchdog.ts, tools.ts）。当前 `mutation-proxy.ts` 和 `mutation-client.ts` 尚未实现。

---

### Finding 1 (HIGH): 请求-响应协议规范缺失

**证据**: ADR 仅描述 "JSON-line 协议"，未定义：
- **请求ID**: agent 发起 mutation A 后随即发起 mutation B，如何区分两个响应？
- **响应格式**: `withRoomMutationLock<T>` 返回泛型 `T`，响应需序列化返回值（含错误）。
- **内容含换行符**: `RoomMessage.content` 可以是多段落 Markdown，JSON-line 按换行分割会错误截断消息。

**影响**: 实现时必然遇到协议模糊性，导致：
- 请求-响应错配（agent 收到错误 mutation 的返回值）
- 大消息被截断（如 spawn 任务描述含换行）

**建议**: 
1. 采用 **长度前缀帧** (length-prefixed framing) 替代裸 JSON-line: `[4字节 BE uint32 长度][JSON payload]`，彻底解决换行问题。
2. 每条请求携带 `requestId: string` (UUID)，响应包含 `requestId` 和 `result` / `error`。
3. 定义明确的 wire 协议类型:
```typescript
// Request
{ type: "mutation", requestId: string, roomDir: string, fnName: string, args: unknown[] }
// Response
{ type: "result", requestId: string, ok: true, value: unknown }
{ type: "result", requestId: string, ok: false, error: { message: string, code: string } }
```

---

### Finding 2 (HIGH): Owner 崩溃时的部分写入一致性问题

**证据**: `appendMessage` (storage.ts:347-384) 在一次 mutation 中执行:
1. `writeJsonAtomic(getRoomMessagePath(...), complete)` — 写消息文件
2. `writeRoomMetadata(roomDir, { ...metadata, nextSeq: nextSeq + 1 })` — 更新元数据
3. `writeRoomMemberState(roomDir, ...)` — 逐个更新 target member 状态

如果 owner proxy 在执行到步骤 2 时崩溃：
- 消息文件已写入，但 `nextSeq` 未更新 → 下次 append 可能产生 seq 冲突
- Agent 收到超时，降级到 file lock 重试 → 可能重复写入消息（`writeJsonAtomic` 用 UUID temp 文件，不会直接覆盖，但会产生两个不同 ID 的同 seq 消息）

**影响**: 房间状态不一致，需要 manual 修复。虽然降级到文件锁也有此问题，但 proxy 模式增加了一层网络超时的不确定性。

**建议**:
1. **写入顺序保证**: 先写消息文件，最后更新 `nextSeq`。如果 `nextSeq` 未更新，消息文件可被视为 "孤儿" 并在下次 `getPersistedNextSeq` 时自动纳入计数（当前行为已如此）。
2. **幂等性设计**: agent 降级重试时，检查消息是否已存在（通过 `requestId` 或内容哈希），避免重复写入。
3. **显式记录此风险** 到 ADR 的 Risks 表，标注缓解措施为 "写入顺序 + 幂等重试"。

---

### Finding 3 (HIGH): 降级触发时机和重升级路径缺失

**证据**: ADR 说 "socket 连接失败 → 自动回退 withFileLock"，但未定义：
- 降级判定标准：连接失败？发送超时？连续 N 次失败？
- 降级后是否重试升级：一旦回退到文件锁，永远停留？还是定期尝试重连？

**当前影响**: 
- Owner 短暂重启（daemon 在 1-2 秒内重启 owner）后，所有 agent 已降级到文件锁 → 再次出现 thundering herd，失去了 proxy 的所有收益。
- 没有重升级路径意味着 proxy 仅在 "理想条件" 下工作，任何瞬态故障都会永久退化。

**建议**:
1. 实现 **指数退避重连**: agent 在降级后定期尝试重连 proxy（如 1s, 2s, 4s, 最多 30s）。
2. 降级判定: 连续 2 次 RPC 超时（每次 5s），且重连也失败 → 降级。
3. 用状态机管理: `CONNECTED → DEGRADED → RECONNECTING → CONNECTED`。
4. 确保降级期间已发出的 mutation 不丢失：在降级切换时，先完成或取消所有 in-flight 请求。

---

### Finding 4 (MEDIUM): Socket 生命周期管理缺失

**证据**: ADR 未讨论:
- **Socket 文件残留**: owner 崩溃后 socket 文件留在文件系统，下次 owner 启动时 `server.listen(socketPath)` 会失败 (EADDRINUSE)。
- **Socket 文件权限**: Unix domain socket 默认继承 `umask`，但未显式设置。
- **连接队列积压**: `server.listen()` 的 `backlog` 参数未指定；高并发下可能丢连接。
- **Socket buffer 限制**: Unix socket 发送/接收缓冲区有 OS 上限（默认 ~212KB on Linux）。大消息可能 block 或截断。

**建议**:
1. 在 `server.listen()` 之前 `fs.unlink(socketPath).catch(() => {})` 清理残留 socket。
2. 设置 socket 文件权限为 `0o600` (仅 owner 读写)。
3. 指定 `backlog: 32` 或更高。
4. 流式读写 + 长度前缀帧（见 Finding 1）以处理大于 buffer 的消息。
5. **健康检查**: 如果 owner 心跳正常但 socket 已断开（极端情况），agent 应有独立的 socket 健康检测。

---

### Finding 5 (MEDIUM): 心跳写入决策正确但需明确 watchdog 读路径

**证据**: ADR 说 "心跳写入保持本地 temp+rename 原子操作，不经过 proxy" — ✅ 正确决策。

但 watchdog 中的以下函数也使用 `withRoomMutationLock`:
- `reconcileMemberLiveness` (watchdog.ts:473) — 读写 member state + heartbeat
- `reconcileSpawnTimeouts` (watchdog.ts:308) — 读写 spawn job + member state
- `handleStaleOwnerForMember` (watchdog.ts:147) — 更新 member state
- `cancelPendingSpawnJobs` (watchdog.ts:58) — 取消 spawn jobs

这些都是 **owner 端轮询执行的函数**，一旦引入 proxy，这些调用会改为通过 socket 发送给自己？还是 owner 端直接本地调用？

**影响**: 如果 owner 端的 watchdog 也通过 socket 调用 proxy，会产生不必要的 loopback 延迟和潜在的 self-deadlock（watchdog 定时器触发 PQueue 内 mutation，而 PQueue 正在等待 socket 响应... 虽然不会真的死锁，但概念上奇怪）。

**建议**:
1. **Owner 端直接调用**: `withRoomMutationLock` 在 owner 进程内应短路 — 检测到当前进程是 owner，直接使用本地 `PQueue` 而不是走 socket。
2. **或者**: `mutation-client.ts` 在初始化时检测 "我是 owner"，将 `sendMutationCommand` 实现为直接调用 `mutation-proxy.ts` 的本地函数。
3. 在 ADR 中明确这一点："Owner 进程内的写操作直接使用本地 PQueue，不经过 socket loopback"。

---

### Finding 6 (MEDIUM): PQueue 内存增长和背压策略缺失

**证据**: ADR 选择 `PQueue({ concurrency: 1 })`，但未讨论：
- 队列最大长度限制
- 背压处理：当 agent 快速连续发送 100 个 mutation 请求时，PQueue 将所有请求及其闭包保存在内存中
- `p-queue` 的 `throwOnTimeout` 和 `timeout` 选项未提及

**影响**: 
- 消息积压场景（如 5 个 agent 同时写入）可能使 PQueue 堆积数百个请求
- 如果某个 mutation 执行时间异常长（如磁盘 I/O 慢），后续所有请求都被阻塞
- 没有超时机制，agent 可能永远等待

**建议**:
1. 设置 `PQueue({ concurrency: 1, timeout: 10000, throwOnTimeout: true })`。
2. 如队列长度 > 100，拒绝新请求并让 agent 降级到文件锁。
3. 记录 `p-queue` 的 `size` 和 `pending` 到日志，便于监控。

---

### Finding 7 (LOW): 缺少更简单替代方案的量化分析

**证据**: ADR 在 "Considered Options" 中列出了 Option 1 (改良文件锁)，但仅用定性语言 dismiss（"天花板低"）。research-lock-patterns 报告明确发现 **默认 5s timeout 是核心瓶颈**。

**建议**: 在提交到 ~400 行架构变更之前，建议先做一个小实验：
- 将 `timeoutMs` 从 5000 提升到 30000
- 将 `retryIntervalMs` 从 25 降低到 10，加入指数退避
- 将 `staleMs` 从 5000 提升到 15000
- 在 5-agent 并发场景下重跑 8 分钟测试
- 如果 LockTimeoutError 从 35 次降至 <5 次，参数调优方案的风险/收益比远优于 proxy 方案

如果参数调优效果不理想，再实施 proxy 方案。此信息应记录在 ADR 中以备将来参考。

---

### Finding 8 (LOW): 并发 Mutation 语义需要澄清

**证据**: 当前 `withRoomMutationLock` 保证串行化，但 proxy 架构改变了执行位置：
- 文件锁方案: agent 进程获取锁 → 执行 fn → 释放锁。其他 agent 轮询等待。
- Proxy 方案: agent 发送请求 → owner 的 PQueue 串行执行 → 返回结果。

一个关键差异: 文件锁方案中，如果 agent A 持有锁并 crash，锁最终变为 stale 被 agent B 回收。Proxy 方案中，owner crash 导致所有 in-flight 请求超时。

**建议**: 在 ADR 中增加 "Serialization Semantics" 章节，明确:
- 两个方案的等价性（都是 total order of mutations）
- 差异点（crash recovery 机制不同）
- 保证: 同一时刻只有一个 mutation 在修改文件系统

---

### Open Questions

1. **`p-queue` 是否已在 package.json 中?** 当前代码库未见使用。如果需新增依赖，ADR 应注明版本和 treeshaking 评估。
2. **Socket 路径约定**: 使用 `roomDir/proxy.sock` 还是 `/tmp/pi-room-{roomId}.sock`？路径长度限制 (Unix socket 路径最长 ~108 字节) 可能成为问题。
3. **Owner 重启窗口**: Daemon 重启 owner 需要多长时间？在此期间 agent 全部降级，但 daemon 重启完成后 owner 的 proxy 重新可用 — agent 是否会自动重连？(见 Finding 3)
4. **多房间场景**: 如果同一个 owner session 管理多个房间（当前代码在 `findRoomByOwnerSessionId` 返回第一个匹配），每个房间是否一个独立 socket？还是共享一个 socket？
5. **测试策略**: 如何测试 socket 断开、owner 崩溃、消息积压等场景？当前 lock.test.ts 覆盖了文件锁，但 proxy 的测试需要更复杂的 fixture。

---

### Summary

**架构方向正确** — Owner Mutation Proxy 是正确的解决方案，彻底消除了跨进程文件锁竞争。但在当前设计阶段有 **3 个 HIGH severity findings** 需要在实现前解决：

1. **请求-响应协议** 必须定义清楚（长度前缀帧 + requestId + 错误序列化）
2. **部分写入一致性** 需要在 owner 崩溃场景下有明确的恢复策略
3. **降级+重升级** 路径必须实现，否则 proxy 收益在首次瞬态故障后永久丧失

解决这 3 个问题后，该方案可以安全实施。此外 3 个 MEDIUM 建议（socket 生命周期、owner loopback、PQueue 背压）应在实现中一并处理。

**推荐实施顺序**:
1. 先定义 wire 协议和类型 (mutation-proxy-types.ts)
2. 实现 owner 端 (mutation-proxy.ts) + 单元测试
3. 实现 agent 端 (mutation-client.ts) + 集成测试
4. 修改 storage.ts 的 `withRoomMutationLock` 加入 proxy 检测
5. 修改 index.ts 的 session_start/shutdown 管理 proxy 生命周期
6. 保留 lock.ts 不变作为降级路径
