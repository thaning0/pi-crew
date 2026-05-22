# pi-crew

Multi-agent crew orchestration extension for pi — spawn subagents, assign tasks, coordinate collaboration via a persistent room with git worktree isolation.

## Install

```bash
pi install git:https://github.com/thaning0/pi-crew.git@v1.0.0
```

## Usage

Add subagents and assign tasks through the room interface:

```bash
# In pi chat:
crew_add { name: "worker", type: "worker", task: "Implement the login page" }
crew_tell { to: "worker", summary: "Add error handling", kind: "task" }
```

See [pi-crew docs](https://github.com/thaning0/pi-crew) for full API.
