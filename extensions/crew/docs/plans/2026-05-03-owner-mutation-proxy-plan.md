<!-- markdownlint-disable-file -->

# Owner Mutation Proxy 实施计划 (v2 — 已整合 Reviewer 审计)

> **基于**: [ADR-0001: Owner Mutation Proxy](../adr/0001-owner-mutation-proxy.md)
>
> **状态**: In Progress（已整合 3 HIGH + 3 MEDIUM reviewer findings）
>
> **日期**: 2026-05-03

---

## 目录

1. [概述](#概述)
2. [任务分解](#任务分解)
3. [执行顺序与依赖关系](#执行顺序与依赖关系)
4. [测试策略](#测试策略)
5. [回滚方案](#回滚方案)

---

## 概述

### 架构回顾

```
Agent 进程 (worker/explorer)           Owner 进程 (主 session)
┌──────────────────────┐              ┌──────────────────────────┐
│ mutation-client.ts   │── socket ──→│ mutation-proxy.ts         │
│  → connect / send    │  len-prefix │   PQueue(conc=1,t/o=10s) │
│  → fallback to lock  │    frame     │   qSize>100 → reject     │
│  → auto-reconnect    │              │   ┌────────────────────┐ │
└──────────────────────┘              │   │ append_message     │ │
  CONNECTED → DEGRADED →              │   │ update_member      │ │
  RECONNECTING → CONNECTED            │   │ create_spawn_job   │ │
                                      │   │ write_metadata     │ │
        Owner 端短路: 本地调用          │   └────────────────────┘ │
        watchdog/lifecycle 不走 socket  │   唯一写文件进程           │
                                      └──────────────────────────┘
```

### 关键决策（含 reviewer 修正）

| 决策点 | 选择 | reviewer finding |
|--------|------|------------------|
| 传输协议 | 4字节 BE uint32 长度前缀 + JSON | Finding 1: 避免换行截断 |
| 队列机制 | p-queue (concurrency=1, timeout=10s, throwOnTimeout) | Finding 6: 背压控制 |
| 降级路径 | 状态机 CONNECTED→DEGRADED→RECONNECTING→CONNECTED | Finding 3: 自动重升级 |
| Owner loopback | Owner 端短路，直接本地 PQueue | Finding 5: 避免自引用 |
| 写入一致性 | 先写消息再更新 nextSeq + 幂等重试 | Finding 2: 崩溃恢复 |
| 心跳处理 | 保持本地 temp+rename 原子操作 | reviewer 确认正确 |

### 影响范围

- **新增文件**: `mutation-proxy-types.ts`, `mutation-proxy.ts`, `mutation-client.ts`
- **修改文件**: `storage.ts`, `index.ts`
- **保持不变**: `lock.ts` (降级路径), `tools.ts`, `lifecycle.ts`, `watchdog.ts`
- **新增依赖**: `p-queue` (~20KB, zero-dependency)

---

## 任务分解

### Task 1: 定义协议类型与帧编码 (mutation-proxy-types.ts)

**预计改动**: ~80 行（新增文件）

**内容**:

1. 定义 wire 类型：
   - `MutationCommand` — 联合类型：`append_message` | `update_member` | `write_metadata` | `create_spawn_job` | `write_spawn_job` | `delete_member` | `mark_member_joined` | `create_spawning_member` | `update_spawn_job`
   - `ProxyRequest` — `{ requestId: string; command: MutationCommand }`
   - `ProxyResponse` — `{ requestId: string; ok: boolean; value?: unknown; error?: string }`

2. 导出版本常量：`PROXY_PROTOCOL_VERSION = 1`

3. 长度前缀帧编解码（reviewer Finding 1）：
   ```
   Frame: [4 bytes BE uint32 len][JSON payload bytes]
   ```
   - `encodeFrame(obj: unknown): Buffer`
   - `createFrameParser(): { feed(chunk: Buffer): void; onFrame: (obj: unknown) => void }`
   - 处理 TCP 分包（半帧缓冲）

4. Socket 路径：
   - `getProxySocketPath(roomDir: string): string` → `{roomDir}/proxy.sock`

5. 环境变量：
   - `PI_MUTATION_PROXY_DISABLE=1` 强制禁用

**依赖**: 无
**测试**: TypeScript 编译通过

---

### Task 2: 安装 p-queue 依赖

**预计改动**: ~5 行

**内容**:
1. 添加 `p-queue` (版本 `^8.1.0`) 为运行时依赖
2. 验证 `import PQueue from 'p-queue'` 可解析

**依赖**: Task 1
**测试**: 编译通过

---

### Task 3: 实现 Proxy Server (mutation-proxy.ts)

**预计改动**: ~160 行（新增文件）

**内容**:

1. **Unix domain socket server**：
   - `net.createServer({ allowHalfOpen: false })`
   - 启动前清理残留 socket（`fs.unlink` + `EADDRINUSE` 处理）
   - Socket 权限 `0o600`，backlog: 32
   - 监听路径: `getProxySocketPath(roomDir)`

2. **PQueue 串行化 + 背压**（reviewer Finding 6）：
   - `new PQueue({ concurrency: 1, timeout: 10000, throwOnTimeout: true })`
   - 队列长度 > 100 时拒绝新请求（返回错误响应）

3. **长度前缀帧协议**（reviewer Finding 1）：
   - 二进制流读取，4字节长度前缀 + JSON payload
   - 使用 `createFrameParser()` 处理半帧缓冲
   - 请求: `{ requestId, command, params }`
   - 响应: `{ requestId, ok, value/error }`

4. **命令处理器**：
   - 从 storage.ts 导入纯写函数，不加锁直接执行
   - 写入顺序保证（reviewer Finding 2）：先写消息文件再更新 nextSeq

5. **生命周期**：
   - `createProxyServer(roomDir: string): ProxyServer`
   - `start()` — 启动监听
   - `stop()` — 拒绝新连接 → 等待队列清空(最多10s) → 关闭server → 删除socket文件

6. **日志**: `createRoomLogger(roomDir, "mutation-proxy")`

**依赖**: Task 1, 2
**测试**: Task 7

---

### Task 4: 实现 Proxy Client (mutation-client.ts)

**预计改动**: ~150 行（新增文件）

**内容**:

1. **长度前缀帧客户端**：
   - `connectToProxy(socketPath: string, timeoutMs: number): Promise<net.Socket>`
   - 使用 `createFrameParser()` 解析响应帧

2. **请求-响应匹配**：
   - `Map<string, PromiseController>` pendingRequests
   - 超时 5s → reject + 清理
   - Socket 意外关闭 → reject 所有 pending

3. **状态机 + 重升级**（reviewer Finding 3）：
   ```
   CONNECTED ──(连续2次超时/断开)──→ DEGRADED
   DEGRADED ──(指数退避重连:1s,2s,4s,max30s)──→ RECONNECTING
   RECONNECTING ──(成功)──→ CONNECTED
   RECONNECTING ──(30s内未成功)──→ DEGRADED (保持降级，继续重试)
   ```
   - 状态切换时先完成/取消所有 in-flight 请求
   - 降级期间走 `withFileLock`

4. **降级路径**：
   - 连接/发送/超时失败 → 自动回退 `withFileLock`
   - `PI_MUTATION_PROXY_DISABLE=1` → 强制永久降级
   - 降级日志: `log.warn`

5. **核心 API**：
   - `createMutationClient(roomDir: string): MutationClient`
   - `client.send<T>(command, params): Promise<T>`
   - `client.getState(): 'connected' | 'degraded' | 'reconnecting'`
   - `client.disconnect()`: 优雅断开

**依赖**: Task 1
**测试**: Task 8

---

### Task 5: Owner 生命周期 + 短路优化 (index.ts)

**预计改动**: ~60 行（修改 index.ts）

**内容**:

1. **session_start**：
   - owner role → 启动 `MutationProxy` server
   - 存储 proxy 实例到 activeRoom 上下文中
   - 设置全局 `mutationClient` 为本地短路模式（reviewer Finding 5）

2. **session_shutdown**：
   - 优雅关闭 proxy server
   - 等待队列清空（最多 10s）

3. **Owner 端短路**（reviewer Finding 5）：
   - Owner 进程内的 write 调用（watchdog reconciliation, lifecycle turn_start/end, shutdown）不走 socket
   - 直接调用 `proxy.enqueue(fn)` 使用同一 PQueue

4. **Agent 端**：
   - 连接 owner 的 proxy socket
   - 走正常 socket 路径

**依赖**: Task 3, 4
**测试**: Task 9

---

### Task 6: Storage 层集成 (storage.ts)

**预计改动**: ~50 行（修改 storage.ts）

**内容**:

1. 修改 `withRoomMutationLock`：检测 proxy → 走 proxy → 失败走 fileLock
2. Owner 端检测: `isOwnerProcess()` → 短路调用本地 `proxy.enqueue(fn)`
3. 幂等重试（reviewer Finding 2）：降级重试前检查消息 ID 是否存在
4. 公开的函数签名不变

**依赖**: Task 4, 5
**测试**: Task 9

---

### Task 7: Proxy Server 单元测试 (mutation-proxy.test.ts)

**预计改动**: ~130 行

**内容**:
- Server 启动/停止（含残留 socket 清理）
- 命令处理（append_message, update_member, write_metadata）
- 并发 10 请求 → 验证顺序执行
- 大消息帧（含多行内容）→ 验证不截断
- PQueue 队列满拒绝
- 优雅关闭

**依赖**: Task 3

---

### Task 8: Proxy Client 单元测试 (mutation-client.test.ts)

**预计改动**: ~120 行

**内容**:
- 正常代理通信（帧编解码验证）
- 降级→重升级状态机
- 连接管理（复用、断线重连）
- 超时处理（5s）
- 错误处理（ECONNREFUSED, JSON 解析错误）
- PI_MUTATION_PROXY_DISABLE 强制降级

**依赖**: Task 4

---

### Task 9: 集成测试

**预计改动**: ~100 行

**内容**:
- 端到端：启动 proxy → agent 写入 → 验证文件内容
- Fallback：proxy 未启动 → 降级文件锁 → 正常写入
- 并发正确性：10 并发写入，数据一致
- Proxy 崩溃恢复：kill proxy → 降级 → 验证数据完整
- Owner 生命周期：session_start/shutdown 集成

**依赖**: Task 5, 6

---

### Task 10: 文档 + 回滚验证

**预计改动**: ~30 行

1. ADR status: Proposed → Accepted
2. 回滚脚本验证
3. 确保 lock.ts 全实施过程中未被修改

---

## 执行顺序

```
Task 1 (types) ────────────────────────────────────────────┐
  │                                                         │
  ├── Task 2 (p-queue) ──┐                                 │
  │                       │                                 │
  ├── Task 3 (server) ────┤                                 │
  │   │                   │                                 │
  │   └── Task 7 (server test) ──┐                         │
  │                               │                         │
  ├── Task 4 (client) ────────────┤                         │
  │   │                           │                         │
  │   ├── Task 8 (client test) ───┤                         │
  │   │                           │                         │
  │   ├── Task 5 (owner lifecycle)┤                         │
  │   │   │                       │                         │
  │   │   └── Task 6 (storage) ───┤                         │
  │   │                           ├── Task 9 (integration)  │
  │   │                           │                         │
  └───┴───────────────────────────┴── Task 10 (docs)       │
```

### 并行分组

| Phase | Tasks | 可并行 |
|-------|-------|--------|
| 1 | Task 1, 2 | ✅ |
| 2 | Task 3, 4 | ✅ （server 和 client 独立） |
| 3 | Task 7, 8 | ✅ （各自测试独立） |
| 4 | Task 5 | 依赖 3, 4 |
| 5 | Task 6 | 依赖 4, 5 |
| 6 | Task 9 | 依赖 5, 6 |
| 7 | Task 10 | 依赖全部 |

---

## 测试策略

### 关键场景

| 场景 | 预期 | 优先级 |
|------|------|--------|
| Owner 正常启动 proxy | socket 文件创建，接受连接 | P0 |
| Agent 通过 proxy 写入（含多行内容） | 数据正确，帧不截断 | P0 |
| proxy 不可用时 fallback | Owner 侧在未注册 agent mutation client 时仍可回落文件锁；agent bootstrap / agent-side storage 在已注册 client 但 proxy 不可用时快速失败 | P0 |
| 并发写入 (10x) | 顺序执行，数据一致 | P0 |
| 降级后自动重升级 | owner 重启后 agent 恢复 proxy | P0 |
| PQueue 超时 | 10s 超时，agent 降级 | P1 |
| 队列满拒绝 | >100 pending → 返回错误 | P1 |
| proxy 优雅关闭 | 队列清空，socket 清理 | P1 |
| PI_MUTATION_PROXY_DISABLE=1 | 强制 agent-side hard fail，不再作为 member bootstrap 的零停机文件锁回滚 | P1 |

---

## 回滚方案

1. **即时运行时回滚**: 仅 owner 侧无已注册 agent mutation client 的路径还能回落文件锁；对 member bootstrap，`export PI_MUTATION_PROXY_DISABLE=1` 会阻止 agent-side storage join
2. **代码回滚**: 恢复 storage.ts + index.ts，删除新增 5 文件
3. **安全带**: lock.ts 完全不变
