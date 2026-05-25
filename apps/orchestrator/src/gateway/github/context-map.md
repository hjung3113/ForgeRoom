---
status: living
last_reviewed: 2026-05-25
---

# gateway/github/ Context Map

## Responsibility

GitHub-specific gateway code split by adapter role.

## Files

| File | Role |
|---|---|
| `types.ts` | Shared GitHub adapter types and injectable Octokit surface |
| `issue-source.ts` | `GitHubIssueTaskSource`, issue polling, issue-to-task mapping |
| `issue-label-client.ts` | `GitHubIssueLabelClient`, thin issue label API primitives |
| `pull-request-client.ts` | `GitHubPullRequestClient`, thin PR API primitives |

## Dependencies

- External shape: Octokit `rest.issues` and `rest.pulls`
- Internal: `core/types.ts` for `TaskRequest`

## Notes

`../github-gateway.ts` remains the compatibility barrel for existing imports.
