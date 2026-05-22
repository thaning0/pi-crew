# Mail & Agents Tool Flattening

> **For Agent:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Flatten the `mail` and `agents` tools from single tools with nested sub-action parameters into separate flat tools, eliminating LLM confusion where agents call non-existent tools like `mail.send`, `mail.reply`, `agents.spawn`.

**Architecture:** Split `mail` into 6 independent tools (`mail_send`, `mail_list`, `mail_reply`, `mail_context`, `mail_members`, `mail_tasks`) and `agents` into 4 independent tools (`agents_spawn`, `agents_stop`, `agents_remove`, `agents_types`). Update all skill files, agent definitions, system prompts, docs, and tests to use the new flat names.

**Tech Stack:** TypeScript, JSON Schema

---

## Background: Why This Matters

Current tool schema (nested):
```
mail  →  { send: {...}, list: {...}, reply: {...}, context: {...}, members: bool, tasks: {...} }
agents → { spawn: {...}, stop: {...}, remove: {...}, types: bool }
```

Skill docs use dot notation as shorthand: `mail.send { ... }`, `agents.spawn { ... }`. LLMs interpret this as literal tool names → call non-existent `mail.send` → error.

After flattening, `mail_send { ... }` is the actual tool name. No ambiguity.

---

### Task 1: Split MailToolSchema into 6 flat schemas

**Files:**
- Modify: `extensions/subagent/schemas.ts:83-131`

**Step 1: Replace MailToolSchema with individual schemas**

Open `schemas.ts`. Replace the entire `MailToolSchema` export with 6 individual schemas:

```typescript
export const MailSendSchema = {
	type: "object",
	properties: {
		to: { anyOf: [{ const: "room" }, { type: "string" }], description: "Target recipient. Use 'room' for board broadcast, or a member name for direct message." },
		summary: { type: "string", description: "One-line message summary displayed on the board." },
		content: { type: "string", description: "Full message body with details." },
		broadcast: { type: "boolean", description: "Notify all active members (owner only)."},
		kind: { enum: ["task", "info", "question", "completion", "error"], description: "Message kind. 'task' assigns work, 'info' shares context, 'question' asks for help, 'completion'/'error' close tasks." },
		replyTo: { type: "string", description: "Message ID to reply to." },
	},
	required: ["summary"],
	additionalProperties: false,
};

export const MailListSchema = {
	type: "object",
	properties: {
		limit: { type: "number", description: "Max messages to show (default 20)." },
		before: { type: "number", description: "Only show messages before this sequence number." },
		filter: { enum: ["all", "me", "task", "completion", "error", "info", "question", "cancelled"], description: "Filter messages by kind or 'me' for messages relevant to you." },
	},
	additionalProperties: false,
};

export const MailReplySchema = {
	type: "object",
	properties: {
		seq: { type: "number", description: "Sequence number of the task message to reply to." },
		summary: { type: "string", description: "One-line result displayed on the board. Include @agent-name to hand off." },
		content: { type: "string", description: "Full report body with details, findings, files changed, etc." },
		kind: { enum: ["completion", "error"], description: "'completion' for success, 'error' for failure." },
	},
	required: ["seq", "summary"],
	additionalProperties: false,
};

export const MailContextSchema = {
	type: "object",
	properties: {
		seq: { type: "number", description: "Sequence number of the message to read." },
	},
	required: ["seq"],
	additionalProperties: false,
};

export const MailMembersSchema = {
	type: "object",
	properties: {},
	additionalProperties: false,
};

export const MailTasksSchema = {
	type: "object",
	properties: {
		limit: { type: "number", description: "Max tasks to show (default 20)." },
		before: { type: "number", description: "Only show tasks before this sequence number." },
		status: { enum: ["running", "completed", "error", "cancelled", "agentLost"], description: "Filter tasks by status." },
	},
	additionalProperties: false,
};
```

Also update the `RoomToolSchema` if it still exists, and the `MailToolSchema` export reference.

> **Note:** `MailContextSchema` adds `required: ["seq"]` which was previously enforced at runtime only (in `executeMailTool`). This is an intentional forward-shift of validation to JSON Schema layer, behavior unchanged.

**Step 2: Update `tools.ts` imports**

```typescript
// Change from:
import { AgentsToolSchema, MailToolSchema } from "./schemas.ts";
// To:
import { AgentsToolSchema, MailSendSchema, MailListSchema, MailReplySchema, MailContextSchema, MailMembersSchema, MailTasksSchema } from "./schemas.ts";
```

**Step 3: Remove `MailToolSchema` export from `tools.ts` re-export line**

```typescript
// Change from:
export { AgentsToolSchema, MailToolSchema };
// To:
export { AgentsToolSchema, MailSendSchema, MailListSchema, MailReplySchema, MailContextSchema, MailMembersSchema, MailTasksSchema };
```

---

### Task 2: Split AgentsToolSchema into 4 flat schemas

**Files:**
- Modify: `extensions/subagent/schemas.ts:62-81`

**Step 1: Replace AgentsToolSchema with individual schemas**

In `schemas.ts`, replace the entire `AgentsToolSchema` export:

```typescript
export const AgentsSpawnSchema = {
	type: "object",
	properties: {
		name: { type: "string", description: "Member name. Must start with letter/number, only [a-z0-9_-] allowed." },
		type: { type: "string", description: "Registered agent type from agents_types list." },
		model: { type: "string", description: "Optional model override." },
		task: { type: "string", description: "Optional initial task to assign immediately on spawn." },
	},
	required: ["name", "type"],
	additionalProperties: false,
};

export const AgentsStopSchema = {
	type: "object",
	properties: {
		name: { type: "string", description: "Name of the member to stop." },
	},
	required: ["name"],
	additionalProperties: false,
};

export const AgentsRemoveSchema = {
	type: "object",
	properties: {
		name: { type: "string", description: "Name of the member to permanently remove." },
	},
	required: ["name"],
	additionalProperties: false,
};

export const AgentsTypesSchema = {
	type: "object",
	properties: {},
	additionalProperties: false,
};
```

Update `tools.ts` import and re-export accordingly.

---

### Task 3: Refactor `executeMailTool` into 6 independent execute functions

**Files:**
- Modify: `extensions/subagent/tools.ts`

**Step 1: Extract `executeMailSend`**

Extract the `params.send` block from `executeMailTool` (approx lines 520-560) into:

```typescript
export async function executeMailSend(
	rawParams: unknown,
	pi: ExtensionAPI,
	ctx: RoomExecCtx,
	runtimeRoot: string,
	adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter },
	options: { beforeDeliverMessage?: (context: { roomDir: string; memberName: string; message: RoomMessage }) => Promise<void> | void },
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
	const params = rawParams as { to?: string; summary: string; content?: string; broadcast?: boolean; replyTo?: string; kind?: RoomMessageKind };
	// validation: summary required
	if (!isNonEmptyString(params.summary)) return textResult("Send requires a non-empty summary.", true);
	// to validation
	if (params.to !== undefined && params.to !== "room" && !isNonEmptyString(params.to)) return textResult("Send target must be 'room' or a non-empty member name.", true);
	if (isNonEmptyString(params.to) && params.to !== "room" && !isValidRoomMemberName(params.to)) return textResult("Member names must start with a letter or number and use only letters, numbers, hyphens, or underscores.", true);
	
	const { sessionId, room } = await resolveRoomAndSession(pi, ctx, runtimeRoot, adapters, options);
	const activeRoom = room ?? getActiveRoom(sessionId);
	if (!activeRoom) return textResult("No active room. Use agents_spawn first.", true);
	// ... rest of send logic
}
```

**Step 2: Extract remaining 5 functions**

Apply the same pattern to: `executeMailList`, `executeMailReply`, `executeMailContext`, `executeMailMembers`, `executeMailTasks`.

Each function:
- Receives flat params (no nesting wrapper)
- Validates only its own subset
- Returns the same text result as before

**Step 3: Remove the old `executeMailTool`**

After all 6 are extracted and working, delete the original `executeMailTool` function.

---

### Task 4: Refactor `executeAgentsTool` into 4 independent execute functions

**Files:**
- Modify: `extensions/subagent/tools.ts`

**Step 1: Extract `executeAgentsSpawn`**

Extract spawn logic with flat params:
```typescript
export async function executeAgentsSpawn(
	rawParams: unknown,
	pi: ExtensionAPI,
	ctx: RoomExecCtx,
	runtimeRoot: string,
	adapters: { pi: RoomSpawnAdapter; paseo: RoomSpawnAdapter },
	options: { ownerName: string; beforeDeliverMessage?: ...; beforeOwnerHeartbeatWrite?: ... },
): Promise<...> {
	const params = rawParams as { name: string; type: string; model?: string; task?: string };
	// validation + spawn logic (same as current params.spawn block)
}
```

**Step 2: 🔴 CRITICAL — Update spawn adapter tools list**

In the spawn logic (current `tools.ts:294`), replace `"mail"` with the 6 flat mail tool names:

```typescript
// Before:
tools: typedAgent.tools
    ? [...typedAgent.tools, "mail"]
    : typedAgent.tools,

// After:
const mailToolNames = ["mail_send", "mail_list", "mail_reply", "mail_context", "mail_members", "mail_tasks"];
tools: typedAgent.tools
    ? [...typedAgent.tools, ...mailToolNames]
    : typedAgent.tools,
```

This ensures the paseo backend receives valid tool names at spawn time (not the obsolete `"mail"`).

**Step 3: Extract remaining functions**

Same pattern for `executeAgentsStop`, `executeAgentsRemove`, `executeAgentsTypes`.

**Step 4: Remove old `executeAgentsTool`**

---

### Task 5: Register new flat tools in `index.ts`

**Files:**
- Modify: `extensions/subagent/index.ts`

**Step 1: Update imports**

```typescript
import {
	MailSendSchema, MailListSchema, MailReplySchema, MailContextSchema, MailMembersSchema, MailTasksSchema,
	AgentsSpawnSchema, AgentsStopSchema, AgentsRemoveSchema, AgentsTypesSchema,
	executeMailSend, executeMailList, executeMailReply, executeMailContext, executeMailMembers, executeMailTasks,
	executeAgentsSpawn, executeAgentsStop, executeAgentsRemove, executeAgentsTypes,
} from "./tools.ts";
```

**Step 2: Replace the single `pi.registerTool("mail", ...)` with 6 registrations**

```typescript
pi.registerTool({
	name: "mail_send",
	label: "Mail Send",
	description: "Send a mail message to a room member or broadcast to the room. For task assignment, use kind: 'task'; for questions, use kind: 'question'; for info, use kind: 'info'.",
	parameters: MailSendSchema,
	async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
		const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		return executeMailSend(rawParams, pi, { ...ctx, currentModel }, runtimeRoot, adapters, { beforeDeliverMessage: options.beforeDeliverMessage }) as any;
	},
});

pi.registerTool({
	name: "mail_list",
	label: "Mail List",
	description: "List recent room messages on the board. Use filter: 'me' to see messages relevant to you.",
	parameters: MailListSchema,
	async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
		const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		return executeMailList(rawParams, pi, { ...ctx, currentModel }, runtimeRoot, adapters, { beforeDeliverMessage: options.beforeDeliverMessage }) as any;
	},
});

pi.registerTool({
	name: "mail_reply",
	label: "Mail Reply",
	description: "Reply to a task message to report completion or error. This closes your current task. Put a one-line result in summary, full report in content. Include @agent-name in summary to hand off.",
	parameters: MailReplySchema,
	async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
		const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		return executeMailReply(rawParams, pi, { ...ctx, currentModel }, runtimeRoot, adapters, { beforeDeliverMessage: options.beforeDeliverMessage }) as any;
	},
});

pi.registerTool({
	name: "mail_context",
	label: "Mail Context",
	description: "Read the full content of a specific message by its sequence number.",
	parameters: MailContextSchema,
	async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
		const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		return executeMailContext(rawParams, pi, { ...ctx, currentModel }, runtimeRoot, adapters, { beforeDeliverMessage: options.beforeDeliverMessage }) as any;
	},
});

pi.registerTool({
	name: "mail_members",
	label: "Mail Members",
	description: "List all non-removed room members with their names, types, and states (idle, running, error, etc).",
	parameters: MailMembersSchema,
	async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
		const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		return executeMailMembers(rawParams, pi, { ...ctx, currentModel }, runtimeRoot, adapters, { beforeDeliverMessage: options.beforeDeliverMessage }) as any;
	},
});

pi.registerTool({
	name: "mail_tasks",
	label: "Mail Tasks",
	description: "List task messages with their current status (running, completed, error, cancelled, agentLost).",
	parameters: MailTasksSchema,
	async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
		const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		return executeMailTasks(rawParams, pi, { ...ctx, currentModel }, runtimeRoot, adapters, { beforeDeliverMessage: options.beforeDeliverMessage }) as any;
	},
});
```

**Step 3: Replace the single `pi.registerTool("agents", ...)` with 4 registrations**

```typescript
pi.registerTool({ name: "agents_spawn", label: "Spawn Agent", ... });
pi.registerTool({ name: "agents_stop", label: "Stop Agent", ... });
pi.registerTool({ name: "agents_remove", label: "Remove Agent", ... });
pi.registerTool({ name: "agents_types", label: "Agent Types", ... });
```

**Step 4: Update `setActiveTools` calls**

In `index.ts`, change all references from `"mail"` and `"agents"` to the flat tool names:

- `session_start` handler: filter out all `agents_*` tools from member sessions
- `before_agent_start` handler: change `"mail"` to all 6 mail tools, `"agents"` to all 4 agents tools
- Agent tools: change to the 6 mail tool names (not the single `"mail"`)

```typescript
// In session_start handler (member filter):
const agentToolNames = ["agents_spawn", "agents_stop", "agents_remove", "agents_types"];
pi.setActiveTools(allTools.filter((name) => !agentToolNames.includes(name)));

// In before_agent_start handler (add mail tools):
const mailToolNames = ["mail_send", "mail_list", "mail_reply", "mail_context", "mail_members", "mail_tasks"];
if (agentDef?.tools && agentDef.tools.length > 0) {
	allowed = [...new Set([...agentDef.tools, ...mailToolNames])];
} else {
	allowed = pi.getAllTools().map((t) => t.name).filter((name) => !agentToolNames.includes(name));
}
```

**Step 5: Update `pi.on("turn_end", ...)` steer message**

In the task closure steer (around line 207), change `mail.reply` to `mail_reply`:

```typescript
content: "You have an unfinished task. Check whether you need to close it by replying with completion or error via mail_reply.",
```

---

### Task 6: Update `bootstrap.ts` system prompts

**Files:**
- Modify: `extensions/subagent/bootstrap.ts:61`

**Step 1: Change `mail.reply` to `mail_reply` in the system prompt**

```typescript
// Before:
`IMPORTANT: When your task is complete, report results via mail.reply — use summary for a one-line result, and content for the full report...`
// After:
`IMPORTANT: When your task is complete, report results via mail_reply — use summary for a one-line result, and content for the full report...`
```

---

### Task 7: Update `spawn.ts` initial task prompt

**Files:**
- Modify: `extensions/subagent/spawn.ts:322`

**Step 1: Change `mail.reply` to `mail_reply`**

```typescript
// Before:
`CRITICAL: When you complete this task, use mail.reply with seq #${...} to report completion.`
// After:
`CRITICAL: When you complete this task, use mail_reply with seq #${...} to report completion.`
```

---

### Task 8: Update Skill Files — `room-orchestrator/SKILL.md`

**Files:**
- Modify: `skills/room-orchestrator/SKILL.md`

**Step 1: Replace all dot-notation references**

Do a global find-and-replace (about 50+ occurrences):

| Old | New |
|-----|-----|
| `mail.send` | `mail_send` |
| `mail.list` | `mail_list` |
| `mail.reply` | `mail_reply` |
| `mail.context` | `mail_context` |
| `mail.members` | `mail_members` |
| `mail.tasks` | `mail_tasks` |
| `agents.spawn` | `agents_spawn` |
| `agents.stop` | `agents_stop` |
| `agents.remove` | `agents_remove` |
| `agents.types` | `agents_types` |

Also update code examples like:
```
// Before:
mail.send { to: "owner", summary: "...", kind: "question" }
// After:
mail_send { to: "owner", summary: "...", kind: "question" }
```

**Step 2: Update narrative text references**

- "Use `mail.send` with `kind: 'task'`" → "Use `mail_send` with `kind: 'task'`"
- "Use `mail.reply` directly as owner" → "Use `mail_reply` directly as owner"
- "Check `agents.types` before spawning" → "Check `agents_types` before spawning"

**Step 3: 🟡 Fix pre-existing doc bug — `context:` should be `content:`**

In line ~230, fix parameter name:
```
// Before:
mail.reply { seq, kind: "completion", summary: "@planner 探查完成", context: "发现了X、Y、Z..." }
// After:
mail_reply { seq, kind: "completion", summary: "@planner 探查完成", content: "发现了X、Y、Z..." }
```

---

### Task 9: Update Skill Files — `room-member/SKILL.md`

**Files:**
- Modify: `skills/room-member/SKILL.md`

**Step 1: Replace all dot-notation (about 30+ occurrences)**

Same replacements as Task 8 but only mail tools (no agents):

| Old | New |
|-----|-----|
| `mail.reply` | `mail_reply` |
| `mail.send` | `mail_send` |
| `mail.list` | `mail_list` |
| `mail.context` | `mail_context` |
| `mail.members` | `mail_members` |

**Step 2: Update intro paragraph**

"All communication happens through the `mail` tool. Use `mail.reply` to close tasks and `mail.send` to ask questions or share updates or allocate task to other idle agents. IMPORTANT: Do not directly reply results to the User, reply with `mail`." →
"All communication happens through the mail tools. Use `mail_reply` to close tasks and `mail_send` to ask questions or share updates or allocate task to other idle agents. IMPORTANT: Do not directly reply results to the User; use the mail tools."

---

### Task 10: Update Agent Definition Files (`/home/thn/.pi/agent/agents/*.md`)

**Files:**
- Modify: `agents/explorer.md`, `agents/worker.md`, `agents/planner.md`, `agents/reviewer.md`, `agents/advisor.md`, `agents/researcher.md`

**Step 1: Each file — replace `mail.reply` with `mail_reply`**

All 6 agent definition files contain a "Task Reporting" section with:
```
mail.reply { seq: <your-task-seq>, summary: "...", kind: "completion", content: "..." }
```

Change to:
```
mail_reply { seq: <your-task-seq>, summary: "...", kind: "completion", content: "..." }
```

And surrounding text: "via `mail.reply`" → "via `mail_reply`".

Total: ~2-3 changes per file, 6 files = ~12-18 occurrences.

---

### Task 11: Update Documentation Files

**Files:**
- Modify: `extensions/subagent/docs/api.md:256`
- Modify: `extensions/subagent/docs/architecture.md:60,80,81`
- Modify: `extensions/subagent/docs/healing-error-state.md:35,216-218,231,239`

**Step 1: `api.md` — replace `mail.reply` with `mail_reply`**

**Step 2: `architecture.md` — replace:**

| Old | New |
|-----|-----|
| `calls mail.reply` | `calls mail_reply` |
| `mail.reply (completion)` | `mail_reply (completion)` |
| `mail.reply (error)` | `mail_reply (error)` |
| `agents.spawn()` | `agents_spawn()` |
| `agents.stop()` | `agents_stop()` |
| `agents.remove()` | `agents_remove()` |

**Step 3: `healing-error-state.md` — replace `mail.send`, `mail.tasks` with `mail_send`, `mail_tasks`**

---

### Task 12: Update Test File

**Files:**
- Modify: `extensions/subagent/bootstrap.test.ts:183`

**Step 1: Change test assertion**

```typescript
// Before:
expect(prompt).toContain("mail.reply");
// After:
expect(prompt).toContain("mail_reply");
```

---

### Task 13: Run Tests and Verify

**Step 1: Run the full test suite**

```bash
cd /home/thn/.pi/agent/extensions/subagent
npx vitest run
```

Expected: All tests pass. If bootstrap.test.ts was the only test with hardcoded `mail.reply`, the main failures would be from incomplete refactoring.

**Step 2: Fix any remaining test failures**

Check for any tests that hardcode tool names `"mail"` or `"agents"` and update them.

**Step 3: Manual verification checklist**

- [ ] `mail_send` tool appears in tool list
- [ ] `mail_reply` tool appears in tool list  
- [ ] `mail_list`, `mail_context`, `mail_members`, `mail_tasks` appear
- [ ] `agents_spawn`, `agents_stop`, `agents_remove`, `agents_types` appear
- [ ] Calling `mail_send({ to: "room", summary: "test" })` works
- [ ] Calling `mail_reply({ seq: 1, summary: "done" })` works
- [ ] Subagent spawned via `agents_spawn` can call `mail_reply`
- [ ] No tool named `mail` or `agents` exists in the tool list

---

### Task 14: Commit

```bash
git add extensions/subagent/schemas.ts
git add extensions/subagent/tools.ts
git add extensions/subagent/index.ts
git add extensions/subagent/bootstrap.ts
git add extensions/subagent/spawn.ts
git add extensions/subagent/docs/
git add skills/room-orchestrator/SKILL.md
git add skills/room-member/SKILL.md
git add agents/*.md
git commit -m "refactor: flatten mail and agents tools into independent flat tools

Split 'mail' into: mail_send, mail_list, mail_reply, mail_context, mail_members, mail_tasks
Split 'agents' into: agents_spawn, agents_stop, agents_remove, agents_types

This eliminates LLM confusion where agents called non-existent tools
like 'mail.send' or 'agents.spawn' due to dot-notation in skill docs
being misinterpreted as tool names.

Updated: schemas, tools, index, bootstrap, spawn, skills, agent defs, docs, tests"
```

---

## Summary of Changed Files

| File | Changes |
|------|---------|
| `schemas.ts` | Split 2 schemas → 10 schemas |
| `tools.ts` | Split 2 execute functions → 10, update imports/exports |
| `index.ts` | Split 2 tool registrations → 10, update setActiveTools |
| `bootstrap.ts` | 1 string: `mail.reply` → `mail_reply` |
| `spawn.ts` | 1 string: `mail.reply` → `mail_reply` |
| `room-orchestrator/SKILL.md` | ~50 occurrences: `mail.*` → `mail_*`, `agents.*` → `agents_*` |
| `room-member/SKILL.md` | ~30 occurrences: `mail.*` → `mail_*` |
| `agents/explorer.md` | ~2 occurrences: `mail.reply` → `mail_reply` |
| `agents/worker.md` | ~2 occurrences |
| `agents/planner.md` | ~2 occurrences |
| `agents/reviewer.md` | ~2 occurrences |
| `agents/advisor.md` | ~2 occurrences |
| `agents/researcher.md` | ~2 occurrences |
| `docs/api.md` | 1 occurrence |
| `docs/architecture.md` | ~6 occurrences |
| `docs/healing-error-state.md` | ~6 occurrences |
| `bootstrap.test.ts` | 1 assertion |

**Total: 18 files modified, 0 files created, 0 files deleted.**
