# Paseo Backend agentLost 检测优化

> **For Agent:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 watchdog 通过 paseo daemon 直接查询 agent 状态（而非依赖共享进程 PID 的心跳文件），从而可靠检测 paseo 后端 agent 的丢失。

**Architecture:** 在 `RoomSpawnAdapter` 接口增加可选 `checkLiveness` 方法，paseo adapter 通过 daemon client 查询 agent 状态，watchdog 对 paseo 后端优先使用 daemon 查询替代无效的 `isProcessAlive(Number(runtimeId))` 判定。

**Tech Stack:** TypeScript, Vitest

---

## 背景

当前 paseo agent 的存活判定存在盲区：

```typescript
// watchdog.ts reconcileMemberLiveness
const runtimeAlive = current.runtimeId
    ? isProcessAlive(Number(current.runtimeId))     // runtimeId 是 UUID → Number() → NaN → false
    : (current.backend === "pi" ? false : true);    // 回退: optimistic true

const isLive = (hbFresh && hbPidAlive) || (!hbFresh && fallbackFresh && runtimeAlive);
```

- `hb.pid` = paseo server PID（所有 agent 共享）→ `hbPidAlive` 永远 true
- `runtimeAlive` = `isProcessAlive(NaN)` → 永远 false
- `isLive` 仅依赖 `hbFresh`（心跳文件新鲜度）
- 如果 agent session 关闭但 paseo server 仍运行，心跳可能在短暂继续写入 → 无法可靠检测 agentLost

`paseo ls --json` 返回每个 agent 的 `status`：`"running"` | `"idle"` | `"closed"`。其中 `"closed"` 明确表示 agent 已结束。用 daemon 查询替代进程 PID 检查可获得可靠状态。

---

### Task 1: 扩展 PaseoDaemonHelpers 类型，增加 getAgent

**Files:**
- Modify: `/home/thn/.pi/agent/extensions/subagent/spawn.ts:65-70`

**Step 1: 增加 `getAgent` 到接口定义**

```typescript
// 修改前
interface PaseoDaemonHelpers {
	connectToDaemon: (options?: { host?: string }) => Promise<{
		createAgent: (options: Record<string, unknown>) => Promise<{ id: string; model?: string }>;
		cancelAgent?: (agentId: string) => Promise<void>;
		deleteAgent?: (agentId: string) => Promise<void>;
		close?: () => Promise<void>;
	}>;
}

// 修改后
interface PaseoDaemonHelpers {
	connectToDaemon: (options?: { host?: string }) => Promise<{
		createAgent: (options: Record<string, unknown>) => Promise<{ id: string; model?: string }>;
		cancelAgent?: (agentId: string) => Promise<void>;
		deleteAgent?: (agentId: string) => Promise<void>;
		getAgent?: (agentId: string) => Promise<{ status: string } | null>;
		close?: () => Promise<void>;
	}>;
}
```

**Step 2: 运行测试确认编译通过**

```bash
cd /home/thn/.pi/agent/extensions/subagent && npx tsc --noEmit 2>&1
```

`getAgent` 是可选的 (`?`)，不影响现有调用。

---

### Task 2: 扩展 RoomSpawnAdapter 接口，增加 checkLiveness

**Files:**
- Modify: `/home/thn/.pi/agent/extensions/subagent/types.ts` — `RoomSpawnAdapter` 接口

**Step 1: 增加可选方法**

在 `RoomSpawnAdapter` 接口末尾增加：

```typescript
export interface RoomSpawnAdapter {
	kind: RoomBackend;
	isAvailable?: (ctx: RoomExecutionContext) => Promise<boolean>;
	spawn: (request: SpawnMemberRequest) => Promise<SpawnMemberResult>;
	stopKeepsRuntime?: boolean;
	stop?: (member: RoomMemberState) => Promise<void>;
	remove?: (member: RoomMemberState) => Promise<void>;
	/** Check whether this member's runtime is still alive.
	 *  Returns true if alive, false if dead/gone.
	 *  If not implemented, watchdog falls back to PID-based checks. */
	checkLiveness?: (member: RoomMemberState) => Promise<boolean>;  // ← 新增
}
```

**Step 2: 编译检查**

```bash
cd /home/thn/.pi/agent/extensions/subagent && npx tsc --noEmit 2>&1
```

---

### Task 3: 为 createPaseoPiMemberAdapter 实现 checkLiveness

**Files:**
- Modify: `/home/thn/.pi/agent/extensions/subagent/spawn.ts` — `createPaseoPiMemberAdapter` 函数

**Step 1: 实现 checkLiveness**

在 `createPaseoPiMemberAdapter` 返回对象中，`remove` 方法之后增加：

```typescript
async checkLiveness(member: RoomMemberState): Promise<boolean> {
    if (!member.runtimeId) return false;
    try {
        const helpers = await loadPaseoDaemonHelpers();
        const client = await helpers.connectToDaemon({ host: process.env.PASEO_HOST });
        try {
            // Guard: if daemon hasn't implemented getAgent yet, fall back to optimistic.
            // This prevents mass false-positive agentLost when extension deploys before daemon.
            if (typeof client.getAgent !== "function") return true;
            const agent = await client.getAgent(member.runtimeId);
            // Agent not found in daemon → dead
            if (!agent) return false;
            // status is "closed" → dead; "running"/"idle" → alive
            return agent.status !== "closed";
        } finally {
            await client.close?.().catch(() => {});
        }
    } catch (error) {
        // If daemon is unreachable, fall back to optimistic (don't mark as lost on transient error)
        consoleError("spawn", "paseo checkLiveness failed", {
            memberName: member.name,
            runtimeId: member.runtimeId,
            error: String(error),
        });
        return true;
    }
},
```

**Step 2: 编译检查**

```bash
cd /home/thn/.pi/agent/extensions/subagent && npx tsc --noEmit 2>&1
```

---

### Task 4: 修改 watchdog 的 isLive 判定，paseo 后端优先用 adapter.checkLiveness

**Files:**
- Modify: `/home/thn/.pi/agent/extensions/subagent/watchdog.ts:463-476`

**Step 1: 替换 runtimeAlive 计算**

```typescript
// 修改前 (L463-465)
const runtimeAlive = current.runtimeId
    ? isProcessAlive(Number(current.runtimeId))
    : (current.backend === "pi" ? false : true);

// 修改后
let runtimeAlive: boolean;
if (current.backend === "paseo") {
    const adapter = getAdapter(current, adapters);
    if (adapter.checkLiveness) {
        runtimeAlive = await adapter.checkLiveness(current);
    } else {
        // Fallback: for paseo without checkLiveness, trust heartbeat freshness
        runtimeAlive = true;
    }
} else if (current.runtimeId) {
    runtimeAlive = isProcessAlive(Number(current.runtimeId));
} else {
    runtimeAlive = current.backend === "pi" ? false : true;
}
```

**注意**：`checkLiveness` 在 `withRoomMutationLock` 内部调用。这是一个 async 调用，可能稍慢（daemon RPC），但它是在锁内部——需要考虑对锁持有时间的影响。paseo daemon 是本地连接，RPC 延迟通常 < 50ms，可以接受。

**Step 2: 编译检查**

```bash
cd /home/thn/.pi/agent/extensions/subagent && npx tsc --noEmit 2>&1
```

---

### Task 5: 更新或新增测试

**Files:**
- Modify: `/home/thn/.pi/agent/extensions/subagent/watchdog.test.ts`

**Step 1: 新增 checkLiveness 相关测试用例**

在 watchdog.test.ts 末尾增加测试：

```typescript
describe("paseo checkLiveness integration", () => {
    it("uses adapter.checkLiveness for paseo backend when available", async () => {
        // Setup: paseo member with checkLiveness adapter
        const member: RoomMemberState = {
            name: "paseo-worker",
            type: "worker",
            backend: "paseo",
            runtimeId: "agent-uuid-123",
            state: "running",
            currentTask: "task X",
            currentTaskMessageId: "msg-1",
            lastCompletedTask: null,
            lastError: null,
            lastSeenSeq: 0,
            joinedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            sessionId: "session-1",
            spawnTaskId: null,
        };

        const adapter: RoomSpawnAdapter = {
            kind: "paseo",
            async spawn(req) {
                return { runtimeId: "agent-uuid-123", backend: "paseo" };
            },
            async checkLiveness(_m) {
                return false; // agent is closed
            },
        };

        // Verify adapter.checkLiveness is called for paseo
        expect(adapter.checkLiveness).toBeDefined();
        const result = await adapter.checkLiveness!(member);
        expect(result).toBe(false);
    });

    it("falls back to PID check for pi backend without checkLiveness", () => {
        // pi adapter doesn't implement checkLiveness
        const adapter: RoomSpawnAdapter = {
            kind: "pi",
            stopKeepsRuntime: false,
            async spawn(req) {
                return { runtimeId: String(process.pid), backend: "pi" };
            },
        };
        expect(adapter.checkLiveness).toBeUndefined();
    });
});
```

**Step 2: 运行测试**

```bash
cd /home/thn/.pi/agent/extensions/subagent && npx vitest run watchdog.test.ts
```

预期：全部 PASS

---

### Task 6: 运行完整测试套件

```bash
cd /home/thn/.pi/agent/extensions/subagent && npx vitest run
```

---

### Task 7: 提交

```bash
cd /home/thn/.pi/agent
git add extensions/subagent/spawn.ts extensions/subagent/types.ts extensions/subagent/watchdog.ts extensions/subagent/watchdog.test.ts
git commit -m "feat: paseo backend agentLost detection via daemon checkLiveness

Add optional checkLiveness method to RoomSpawnAdapter. Paseo adapter
implements it by querying the daemon for agent status (closed = dead).
Watchdog uses this for paseo-backend members instead of the broken
isProcessAlive(Number(runtimeId)) check that always failed on UUIDs.

This enables reliable agentLost detection when a paseo agent session
closes without the agent explicitly stopping."
```

---

## 影响分析

### 行为变化

| 场景 | 修改前 | 修改后 |
|------|--------|--------|
| paseo agent session 关闭 | 依赖心跳文件停止写入（可能延迟） | daemon 直接返回 `"closed"` → agentLost ✅ |
| paseo agent 正常运行 | 心跳文件 + optimistic | daemon 返回 `"running"/"idle"` → alive ✅ |
| paseo daemon 不可达 | (不适用) | checkLiveness catch → optimistic true（不误杀） |
| pi backend agent | PID 检查 | 不变（`adapter.checkLiveness` 未定义，走原逻辑） |

### 不受影响

- pi 后端的 PID 检查逻辑
- 心跳文件写入和读取
- self-heal 逻辑
- spawn / stop / remove 操作
- `mail_tasks` / `mail_members` 工具
