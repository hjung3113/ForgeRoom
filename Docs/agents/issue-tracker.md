# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues on `hjung3113/ForgeRoom`. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Per-issue workflow override (`workflow:<id>` label)

The GitHub poller dispatches every open issue carrying the trigger label (`ready-for-agent`). By default the run uses the project's `default_workflow`. To override per issue, add a `workflow:<id>` label (e.g. `workflow:full` for a plan→implement→review run, `workflow:quick` for plan→implement).

- Exactly one `workflow:<id>` label → that workflow (the core engine still validates `<id>` against the project's `allowed_workflows`; an unknown id fails the task with `workflow_not_allowed`).
- No `workflow:<id>` label → project `default_workflow`.
- Multiple distinct `workflow:<id>` labels → ambiguous; ignored with a warning, falls back to the default.

Use `workflow:full` on self-improvement issues so the review step catches regressions.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
