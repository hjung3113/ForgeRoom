---
status: living
last_reviewed: 2026-05-21
---

# ADR 인덱스

Architecture Decision Record. 한 ADR = 한 결정. 결정 사항은 코드/스펙에 반영하더라도, 결정의 **이유**는 여기에 보존한다.

## 작성 규칙

- 파일명: `YYYY-MM-DD-NNN-<slug>.md`
- 상태: `proposed` | `decided` | `superseded`
- supersede 시 새 ADR 추가하고 기존 ADR의 status 변경 + `superseded_by` 명시

## 목록

| ID | 제목 | 상태 |
|---|---|---|
| [001](2026-05-21-001-runtime-nodejs-typescript.md) | Orchestrator 런타임으로 Node.js + TypeScript | decided |
| [002](2026-05-21-002-storage-sqlite.md) | 저장소로 SQLite 채택 (vs Postgres) | decided |
| [003](2026-05-21-003-agent-runner-openclaw-delegation.md) | AgentRunner를 OpenClaw에 위임 | superseded |
| [004](2026-05-21-004-file-based-prompt-passing.md) | 프롬프트는 파일 기반으로 전달 | decided |
| [005](2026-05-21-005-conductor-meta-agent.md) | 총괄 Conductor 메타 에이전트 도입 (옵션 B) | decided |
| [006](2026-05-21-006-workflow-library-model.md) | 워크플로우 라이브러리 + 호출 시 선택 모델 | decided |
| [007](2026-05-21-007-desktop-app-phase-3.md) | 데스크탑 앱은 Phase 3로 이동 | superseded |
| [008](2026-05-21-008-tailscale-mvp-exclusion.md) | Tailscale MVP 제외, Phase 3 통합 | superseded |
| [009](2026-05-21-009-forge-phase-and-slice-terminology.md) | Forge Phase와 Slice 용어 분리 | decided |
| [010](2026-05-21-010-review-loop-dsl.md) | Review/refine 반복은 review_loop로 표현 | decided |
| [011](2026-05-21-011-checkrunner-execute-kind-trigger.md) | CheckRunner는 execute kind 직후에만 실행 | decided |
| [012](2026-05-22-012-agent-runtime-provider-boundary.md) | AgentRuntimeProvider 경계를 MVP에 도입 | decided |
| [013](2026-05-22-013-task-source-and-reporter-boundaries.md) | TaskSource와 Reporter 경계를 분리 | decided |
| [014](2026-05-22-014-forgemap-mvp-project-context.md) | ForgeMap을 MVP Project Context 기반으로 채택 | decided |
| [015](2026-05-23-015-mastra-workflow-primitives.md) | PipelineEngine 실행 substrate로 Mastra workflow primitives 채택 | decided |
| [016](2026-05-23-016-dsl-to-mastra-adapter.md) | yaml DSL → Mastra workflow 어댑터 계약 | decided |
| [017](2026-05-23-017-taskstore-authoritative-mastra-auxiliary.md) | TaskStore step row = 권위 상태, Mastra snapshot = 보조 | decided |
| [018](2026-05-23-018-node-baseline-22.md) | Node 런타임 baseline을 22.13+로 상향 | decided |
| [019](2026-05-23-019-pr-creation-external-effect.md) | PR 생성은 PipelineEngine 소유 external effect (ADR-013 명확화) | decided |
| [020](2026-05-25-020-dsl-single-schema-neutral-workflow-contract.md) | DSL 단일 스키마 + 중립 `workflow/` 계약 레이어 | decided |
| [021](2026-05-25-021-core-subfolder-layout.md) | `core/` 책임별 서브폴더 레이아웃 (테스트 colocated) | decided |
| [022](2026-05-25-022-builder-port-inversion.md) | WorkflowBuilder port 역전 (core → dsl 경계 위반 해소) | decided |
| [023](2026-05-25-023-resolved-runtime-target.md) | ResolvedRuntimeTarget — provider-neutral 실행 타깃 (B1, scope A) | decided |
| [024](2026-05-25-024-static-model-policy-registry.md) | 정적 ModelPolicyRegistry (B2, Phase 2A) | decided |
| [025](2026-05-25-025-branch-publication-no-diff-settlement.md) | Branch-publication effect (commit+push before PR) + no-diff terminal success | decided |
| [026](2026-05-25-026-label-lifecycle-terminal-effect.md) | GitHub 이슈 라벨-라이프사이클 terminal side-effect | decided |
