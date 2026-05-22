---
status: living
last_reviewed: 2026-05-22
---

# configs Rules

Read [context-map.md](context-map.md) before editing this folder.

## Core Rules

1. Config files are registries keyed by id; do not add top-level wrapper keys unless the canonical docs require them.
2. Keep Phase 1 providers limited to `openclaw`.
3. Config examples must be valid enough for registry tests and local startup wiring.
4. Do not store tokens, endpoints with secrets, or personal credentials here.

## Forbidden

- `.env` values or token strings
- Provider values outside Phase 1 scope
- Inline prompt bodies in workflow config
- Harness sources that leave the `.forgeroom/` tree

## Checklist

- [ ] Referenced intent agent ids exist in `agents.yaml`.
- [ ] Referenced harness ids exist in `harnesses.yaml`.
- [ ] Provider remains `openclaw`.
- [ ] No secrets are present.

## Upstream Rules

- [Root guide](../AGENTS.md)
- [Workflow DSL](../Docs/concepts/workflow-dsl.md)
- [AgentRunner module](../Docs/modules/agent-runner.md)
