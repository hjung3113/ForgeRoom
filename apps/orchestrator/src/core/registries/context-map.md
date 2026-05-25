---
status: living
last_reviewed: 2026-05-25
---

# core/registries Context Map

## Responsibility

Semantic validation and lookup for configured projects, workflows, and intents.

## Key Files

| File | Role |
|---|---|
| `intent-registry.ts` | Intent validation and lookup; carries optional `model_policy` ref (ADR-024) |
| `model-policy-registry.ts` | Static model policy validation + lookup; resolves a policy to a primary `ResolvedRuntimeTarget` (ADR-024) |
| `project-registry.ts` | Project validation and lookup |
| `workflow-registry.ts` | Workflow semantic validation and resolved workflow registry |
