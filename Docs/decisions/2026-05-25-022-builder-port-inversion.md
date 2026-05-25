---
status: decided
date: 2026-05-25
---

# ADR-022: WorkflowBuilder port 역전 (core → dsl 경계 위반 해소)

## 배경

ADR-021의 open item: `core/engine/pipeline-engine.ts`가 `dsl/`를 직접 import한다.

- `toMastraWorkflow`(빌더 함수) + `ReviewLoopMaxIterationsError` ← `dsl/to-mastra.ts`
- `AdapterValidationError` ← `dsl/dsl-errors.ts`

ADR-020은 `core → dsl`를 금지한다. 엔진이 빌더를 직접 호출하고(빌드), dsl이 런타임에 던지는 두 에러를 `mapFailureReason`에서 `instanceof`로 분류하기 때문에 잔존했다. ADR-021은 폴더 이동 슬라이스를 깨지 않으려고 이 역전을 추상화 phase의 별도 이슈(#59)로 미뤘다.

## 결정

빌더를 core 소유 port로 역전하고, 공유 에러를 중립 `workflow/` 레이어로 옮긴다. (codex grill 2026-05-25: Q1 88 / Q2 84 / Q3 86)

1. **빌더 port** — 신규 `workflow/builder.ts`에 정의한다(`types.ts`는 이미 데이터 계약으로 크므로 boundary 계약은 별도 모듈).
   ```ts
   interface BuiltWorkflow { workflow: unknown; effects: WorkflowEffects; resolvedSteps: ResolvedStep[] }
   interface WorkflowBuilder { build(workflow: ResolvedWorkflow, ctx: AdapterContext): BuiltWorkflow }
   ```
   `workflow: unknown`은 허용한다 — core는 committed Mastra 객체를 이미 opaque하게 다루고 등록 시 `.id`만 읽는다. **`workflow/`에 Mastra 타입을 import하지 않는다**(결합을 옮기는 것에 불과).

2. **dsl이 port 구현** — `dsl/to-mastra.ts`가 `mastraWorkflowBuilder: WorkflowBuilder = { build: toMastraWorkflow }`를 export한다. 기존 `BuiltMastraWorkflow`는 dsl에 그대로 두고, 구조적으로 `BuiltWorkflow`를 만족한다.

3. **엔진은 port에 의존(DI)** — `PipelineEngineDeps`에 `workflowBuilder: WorkflowBuilder` 추가. `buildWorkflow`는 `this.deps.workflowBuilder.build(...)` 호출. composition-root와 테스트가 `mastraWorkflowBuilder`를 주입한다.

4. **공유 에러 이전** — `AdapterValidationError`(현 `dsl/dsl-errors.ts`)와 `ReviewLoopMaxIterationsError`(현 `dsl/to-mastra.ts`)를 신규 `workflow/errors.ts`로 옮긴다. core와 dsl 모두 `workflow/errors`에서 import한다(`core → workflow`, `dsl → workflow` 모두 허용). 이름은 유지한다. `dsl/dsl-errors.ts`는 `WorkflowParseError`/`WorkflowExpressionError`만 남긴다.

## 이유

- core가 dsl 세부를 모르게 되어 ADR-020 경계가 완성된다.
- `instanceof`(중립 클래스 1개 식별자)가 `failure_reason` duck-check보다 단순·안전하다.
- 빌더를 DI로 주입하면 `FakeWorkflowBuilder`로 엔진 테스트가 쉬워진다.

## 결과

- 행동보존(behavior-preserving). 기존 unit+integration 그대로 green이 canary.
- **핵심 리스크**: 에러 클래스가 두 곳에 쪼개지면 `instanceof`가 깨진다 → 모든 importer를 한 번에 갱신한다.
- `dsl/dsl-errors.ts`에서 호환용 re-export는 두지 않는다(레포 규칙: no shim).
- `studio/sample-workflow.ts`는 dev 시각화 소비자이므로 `toMastraWorkflow`를 계속 직접 호출한다(port 강제 안 함 — abstraction theater 회피).
- ADR-021 open item을 close한다.

### 영향받는 파일

- `workflow/errors.ts` (신규), `workflow/builder.ts` (신규)
- `dsl/dsl-errors.ts`, `dsl/to-mastra.ts`, `dsl/to-mastra.test.ts`
- `core/engine/pipeline-engine.ts`, `core/engine/pipeline-engine.test.ts`
- `app/composition-root.ts`
- `dsl/context-map.md`, `workflow/context-map.md` (key files), `Docs/decisions/README.md`

## 비범위

- 빌더 인터페이스를 Mastra 외 다른 substrate로 일반화 (지금 2번째 substrate 없음)
- 에러 클래스 rename(WorkflowBuildError 등) — 이득 없으므로 보류
- studio를 port로 리팩터
