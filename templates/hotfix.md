# Hotfix

Apply a focused fix for this task in the worktree.

Read the task context in `.forgeroom/context/`. Identify the smallest correct change that resolves the reported problem. Follow the repository's `AGENTS.md` / `CLAUDE.md` conventions and do not refactor unrelated code. Ensure the project still builds and its checks pass.

Summarize the fix and write it to `.forgeroom/outputs/{{step_index}}_{{step_id}}.md`.
