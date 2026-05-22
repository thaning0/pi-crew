---
name: room-orchestrator
description: Use when managing multi-agent task orchestration — adding subagents, assigning tasks, monitoring progress, and coordinating collaborative workflows.
---

# Room Orchestrator

Manage multi-agent workflows through a persistent room. You (the owner) spawn subagents, assign tasks, monitor progress, and coordinate their collaboration via the `crew` tools.

**Announce at start:** "I'm using the room-orchestrator skill to coordinate multi-agent work."

- Always check what role is available before adding a member:
- Use `crew_tell` with `kind: "task"` directed to a specific member to assign work, use context for task details and instructions. Return: `<seq>` — the message sequence number. Save this to track the task.
- Always assign tasks to existing `idle` members with appropriate capabilities. Check `crew_who` to verify member state before assigning. Reuse agents when possible to preserve context.
- Agents can receive `info`/`question` messages at any time without affecting their task state, which are pure communication that the agent can read and incorporate into its ongoing work.
- Member status: `spawning` (still being created), `idle` (ready for task), `running` (working in a task), `error` (task blocked), `stopping` (being stopped), `chatting` (agent is in its turn but not executing a task: completing wrap-up after task, or engaging in agent-to-agent/owner conversation).
- Git snapshot fields:
  - `mergeReady: true` — agent has unmerged work waiting
  - `lastMergedOid` — OID of the last merged snapshot (present after first merge)
  - `lastSnapshotAt` / `lastSnapshotSummary` — when/what the last snapshot captured
- Use `crew_tasks` to see all task statuses
- Idle agents have full context of their completed work and can answer domain questions without context-switching cost.
- `crew_stop` stops the agent's current turn and cancels its task if any. The agent transitions back to `idle` (or `chatting` briefly) and CAN accept new tasks immediately. 
- `crew_remove` permanently removes/closes the agent (kill its process). 
- Subagent's todo progress are displayed on the board
- Respect the pace of the subagents' work, tasks may be time-consuming. If there is no progress update for a long time, Use `crew_tell` to send a message to the subagent asking it to reply with its current status before interupting.

### Pattern 0: Batch Templates (Preferred Shortcut)

`crew_batch` provides built-in multi-agent orchestration templates that handle spawn, task assignment, handoff, and cleanup automatically. For common collaboration patterns, prefer these over manual `crew_add` + `crew_tell`.

| Template | Best For |
|---|---|
| `parallel-work-aggregate` | Multiple independent subtasks run in parallel, results aggregated |
| `plan-review-loop` | Produce a plan, iterate with reviewers until approved |
| `implement-review-loop` | Write code, have reviewers check it, iterate until approved |

**Usage:**

```
crew_batch {
  template: "parallel-work-aggregate",
  params: {
    workers: [
      { name: "fe", type: "worker", task: "Implement the frontend login page" },
      { name: "be", type: "worker", task: "Implement the backend /api/login endpoint" }
    ]
  }
}

crew_batch {
  template: "implement-review-loop",
  params: {
    author: { name: "coder", type: "worker" },
    reviewers: [{ name: "rv", type: "code-quality-reviewer" }],
    initialAuthorTask: "Implement a parse_date function in src/utils.py that can handle multiple date formats and timezones.",
    maxRounds: 3
  }
}
```

**When NOT to use batch templates:**
- Single simple task with one agent → Pattern 1
- Complex dependency chains with conditional handoffs → Pattern 2

### Pattern 1: Simple Serial Tasks

Assigns tasks one at a time, waiting for each to complete:

```
crew_add { name: "worker", type: "worker" }
crew_tell { to: "worker", summary: "Task A", kind: "task" }
// Wait for completion
```
- when the worker completes Task A, it sends a `crew_reply` and becomes `idle` again, ready for the next task

### Pattern 2: Auto-Handoff Chain (Agents Pass Work to Each Other)

Agents communicate via `@mention` to trigger the next step without lead intervention. The lead sets up all tasks upfront, embedding handoff instructions in the task content. Use `{input:#N}` in content to declare dependencies on upstream task messages (where N is the upstream task's seq number). When all dependencies complete, the system sends an automatic notification to the downstream agent.

```
crew_add { name: "scout", type: "scout" }
crew_add { name: "planner", type: "planner" }
crew_add { name: "worker", type: "worker" }

// Assign scout's task — tell it to @planner when done
crew_tell {
  to: "scout",
  summary: "Investigate the authentication module",
  kind: "task",
  content: "Investigate the authentication module. When done, reply to this message with your findings in the context."
}

// Simultaneously assign planner's task — tell it to wait for scout's signal
crew_tell {
  to: "planner",
  summary: "Devise OAuth integration plan",
  kind: "task",
  content: "Depends on scout's findings {input:#55}. After receiving system notification, use crew_read to read the dependency details, then @worker when done."
}

// Simultaneously assign worker's task — tell it to wait for planner's signal
crew_tell {
  to: "worker",
  summary: "Implement OAuth", 
  kind: "task",
  content: "Depends on planner's plan {input:#56}. After receiving system notification, use crew_read to read the plan details, then complete the task and reply to this message."
} 
```
**Key points:**
- Assign all tasks upfront — each agent is `running` but waits for its trigger
- Embed `@mention` instructions in task `content`, not `summary`
- Use `{input:#N}` in task content to declare dependencies on upstream task messages
- When all `{input:#N}` placeholders in a task are completed, system sends an automatic "All dependencies ready" info message
- If any upstream was cancelled, the notification says "Dependency cancelled" and prompts the agent to ask lead to re-assign
- If any upstream ended with error, the notification says "Dependency failed" and prompts the agent to check upstream results or reply with `crew_reply kind=error`
- Lead only needs to monitor — no manual handoff required

### Pattern 3: Transient Agents for One-Off Tasks
For quick, one-off tasks that don't require ongoing context, spawn a transient agent, assign the task using `crew_add`. The agent will be auto removed after completing the task and replying. This is ideal for simple, independent tasks that don't warrant a permanent agent.

`crew_add { name: "scout", type: "explorer", task: "Investigate what mature open-source OAuth solutions are available?" }`

### Git Worktrees & Merging

All subagents (including those spawned by `crew_batch`) work in isolated git worktrees. After an agent completes work, check `crew_who` for `mergeReady: true` and merge with `crew_merge { name: "agent-name" }`.

## Red Flags

**Never:**
- Stop/remove a member that still has a task in flight without acknowledging the consequences
- Stop/remove/respawn an agent just to add more context to its task — use `crew_tell kind=info` instead

**Always:**
- Check `crew_roles` before adding a member
- Check `crew_who` to verify member state before assigning tasks
- Save the `seq` returned by `crew_tell` to track task messages
- Proactively communicate with agents via `crew_tell` kind `info` for `question` to clarify requirements, provide feedback, or ask for status updates — this does not affect their task state and keeps them engaged

## logging

- Logs are save in `~/.pi/agent/runtime/rooms/room-<uuid>/agent.log`, which you can check for detailed info and errors. Use `jq` to read structured logs. Log level is set by environment variable `PI_ROOM_LOG_LEVEL` (default `error`, options: `info`, `error`).
- RoomID is in the first message of `crew_messages`.