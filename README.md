





# pi-crew

Multi-agent crew orchestration extension for [pi](https://github.com/earendil-works/pi) — spawn subagents, assign tasks, and coordinate collaboration via a persistent room with git worktree isolation.

## Features

- **Multi-agent rooms** — Create persistent rooms where subagents collaborate via a shared message board
- **8 built-in agent types** — explorer, worker, researcher, planner, advisor, code-quality-reviewer, plan-consistency-reviewer, plan-evaluator
- **Custom agent types** — Define your own subagents via `.md` files in `.pi/crew_agents/` (repo-level) or `~/.pi/crew_agents/` (global)
- **Task management** — Assign tasks, track completion/error/cancellation, with full status visibility
- **Dependency chaining** — `{input:#N}` placeholders enable task-to-task workflows with automatic dependency resolution
- **Git worktree isolation** — Each worker agent gets an isolated branch; snapshots are auto-committed on task completion
- **Snapshot merging** — The lead agent can merge, rebase, or fast-forward agent worktrees back to the main branch
- **Batch templates** — Pre-built orchestration patterns: parallel work, plan-review loops, implement-review loops
- **Two skills included** — `room-orchestrator` (for lead agents) and `room-member` (for subagents) with full workflow guidance
- **Session recovery** — File-system persistence enables recovery across agent restarts
- **Mutation proxy** — Unix-socket based write serialization avoids file-lock contention between concurrent agents

https://github.com/user-attachments/assets/9402942a-4b91-4936-82ef-e122d18623be
https://github.com/user-attachments/assets/1c6a8520-812c-4f67-ad9f-8d6e3c1be9f6

## Install

```bash
pi install git:https://github.com/thaning0/pi-crew.git
```

This registers 4 extensions (`crew`, `builtin-tools`, `todo`, `wait`), 2 skills, and 8 agent prompt templates (plus support for custom agent types).

## Quick Start

Once installed, your pi agent gains access to `crew_*` tools and the `room-orchestrator` skill. Start by spawning a subagent:

```
crew_add { name: "explorer", type: "explorer", task: "Explore the src/ directory and summarize the module structure" }
```

The explorer agent will join the room, execute the task, report back, and auto-remove (transient mode).

### Multi-agent workflow example

```
# 1. Spawn a researcher to gather context
crew_add { name: "researcher", type: "researcher" }

# 2. Assign the research task
crew_tell { to: "researcher", summary: "Research authentication patterns for Node.js", kind: "task", content: "Research best practices for JWT + OAuth in Node.js. Use web_search as needed. When done, @planner with findings." }

# 3. Spawn a planner
crew_add { name: "planner", type: "planner" }

# 4. Spawn a worker for implementation
crew_add { name: "worker", type: "worker" }

# 5. Check status
crew_who {}
crew_tasks {}
```

## Agent Types

| Agent | Role | Thinking | Worktree |
|-------|------|----------|----------|
| `explorer` | Fast read-only code/web exploration | Low | No |
| `worker` | General-purpose with isolated worktree | High | **Yes** |
| `researcher` | Multi-source investigation (code + web) | High | No |
| `planner` | Creates structured implementation plans | High | No |
| `advisor` | Expert guidance and debugging analysis | — | No |
| `code-quality-reviewer` | Code review and quality evaluation | — | No |
| `plan-consistency-reviewer` | Plan consistency verification | — | No |
| `plan-evaluator` | Plan evaluation against success criteria | — | No |

Agent types are defined as Markdown files with YAML frontmatter. You can add custom agent types by creating `.md` files in these directories (searched in priority order):

1. **Repo-level** — `.pi/crew_agents/` (relative to your repo root, **highest priority**)
2. **Global** — `~/.pi/crew_agents/` (available across all projects)
3. **Built-in** — `prompts/agents/` (shipped with pi-crew, lowest priority)

When the same agent type exists in multiple directories, the higher-priority one wins — making it easy to override a built-in agent without modifying the extension.

### Custom agent file format

Create a `.md` file with YAML frontmatter. Example `~/.pi/crew_agents/db-expert.md`:

```markdown
---
name: db-expert
description: Expert in database schema design and SQL optimization
tools: read, grep, find, ls, todo, wait
thinking: high
worktree: false
---

You are a database expert. Your role is to design schemas,
write optimized queries, and review database changes.
```

Then spawn it: `crew_add { name: "db", type: "db-expert" }`

## Crew Commands

### Room orchestration (lead only)

| Tool | Description |
|------|-------------|
| `crew_add` | Spawn a subagent: `{name, type, model?, task?, transient?}` |
| `crew_remove` | Permanently remove a member |
| `crew_merge` | Merge an agent's worktree snapshot: `{name, strategy?, deleteBranchAfterMerge?, commitMessage?}` |
| `crew_batch` | Run a batch orchestration template: `{template, params}` |

### Communication (all members)

| Tool | Description |
|------|-------------|
| `crew_tell` | Send a message to a member, room broadcast, or reply: `{to?, summary, content?, broadcast?, replyTo?, kind?}` |
| `crew_reply` | Reply to a task to report completion or error: `{seq, summary, content?, kind?}` |
| `crew_read` | Read full content of a message by sequence number |

### Status (all members)

| Tool | Description |
|------|-------------|
| `crew_who` | List all room members with current state |
| `crew_tasks` | List tasks with status, filterable |
| `crew_messages` | List recent board messages, filterable |
| `crew_roles` | List available agent types |

### Message kinds

| Kind | Used for |
|------|----------|
| `task` | Assigning work to a member |
| `info` | Sharing context without affecting task state |
| `question` | Asking for clarification |
| `completion` | Reporting successful task completion |
| `error` | Reporting task failure |
| `cancelled` | Cancelling a task |

## Skills

Two skills are included to guide LLM behavior:

### `room-orchestrator`

Loaded automatically for the lead agent. Covers:
- Spawning and managing subagents
- Task assignment patterns (serial, auto-handoff chains, transient agents)
- Batch template usage (`parallel-work-aggregate`, `plan-review-loop`, `implement-review-loop`)
- Git worktree merging strategies
- Dependency chain setup with `{input:#N}`

### `room-member`

Loaded automatically for subagents. Covers:
- Reading and responding to tasks
- Using crew communication tools
- Replying with completion/error status
- Collaborating via `crew_tell`

## Configuration

All configuration is via environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `PI_ROOM_POLL_INTERVAL_MS` | Poll cycle interval for new messages | 2000 |
| `PI_ROOM_DELIVERY_DEBOUNCE_MS` | Debounce for message delivery | 1000 |
| `PI_ROOM_OWNER_HEARTBEAT_INTERVAL_MS` | Owner heartbeat write interval | 1000 |
| `PI_ROOM_OWNER_HEARTBEAT_STALE_MS` | Owner heartbeat stale timeout | 5000 |
| `PI_ROOM_MEMBER_HEARTBEAT_INTERVAL_MS` | Member heartbeat write interval | 1000 |
| `PI_ROOM_MEMBER_HEARTBEAT_STALE_MS` | Member heartbeat stale timeout | 5000 |
| `PI_ROOM_ROOM_SPAWN_JOIN_TIMEOUT_MS` | Spawn join timeout | 120000 |
| `PI_ROOM_LOG_LEVEL` | Log level (`silent`, `default`, `debug`) | `error` |
| `PI_ROOM_PASEO_CLI_PATH` | Override paseo CLI path | auto-detect |

## Architecture

pi-crew extends pi with a room-based multi-agent system:

```
┌──────────────────────────────────────────────────────┐
│  Owner (lead agent)                                   │
│  ┌────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ crew_add   │  │ mutation     │  │ heartbeat    │ │
│  │ crew_merge │  │ proxy server │  │ writer       │ │
│  └────────────┘  └──────┬───────┘  └──────────────┘ │
│                         │ Unix socket                 │
├─────────────────────────┼────────────────────────────┤
│  ~/.pi/agent/runtime/   │                             │
│  rooms/{roomId}/        │                             │
│  ├── room.json          │                             │
│  ├── agent.log          │                             │
│  ├── members/*.json     │                             │
│  ├── messages/*.json    │                             │
│  ├── heartbeats/*.json  │                             │
│  └── locks/mutation.lock│                             │
├─────────────────────────┼────────────────────────────┤
│                         │                             │
│  Member (worker agent)  │   Member (explorer agent)   │
│  ┌──────────────┐       │   ┌──────────────┐          │
│  │ polling loop │◄──────┼───│ polling loop │          │
│  │ crew_reply   │       │   │ crew_tell    │          │
│  │ worktree     │       │   │ (read-only)  │          │
│  └──────────────┘       │   └──────────────┘          │
└──────────────────────────────────────────────────────┘
```

**Key design decisions:**
- **File-system state** — All room state is persisted as JSON files, no external database
- **File-based mutex** — Atomic writes via temp file + rename; mutation proxy serializes concurrent writes
- **Git worktrees** — Workers operate in `/tmp/pi-agent-{name}-{nonce}/` with auto-commit on task completion
- **Dual backend** — Supports both pi child processes and Paseo daemon agents
- **Bootstrap block** — Room context is embedded in each subagent's system prompt for initialization

## Paseo Compatibility
- Version 2.0.0 of this extension requires Paseo >= 0.1.79
- Older versions (1.x) are compatible with Paseo <= 0.1.78

## License

MIT
