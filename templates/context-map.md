# templates/ — bundled prompt templates

Bundled prompt-template root (the default for `FORGEROOM_TEMPLATE_ROOT`). A workflow step's `prompt_template` is a path relative to this directory; `StepCollaborators.renderPrompt` loads the file, interpolates `{{...}}` placeholders, then writes the per-step prompt under the worktree's `.forgeroom/prompts/`.

See [Docs/concepts/prompt-file-protocol.md](../Docs/concepts/prompt-file-protocol.md) for the protocol and the `{{...}}` substitution rules.

## Placeholders

- `{{step_id}}`, `{{step_index}}` — always provided by the renderer.
- any key from the step's `input_refs` / `vars` (the DSL `${...}` layer is already evaluated into these).
- unknown `{{key}}` → render fails fast (no broken prompt is shipped).

## Files

| Template | Used by (configs/workflows.yaml) |
|---|---|
| `implementation_plan.md` | plan steps (emits `## Slices`) |
| `refine_plan.md` | plan refine |
| `slice_impl.md` | per-slice implement (`{{slice}}`) |
| `execute.md` | single-shot execute |
| `final_review.md` | review (`Review Result: pass/fail`) |
| `final_refine.md` | review-loop refine |
| `hotfix.md` | hotfix execute |
| `review_hotfix.md` | hotfix review |
