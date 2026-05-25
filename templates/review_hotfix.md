# Review Hotfix

Review the hotfix applied in this worktree.

Read the task context in `.forgeroom/context/`, the hotfix output under `.forgeroom/outputs/`, and the change diff at `{{diff}}` when provided. Confirm the fix is correct, minimal, and does not introduce regressions or scope creep.

The first non-empty line of your response MUST be exactly `Review Result: pass` or `Review Result: fail`. Follow it with a `## Findings` section.

Write your response to `.forgeroom/outputs/{{step_index}}_{{step_id}}.md`.
