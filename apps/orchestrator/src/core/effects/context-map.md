---
status: living
last_reviewed: 2026-05-25
---

# core/effects Context Map

## Responsibility

Task-critical effect primitives shared by engine effect wrappers.

## Key Files

| File | Role |
|---|---|
| `pull-request-creator.ts` | PR creation/update primitive with retry and discovery-before-create |
| `branch-publisher.ts` | Branch-publication primitive: commit + push via BranchPublishPort seam; returns noDiff signal (ADR-025) |
| `issue-label-lifecycle.ts` | Terminal-state triage-label transition side-effect (ADR-026); depends on injected `IssueLabelPort` |
