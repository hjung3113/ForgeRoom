# Implementation Output Contract

You are running an implementation step ({{step_id}}). There are TWO separate
output channels — keep them distinct:

- **Source changes → the worktree.** Make the actual code changes for the
  assigned slice by writing files in the worktree. This is the real deliverable;
  ForgeRoom opens the PR from the worktree's git diff.
- **Narrative (what you changed and why) → your reply message.** ForgeRoom
  records your reply text verbatim as the step output. Do NOT write, save, or
  echo that narrative under `.forgeroom/outputs/` yourself — only ForgeRoom
  writes there. Do not leave your reply empty.
