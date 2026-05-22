## Dependency Handling

This task depends on upstream task(s) `{input:#N}`. The system will send you an "All dependencies ready for task #N" notification when all upstream tasks are complete.

When you receive that notification:
1. Use `crew_read(seq=N)` to read the full content of each upstream task. (For multiple deps like `{input:#5, #7}`, read each one separately.)
2. Do NOT report your own completion until ALL dependencies are complete.
3. If any upstream task fails or is cancelled, the system will notify you — reply with `kind="error"`.
