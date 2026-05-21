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
| [003](2026-05-21-003-agent-runner-openclaw-delegation.md) | AgentRunner를 OpenClaw에 위임 | decided |
| [004](2026-05-21-004-file-based-prompt-passing.md) | 프롬프트는 파일 기반으로 전달 | decided |
| [005](2026-05-21-005-conductor-meta-agent.md) | 총괄 Conductor 메타 에이전트 도입 (옵션 B) | decided |
| [006](2026-05-21-006-workflow-library-model.md) | 워크플로우 라이브러리 + 호출 시 선택 모델 | decided |
| [007](2026-05-21-007-desktop-app-phase-3.md) | 데스크탑 앱은 Phase 3로 이동 | superseded |
| [008](2026-05-21-008-tailscale-mvp-exclusion.md) | Tailscale MVP 제외, Phase 3 통합 | superseded |
| [009](2026-05-21-009-forge-phase-and-slice-terminology.md) | Forge Phase와 Slice 용어 분리 | decided |
| [010](2026-05-21-010-review-loop-dsl.md) | Review/refine 반복은 review_loop로 표현 | decided |
| [011](2026-05-21-011-checkrunner-execute-kind-trigger.md) | CheckRunner는 execute kind 직후에만 실행 | decided |
