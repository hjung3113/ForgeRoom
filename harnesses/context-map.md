# harnesses/ — bundled Step Harness contracts

Bundled Step Harness root (the default for `FORGEROOM_HARNESS_ROOT`). Each file is a harness id (no extension); its content is the harness prompt/output contract.

At task bootstrap, `WorktreeManager` copies each configured harness `<harnessRoot>/<id>` into the worktree at `.forgeroom/harnesses/<id>` (the worktree-relative `source` from `configs/harnesses.yaml`). At render time, `StepCollaborators.renderPrompt` reads the staged contract from `<worktree>/<source>`, interpolates `{{...}}` placeholders, and composes it BEFORE the step prompt template.

See [Docs/concepts/prompt-file-protocol.md](../Docs/concepts/prompt-file-protocol.md) (step 8) and [ADR-027](../Docs/decisions/2026-05-25-027-harness-contract-staging.md).

## Files

| Harness | Contract |
|---|---|
| `planning` | planning/refine output must include a `## Slices` section; write the full response to the output file. |
| `implementation` | produce code changes for the assigned slice; write the full response to the output file. |
| `review` | first non-empty line must be `Review Result: pass`/`fail`; then findings. |

## Placeholders

- `{{step_id}}`, `{{step_index}}` — always provided by the renderer.
- Same `{{...}}` substitution rules as prompt templates; unknown `{{key}}` fails fast.
