# Codex discussion pattern

How to run design/decision discussions with codex. Default for any non-trivial decision.

## Live via cmux (preferred)

Do **not** call `codex exec` directly in Bash. Run codex in a cmux pane so the user watches the dialog live.

1. Spawn codex in a right pane of the current workspace:
   `cmux new-split right --workspace <W>` then `cmux move-surface --surface <codex-surface> --pane <new-pane>` — or `cmux new-workspace --command codex`.
2. Iterate via `cmux send` + `cmux read-screen --scrollback`.
3. Set up the right-pane codex **before** asking anything, so the user sees it from question 1.

## Question format

Each round, ask codex for: **verdict + confidence (0–100) + resolution + conflict** per question.

## Resolution

- Confidence ≥80 → resolve inline (update ADRs / CONTEXT.md / glossary / module specs).
- Confidence <80 → batch into a single final `AskUserQuestion` to the user.
