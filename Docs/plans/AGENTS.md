---
status: living
last_reviewed: 2026-05-22
---

# Docs/plans Rules

Read [context-map.md](context-map.md) before editing this folder.

## Core Rules

1. Plans must trace implementation tasks back to canonical docs, ADRs, or open questions.
2. Plans must not change product scope by themselves; scope changes require a proposed ADR first.
3. Every implementation task must identify files, tests, red/green commands, acceptance checks, and review gates.
4. TDD evidence must be recorded as command output summaries in the plan or the related review handoff.

## Forbidden

- Placeholder language banned by [doc-rules.md](../rules/doc-rules.md)
- Marking an ADR as `decided` without user approval
- Treating a plan as proof that implementation is complete
- Adding merge instructions for agent branches

## Checklist

- [ ] Source documents are listed.
- [ ] Non-goals are explicit.
- [ ] Review cycles are recorded.
- [ ] Verification commands are concrete.
- [ ] Affected module docs are named.

## Upstream Rules

- [Root guide](../../AGENTS.md)
- [Doc rules](../rules/doc-rules.md)
- [Testing rules](../rules/testing-rules.md)
- [Git rules](../rules/git-rules.md)
