---
status: decided
date: 2026-05-25
---

# ADR-021: core/ 서브폴더 레이아웃 (테스트는 colocated 유지)

## 배경

`core/`에 impl 18개가 평면적으로 쌓여 탐색성이 떨어진다(+ `engine/`, `__tests__/`, `test-support/` 혼재). 레이어 구조(core/gateway/dsl/db/utils/workflow)는 유지하되 `core/` 내부를 책임별 서브폴더로 정리한다.

테스트 배치는 **colocated `<name>.test.ts` 유지**로 결정한다. top-level `tests/` 미러는 검토했으나 — 36개 규모에서 colocated가 더 빠르고 `testing-rules.md`도 colocated를 명시하며, 미러는 import churn/리뷰 노이즈 대비 ROI가 낮다(codex grill 2026-05-25, confidence 78). 단위 테스트는 소스 파일과 함께 서브폴더로 이동하므로 test↔source 상대 import는 불변이다.

`package.json` imports(`#src/*`) 같은 import-map은 도입하지 않는다(미러를 안 하므로 깊은 상대경로 문제가 없고, NodeNext + dist runtime contract 변경 위험을 피한다).

## 결정

`core/` 서브폴더 맵 (codex 제안 반영):

- `core/engine/` — pipeline-engine, step-collaborators, pull-request-external-effect, output-selectors (기존 engine/ 확장)
- `core/agent-runtime/` — agent-runner, agent-registry, harness-registry, openclaw-provider
- `core/registries/` — project-registry, workflow-registry, intent-registry (config lookup/validation 성격만)
- `core/conductor/` — conductor
- `core/checks/` — check-runner, approval-gate
- `core/reporting/` — reporter
- `core/worktree/` — worktree-manager
- `core/context/` — forgemap (registry 아니라 context/staging 도메인)
- `core/effects/` — pull-request-creator (외부 effect primitive)
- `core/` root — types.ts, errors.ts, task-store.ts (인터페이스/공유 기반)

각 새 서브폴더에 AGENTS.md + context-map.md. 콜로케이트 테스트는 각 소스와 함께 이동한다.

## 결과

- core 평면 덤프 해소, 책임 경계가 폴더로 드러남.
- 기계적 이동(git mv) + cross-folder import 갱신. 행동보존(테스트가 canary). 서브폴더 그룹별 슬라이스로 쪼개 커밋.
- `testing-rules.md`는 colocated 유지로 변경 없음. `src/AGENTS.md`의 core 폴더 책임 항목만 갱신.

## Open item (P3 범위 밖, 별도 처리)

- **core → dsl 경계 위반**: `core/engine/pipeline-engine.ts`가 `dsl/to-mastra.ts`(toMastraWorkflow 빌더)와 `dsl/dsl-errors.ts`를 import한다. ADR-020이 `dsl → core`를 금지하고 `core → dsl`도 금지지만 엔진이 빌더를 호출하는 구조라 잔존한다. 폴더 이동 중 함께 고치면 행동보존 슬라이스가 깨지므로, builder-port 역전은 추상화 phase의 별도 이슈로 다룬다. → **Resolved by [ADR-022](2026-05-25-022-builder-port-inversion.md)** (WorkflowBuilder port + 에러 클래스 `workflow/`로 이전).
