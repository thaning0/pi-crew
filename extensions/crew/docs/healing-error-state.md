# Error State 自愈与恢复路径设计

> 状态：proposed | 日期：2026-05-01 | 作者：Pi Agent Orchestrator

## 1. 问题描述

### 1.1 现象

`researcher-crewai`（paseo 后端）在正常完成任务后被 watchdog 标记为 `error`：

```
state: "error"
lastError: "Member runtime is not alive."
runtimeId: null
sessionId: null
```

但实际进程正常存活：

```
$ ps -p 40614 -o pid,comm,state
  PID COMMAND         S
40614 MainThread      S
```

心跳文件持续更新：

```json
{"memberName":"researcher-crewai","updatedAt":"2026-05-01T19:20:26.837Z","pid":40614}
```

因 `runtimeId=null && sessionId=null`，系统拒绝向该 agent 发送任何消息：

```
> crew_tell({to: "researcher-crewai", summary: "..."})
Error: Member researcher-crewai is not available.
```

Agent 活着但被系统永久隔离 —— 无自动恢复、无手动恢复（只能 stop + spawn 重建）。

### 1.2 影响的触发条件

1. paseo 后端 agent 完成一轮任务后 `runtimeId` 被清（paseo daemon 管理 agent 生命周期，runtimeId 在 Pi 侧可能异步变 null）
2. 下次 `reconcileMemberLiveness` 运行时，因 `runtimeId` 和 heartbeat PID 之间的短暂窗口，误判 agent 死亡
3. 标记 `error` 时清空 `runtimeId` 和 `sessionId`
4. `assertDirectedTargetAvailable` 拒绝任何无 `runtimeId` 或无 `sessionId` 的目标

## 2. 根因分析

三层缺陷叠加：

### 2.1 状态机缺少自愈路径

```
        spawning ──→ idle ──→ running ──→ idle
            │                     │
            └──→ error ←──────────┘
                  │
                  └── (终点，无出路)
```

`error` 是吸收态。即使 agent 恢复健康，系统没有从 `error` 回到 `idle` 的自动或手动路径。

### 2.2 存活判定对 paseo 后端不精确

```typescript
// 当前逻辑
const runtimeAlive = current.runtimeId
    ? isProcessAlive(Number(current.runtimeId))
    : (current.backend === "pi" ? false : true);
```

paseo 后端 `runtimeId` 为 null 时直接返回 `true`，但后续 `isLive` 综合判断仍可能失败（heartbeat PID 与 runtimeId 不一致时的边界条件）。

### 2.3 消息可用性检查过度严格

```typescript
if (target.state !== "spawning" && (!target.runtimeId || !target.sessionId)) {
    throw new Error(`Member ${target.name} is not available.`);
}
```

此检查的原始意图是"没有运行句柄的 agent 无法接收消息"，但它忽略了：
- paseo agent 的 runtime 句柄在 daemon 侧，Pi 侧可以为 null
- heartbeat PID 可作为 agent 仍然可达的独立证据

## 3. 设计方案

### 3.1 核心原则

> `error` 是**瞬时故障记录**，不是**永久死亡判决**。只要 agent 有心跳，它就应被视为可达且可自我恢复。

### 3.2 状态机修改

```
        spawning ──→ idle ──→ running ──→ idle
            │         ↑          │           ↑
            └──→ error ──────────┘           │
                  │                          │
                  └──→ (自愈检测) ────────────┘
```

新增两条恢复路径：

| 触发条件 | 原状态 | 目标状态 | 触发者 |
|----------|--------|----------|--------|
| error + 心跳恢复 | error | idle | `reconcileMemberLiveness` |
| error + 心跳存活 + 收到新任务 | error | running | `appendMessage` (task) |

### 3.3 详细改动

#### 改动 1：`reconcileMemberLiveness` 增加自愈分支

**文件**：`watchdog.ts`  
**位置**：`reconcileMemberLiveness` 函数内，`if (isLive) return null;` 之前

```typescript
// Self-heal: error-state members whose heartbeat/process is confirmed alive
// should transition back to idle rather than staying permanently broken.
if (current.state === "error" && isLive) {
    const protectedSeq = await getLastDeliverableMessageSeq(
        roomDir, current.name,
    ).catch(() => current.lastSeenSeq);

    const healed: RoomMemberState = {
        ...current,
        state: "idle",
        lastError: null,
        // Preserve the recovered runtime/handles when available.
        runtimeId: current.runtimeId ?? (hb ? String(hb.pid) : null),
        sessionId: current.sessionId ?? (hb ? `hb-${hb.pid}` : null),
        lastSeenSeq: Math.max(current.lastSeenSeq, protectedSeq),
        updatedAt: new Date().toISOString(),
    };
    await writeRoomMemberState(roomDir, healed);
    log.info("member self-healed from error", { memberName: current.name });
    return healed;
}
```

**理由**：`isLive` 综合了 heartbeat freshness、PID aliveness、runtime aliveness 三重检测——如果这些都通过了，没有理由继续认为 agent 处于 error。

#### 改动 2：存活判定强化 paseo 后端

**文件**：`watchdog.ts`  
**位置**：`reconcileMemberLiveness` 内 `isLive` 计算处

```typescript
// Paseo agents may lose runtimeId in the Pi-side record while
// remaining alive on the daemon. Use heartbeat PID as evidence.
const isPaseoAndRecoverable =
    current.backend === "paseo" &&
    !current.runtimeId &&
    hb !== null &&
    isProcessAlive(hb.pid);

const isLive =
    (hbFresh && hbPidAlive) ||
    (!hbFresh && fallbackFresh && runtimeAlive) ||
    isPaseoAndRecoverable;
```

**理由**：paseo daemon 独立管理 agent 生命周期。Pi 侧 `runtimeId: null` 不意味着 agent 死亡。heartbeat PID 是 paseo agent 进程的独立存活证据。

#### 改动 3：放宽 error 状态的可用性检查

**文件**：`storage.ts`  
**位置**：`assertDirectedTargetAvailable` 函数

```typescript
// Before: rigid rejection of any member without runtimeId or sessionId.
// After:  allow error-state members with a live heartbeat to receive messages.
//         This enables the agent to receive a new task and transition to running,
//         or to receive an info/question message while in error.
if (target.state !== "spawning" && !target.runtimeId && !target.sessionId) {
    const hb = await readMemberHeartbeat(roomDir, target.name).catch(() => null);
    const hbAlive =
        hb !== null &&
        Date.now() - Date.parse(hb.updatedAt) <= getMemberHeartbeatStaleMs() &&
        isProcessAlive(hb.pid);

    if (!hbAlive) {
        throw new Error(`Member ${target.name} is not available.`);
    }

    // Recover runtimeId from heartbeat PID so downstream logic
    // (stop, remove, task delivery) has a handle to the process.
    target = {
        ...target,
        runtimeId: String(hb.pid),
        sessionId: target.sessionId ?? `hb-${hb.pid}`,
    };
}
```

**理由**：heartbeat 提供了 agent 存活的独立证据。允许通过 heartbeat 恢复的 agent 接收消息，使得 error→running 自愈路径成为可能。

### 3.4 不做的方案

| 方案 | 为什么不选 |
|------|-----------|
| error 状态直接允许所有消息 | 真正的死 agent（无心跳）不应接收消息，否则任务会丢失 |
| 自动 respawn error agent | 破坏现有上下文，且 paseo daemon 管理的 agent 不应被 Pi 无脑 kill+restart |
| 仅修复 paseo 后端，pi 后端不改 | pi 子进程也可能因临时 I/O 阻塞被误判，统一自愈路径更健壮 |
| 在 error 时不清 runtimeId | 治标不治本——真正的死 agent 需要清 runtimeId 以释放资源 |

## 4. 测试计划

### 4.1 单元/集成测试

| 测试场景 | 预期结果 |
|----------|----------|
| error-state paseo agent + 活心跳 → reconcile | 自动回到 idle，lastError 清空 |
| error-state pi agent + 活心跳 → reconcile | 自动回到 idle |
| error-state agent + 死心跳 → reconcile | 保持 error（无变化） |
| error-state agent + 活心跳 → crew_tell(task) | 成功，agent 进入 running |
| error-state agent + 活心跳 → crew_tell(info) | 成功，agent 保持 error（等 poll 自愈） |
| error-state agent + 活心跳 → crew_tell(task) after reconcile healed | agent 正常 idle→running 流转 |

### 4.2 回归测试

- `messaging.test.ts` — 需要先修复现有失败
- `room-tool.test.ts` — 需要先修复现有失败
- `watchdog.test.ts` — 添加 error→idle 自愈的测试用例
- `spawn.test.ts` — 确认 spawn 失败路径不受影响

## 5. 验收标准

1. `researcher-crewai` 场景不再重现：paseo agent 完成任务的正常心跳窗口内不被误标记 error
2. 若因其他原因进入 error，agent 在下次 `reconcileMemberLiveness` 周期内（默认 200ms poll + 5s stale）自动恢复到 idle
3. error 状态的 agent 只要有心跳，`crew_tell` 成功（不再抛 "not available"）
4. 现有的 error 处理路径（真正 dead agent 的 spawn 失败、孤儿清理）不受影响
5. 现有的 agent 间通信（P2P + broadcast + @mention）行为不变

## 6. 风险与影响

| 风险 | 缓解 |
|------|------|
| 自愈可能掩盖真实的间歇性故障 | `lastError` 在被自愈清除之前写入日志（已有 `log.info("member self-healed")`），且 lead 可通过 `crew_tasks` 的 `agentLost` 状态追踪历史 |
| heartbeat PID 有时效性（进程重启后 PID 变） | 自愈仅在 `isLive` 综合判定通过时触发——如果 PID 变了但心跳没更新，`hbPidAlive` 为 false，不会误自愈 |
| `assertDirectedTargetAvailable` 中的 `readMemberHeartbeat` 增加 I/O | heartbeat 文件小（~60 bytes），在 hot path 上增加的延迟可忽略（同目录下已有多次 fs 操作） |
