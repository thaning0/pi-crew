# Subagent Mail / Room / Worktree Fixes Implementation

**Status:** Implemented on 2026-05-05.

**Related plan:** [plans/2026-05-05-subagent-mail-room-worktree-fixes.md](./plans/2026-05-05-subagent-mail-room-worktree-fixes.md)

## Summary

This change set completed the three scoped fixes from the implementation plan without changing the public tool surface:

1. `mail_send` and `mail_reply` now tolerate unresolved summary `@mentions`.
2. The owner-room initialization message is persisted on the board but treated as silent for unread delivery.
3. Agent frontmatter now supports `worktree: true|false`, defaulting to `false`.

## Implemented Changes

### 1. Summary mention resolution no longer blocks send/reply

- `extensions/subagent/tools.ts` now resolves extracted summary mentions through the existing member-target resolver before calling `appendMessage(...)`.
- Summary mention extraction now preserves copy-pasteable member labels such as `@worker#1234`, so label-based disambiguation works the same way as direct target resolution.
- The same canonicalized mentions are now preserved for directed task sends and spawn initial tasks, but they remain mention metadata only; the explicit `to` member stays the sole task assignee.
- Resolved mentions are canonicalized to internal member names.
- Unresolved or ambiguous mentions are dropped from the persisted `mentions` array and surfaced as warnings in tool output instead of raising validation errors.
- The original summary text is preserved exactly as entered.

### 2. Owner-room initialization is persisted but silent

- `extensions/subagent/types.ts` adds the optional `silent` field to `RoomMessage`.
- `extensions/subagent/storage.ts` now persists `silent: true` on board entries.
- `extensions/subagent/owner-room.ts` writes the initial `Room initialized: <roomId>` board entry with `silent: true`.
- `extensions/subagent/lifecycle.ts` advances `lastSeenSeq` for silent unread messages without delivering them.
- `extensions/subagent/dispatch.ts` also treats silent messages as non-deliverable as a defensive guard.
- `mail_list` still reads the board entry normally because board persistence is unchanged.

### 3. Agent worktree creation is now opt-in

- `extensions/lib/agents.ts` now parses a `worktree` boolean from agent frontmatter and defaults it to `false` when omitted.
- `extensions/subagent/tools.ts` now creates a dedicated worktree only when the parsed agent definition sets `worktree: true`.
- Existing agents keep the previous non-dedicated behavior unless they explicitly opt in.

## Tests Added Or Updated

- `extensions/subagent/room-feasibility.test.ts`
  - unresolved mention coverage for `mail_send`
  - display-label summary mention coverage for `mail_send`
  - ambiguous summary mention warning coverage for `mail_send`
  - directed task coverage for persisted valid summary mentions
  - unresolved mention coverage for `mail_reply`
  - display-label summary mention coverage for `mail_reply`
  - ambiguous summary mention warning coverage for `mail_reply`
  - silent initialization message remains visible via `mail_list`
- `extensions/subagent/lifecycle.test.ts`
  - silent initialization messages do not produce steer delivery
  - silent initialization messages remain persisted on the board
- `extensions/subagent/dispatch.test.ts`
  - directed task mention metadata does not retarget side-mentioned members
- `extensions/subagent/bootstrap.test.ts`
  - default `worktree` parsing behavior
  - explicit `worktree` frontmatter parsing
- `extensions/subagent/spawn.test.ts`
  - worktree creation only when the agent explicitly enables it
  - spawn initial task mention canonicalization and warning behavior
  - spawn initial task display-label summary mention coverage

## Validation

The following validation commands were run successfully:

- `cd /home/thn/.pi/agent/extensions/subagent && npx vitest run room-feasibility.test.ts -t "unresolved mentions"`
- `cd /home/thn/.pi/agent/extensions/subagent && npx vitest run room-feasibility.test.ts -t "display labels inside summary mentions"`
- `cd /home/thn/.pi/agent/extensions/subagent && npx vitest run room-feasibility.test.ts -t "directed tasks"`
- `cd /home/thn/.pi/agent/extensions/subagent && npx vitest run room-feasibility.test.ts -t "ambiguous summary mentions"`
- `cd /home/thn/.pi/agent/extensions/subagent && npx vitest run spawn.test.ts -t "spawn initial tasks"`
- `cd /home/thn/.pi/agent/extensions/subagent && npx vitest run spawn.test.ts -t "display labels inside spawn initial task summary mentions"`
- `cd /home/thn/.pi/agent/extensions/subagent && npx vitest run dispatch.test.ts`
- `cd /home/thn/.pi/agent/extensions/subagent && npx vitest run bootstrap.test.ts spawn.test.ts -t "worktree"`
- `cd /home/thn/.pi/agent/extensions/subagent && npx vitest run spawn.test.ts -t "persists paseo runtime"`
- `cd /home/thn/.pi/agent/extensions/subagent && npx vitest run lifecycle.test.ts room-feasibility.test.ts -t "silent"`
- `cd /home/thn/.pi/agent/extensions/subagent && npx vitest run lifecycle.test.ts -t "activateBootstrapRoom|compatibility guards"`
- `cd /home/thn/.pi/agent/extensions/subagent && npx vitest run`

## Notes

- This implementation intentionally does not broaden mention tokenization rules; it only prevents unresolved candidates from blocking mail operations.
- For directed tasks and spawn initial tasks, `mentions[]` is preserved for context and visibility but does not add extra task assignees beyond `to`.
- No existing agent was changed to opt into dedicated worktrees by default.