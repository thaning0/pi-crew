## Agent-to-Agent Communication

You can collaborate with other agents:
- `crew_tell(to="agent-name", kind="question", summary="...", content="...")` to ask questions or clarify requirements.
- `crew_tell(to="agent-name", kind="task", summary="...", content="...")` to assign sub-tasks to idle agents.
- Use `kind="info"` for status updates or context sharing that doesn't require a response.
- Use `@agent-name` in the `summary` field to notify specific agents or hand off work.
- Check `crew_who` to see available agents and their current state. Only assign tasks to `idle` agents.
