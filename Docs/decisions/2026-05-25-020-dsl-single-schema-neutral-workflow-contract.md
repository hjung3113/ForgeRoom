---
status: decided
date: 2026-05-25
---

# ADR-020: DSL 단일 schema + 중립 `workflow/` contract 레이어

## 배경

워크플로우 DSL이 **두 번 파싱·검증**된다 (codex grill 2026-05-25, confidence 90–96):

- `core/workflow-registry.ts`: `parseWorkflow`/`parseStep`/… 로 구조 파싱 + 구조/표현식/intent 참조 검증. `ParsedWorkflow`/`ResolvedStep`, `WorkflowValidationError`.
- `dsl/to-mastra.ts`: `parseForgeWorkflow`→`normalizeWorkflow`/`normalizeStep`/… 로 **두 번째 파서** + `validateWorkflow`/`validateExecutable`/`validateReviewLoop`(`intents.resolve` 의미검증 중복) + `evaluateExpression`/`resolveRef`(런타임 표현식, 자체 정규식 문법) + `isRecord`/`oneOf`/`requireStringField`(헬퍼 복붙). `ParsedForgeWorkflow`/`ParsedStep`, `AdapterValidationError`.

두 파서·두 검증·두 에러클래스·중복 헬퍼·표현식 문법 2곳(검증 필드셋 vs 런타임 정규식)이 공존한다. 새 step/effect/field 추가 시 양쪽을 수정해야 하고 규칙이 drift할 위험이 크다.

추가로 import 경계가 문서 간 충돌한다: `src/AGENTS.md`는 `dsl → core` 허용, `dsl/AGENTS.md`는 core import 금지(가급적 독립). `to-mastra.ts`는 현재 core `IntentRegistry`를 import한다.

핵심 난점: 단일 파서가 산출하는 schema 타입을 core와 dsl 둘 다 써야 하는데 — dsl에 두면 `core → dsl`(`core/AGENTS.md` 금지), core에 두면 `dsl → core`(`dsl/AGENTS.md` 금지)라 어느 쪽도 깨끗하지 않다.

## 결정

1. **중립 contract 레이어 `src/workflow/` 신설.** workflow schema/types/expression contract를 소유한다: `types.ts`(`ParsedForgeWorkflow`/`ResolvedWorkflow` 등), `schema.ts`(yaml `source → ParsedForgeWorkflow` 순수 파서, 구조 검증만), `expression.ts`(허용 task/step 필드 grammar + ref 파싱 — static 검증과 런타임 resolve 단일 소스). `src/workflow/`는 `core`/`dsl`/`gateway`/`db`로부터 **아무것도 import하지 않는다**.
2. **의미검증 + intent 해석은 `core/workflow-registry`가 소유.** `IntentRegistry`로 `ParsedForgeWorkflow → ResolvedWorkflow`(intent kind/harness/agent 해석 + until/review/refine 규칙 검증)를 산출한다.
3. **`dsl/to-mastra.ts`는 `ResolvedWorkflow`를 받는 순수 Mastra 빌더.** 자체 normalize/parse·의미검증을 제거하고 `IntentRegistry` import를 제거한다(빌드타임 intent 의존은 `ResolvedWorkflow`의 사전해석된 step으로 충족).
4. **`PipelineEngine`은 `WorkflowRegistry` 결과(`ResolvedWorkflow`)를 사용**하고 `parseForgeWorkflow(source)`를 재호출하지 않는다(현재 절단점). build API를 그에 맞게 변경한다.
5. **에러클래스 단일화는 보류**(스냅샷/메시지 churn만 키움). 본 ADR 범위 밖.

## import 방향 개정

`src/AGENTS.md`의 import 규칙에 중립 레이어를 추가한다:

- `workflow/`는 도메인 contract 전용 레이어다. `core`, `dsl`, `db`는 `workflow/`를 import할 수 있다.
- `workflow/`는 `core`/`dsl`/`gateway`/`db`/`utils`(도메인) 어느 것도 import하지 않는다(순수 타입+파싱+표현식).
- 기존 `dsl → core` 허용 항목은 본 ADR로 폐기하고 `dsl/AGENTS.md`(dsl 독립)를 채택해 문서 충돌을 해소한다. dsl이 필요로 하던 schema 타입은 `workflow/`에서 온다.

## 결과

- 새 step type/field/effect 추가가 한 곳(`workflow/`)에서.
- `dsl`이 진짜 core-free가 되어 경계가 명확해진다.
- 행동보존이 필수다(가장 큰 두 파일 `to-mastra.ts` 915줄 / `workflow-registry.ts` 871줄). 슬라이스로 쪼개고 기존 테스트 전수 통과로 보장한다. 이행 중 `parseForgeWorkflow`는 임시 deprecated wrapper로 유지했다가 제거한다.

## 후속

- 폴더 물리 배치/테스트 미러는 ADR-A(별도, P3)에서 다룬다.
- 에러클래스 단일화는 필요해질 때 별도 ADR/슬라이스.
