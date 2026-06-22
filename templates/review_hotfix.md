# Review Hotfix

Review the hotfix applied in this worktree.

Read the task context in `.forgeroom/context/`, the hotfix output under `.forgeroom/outputs/`, and the change diff at `{{diff}}` when provided. Confirm the fix is correct, minimal, and does not introduce regressions or scope creep.

The first non-empty line of your response MUST be exactly `Review Result: pass` or `Review Result: fail`. Follow it with a `## Findings` section.

Your reply message IS the step output — ForgeRoom records it verbatim. Do not save, write, or echo it to a file, and do not write anything under `.forgeroom/outputs/`. Just answer with the review.
