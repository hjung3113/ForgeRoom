---
status: living
last_reviewed: 2026-05-22
---

# Docs/review-decisions Rules

Read [context-map.md](context-map.md) before editing this folder.

> **Note:** Stage-N decisions in this folder predate ADR-015/016/017. Re-validate before applying to new (Mastra-based) implementation.

## Core Rules

1. Record implementation review decisions that were settled during adversarial review.
2. Keep entries narrow: decision, rationale, source review, affected files, and follow-up checks.
3. Do not use this folder to change product architecture or Phase scope; use ADRs for that.
4. Link to the canonical docs that govern the decision.

## Forbidden

- Replacing ADRs for architecture decisions
- Recording speculation as a decision
- Removing prior decisions because a later task disagrees
- Secrets, credentials, or private tokens

## Checklist

- [ ] Decision is traceable to a review finding or user instruction.
- [ ] Canonical source docs are linked.
- [ ] Follow-up verification is named.
- [ ] No incomplete planning markers remain.

## Upstream Rules

- [Root guide](../../AGENTS.md)
- [Doc rules](../rules/doc-rules.md)
- [Git rules](../rules/git-rules.md)
