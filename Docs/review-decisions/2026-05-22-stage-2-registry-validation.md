---
status: living
last_reviewed: 2026-05-22
---

# Stage 2 Registry Validation Review Decisions

## Context

Stage 2 implements workflow, project, intent, agent, and harness registry validation for the Phase 1 MVP. An adversarial review of the current workflow/project registry slice returned `Review Result: fail` and identified gaps that must be treated as settled implementation requirements for this stage.

## Decisions

### YAML parsing is part of Stage 2, not later engine work

Decision: Stage 2 includes a `dsl` parser layer that parses actual YAML config text into registry input objects and preserves enough source metadata for validation errors to include workflow id, field, and line when available.

Rationale: The Stage 2 plan names `apps/orchestrator/src/dsl/*.test.ts` and the WorkflowRegistry spec requires parse/validation errors to identify workflow id, line, and field. In-memory object validation alone is not enough for this stage.

Boundary: The parser does not execute workflows and does not evaluate runtime output selectors. It only converts config text to plain registry input and source metadata.

Verification: Unit tests parse workflow YAML, reject malformed YAML with line information, and prove registry validation errors can include workflow id, field, and YAML line metadata.

### Source-enriched validation errors use deterministic field paths

Decision: Workflow validation errors that use YAML source metadata must carry deterministic field paths from validation code. They must not infer fields from free-form error message strings.

Rationale: Message-string inference misses nested validation cases and makes future wording changes break source diagnostics.

Boundary: This requirement applies to registry validation diagnostics, not runtime `PipelineEngine` execution errors.

Verification: Unit tests prove source-enriched errors for nested `steps[0].prompt_template`, duplicate step ids, and unknown `${missing.output_path}` references.

### Runtime expression evaluators are not Stage 2 scope

Decision: Stage 2 must not add runtime evaluators for interpolation, foreach, or until semantics. Those behaviors are part of the Stage 7 `PipelineEngine` execution slice.

Rationale: Stage 2 validates workflow shape and parses config. Runtime evaluation needs task state, step outputs, selector behavior, and execution context that do not exist until the engine slice.

Boundary: Stage 2 may statically validate expression references and supported fields. It must not evaluate `${...}` expressions or turn `${task.final_slices}` into runtime values.

Verification: `apps/orchestrator/src/dsl/` contains parser/source-metadata code only; evaluator files and tests are absent until Stage 7.

### Source metadata errors need explicit field context

Decision: `WorkflowRegistry` validation errors should carry or receive explicit field paths instead of inferring context from free-form error messages.

Rationale: The WorkflowRegistry spec requires workflow id, field, and line in validation failures. Message-string inference misses nested step fields and creates brittle diagnostics.

Boundary: Exact YAML line numbers are best-effort based on parser source metadata, but field paths must be deterministic for top-level fields and nested step fields used by Stage 2 validation.

Verification: Unit tests cover source-enriched errors for `effects.worktree`, `steps[0].prompt_template`, duplicate step id, and unknown `${missing.output_path}`.

### Workflow expression validation belongs in `WorkflowRegistry`

Decision: `WorkflowRegistry` validates `${...}` references in workflow `input_refs`, `vars`, `foreach`, and `until` strings enough to reject unknown step ids and unsupported fields during registry load.

Rationale: `Docs/concepts/workflow-dsl.md` and `Docs/modules/workflow-registry.md` require expressions to reference known step ids and fields. This validation is about static workflow shape, not runtime selector evaluation.

Boundary: `WorkflowRegistry` must not implement output selector parsing. Runtime semantics for `${<step_id>.output.slices}` and `${<step_id>.passed}` remain Stage 7 `PipelineEngine` work.

Verification: Unit tests reject duplicate step ids and unknown `${missing.output_path}` references while keeping selector parsing out of `dsl/`.

### Template existence uses an injected seam

Decision: `WorkflowRegistry` validates `prompt_template` relative-path safety and referenced template existence through an injected function such as `templateExists(relativePath)`.

Rationale: The docs require missing prompt templates to fail validation, while `core/AGENTS.md` forbids direct filesystem access from `core`.

Boundary: `core` owns the validation decision; filesystem lookup is supplied by an adapter.

Verification: Unit tests prove unsafe paths and missing templates fail without importing filesystem APIs in `core/workflow-registry.ts`.

### Invalid workflow handling depends on project references

Decision: `WorkflowRegistry.fromConfig` supports a referenced workflow id set. Invalid referenced workflows fail startup; invalid unreferenced workflows are disabled and exposed through a diagnostic list.

Rationale: `Docs/modules/workflow-registry.md` distinguishes referenced invalid workflows from unreferenced library entries.

Boundary: `ProjectRegistry` still validates project `default_workflow` and `allowed_workflows`; it does not silently enable disabled workflows.

Verification: Unit tests cover referenced invalid workflow throw, unreferenced invalid workflow disabled, and `get()` returning `null` for disabled workflows.

### Project verification commands are required

Decision: `ProjectRegistry` requires `commands.lint`, `commands.typecheck`, and `commands.test` for Phase 1 project entries.

Rationale: CheckRunner and the implementation plan depend on these operational checks as the standard verification gate.

Boundary: Additional command keys are allowed for project-specific workflows.

Verification: Unit tests reject project config missing any of the three required command keys.

### Missing project paths disable projects through a seam

Decision: `ProjectRegistry` validates path shape itself, but project path existence is supplied through an injected seam such as `projectPathExists(path)`. Missing paths do not throw for the whole registry; they disable that project and expose a diagnostic list.

Rationale: `Docs/modules/project-registry.md` states that nonexistent project paths warn and disable the project. `core` must not import filesystem APIs directly, so existence checks require an adapter seam.

Boundary: Unknown workflows, invalid command metadata, and invalid maintainer shape remain fatal config errors for referenced project entries. Only nonexistent project paths use the disabled-project path.

Verification: Unit tests prove missing path entries are absent from `get()`/`list()` and appear in `listDisabled()`.
