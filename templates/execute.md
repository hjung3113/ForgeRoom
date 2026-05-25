# Execute

Implement the task in this worktree.

Read the task context in `.forgeroom/context/` and any prior step outputs under `.forgeroom/outputs/`. Follow the repository's `AGENTS.md` / `CLAUDE.md` conventions.

Make the actual code changes in the worktree. Keep the change focused on the task; do not refactor unrelated code. Ensure the project still builds and its checks pass.

Summarize what you changed and why, then write that summary to `.forgeroom/outputs/{{step_index}}_{{step_id}}.md`.
