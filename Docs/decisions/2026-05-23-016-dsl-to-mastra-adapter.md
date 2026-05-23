---
status: decided
date: 2026-05-23
---

# ADR-016: yaml DSL → Mastra workflow 어댑터 계약

## 배경

ADR-015로 PipelineEngine 실행 substrate를 Mastra workflow primitives로 전환한다. ForgeRoom yaml DSL은 사용자 향 계약(workflow library, Intent registry, prompt template, vars, input_refs, foreach, review_loop, pause_after, effects)을 유지해야 한다. yaml DSL과 Mastra workflow 사이를 변환하는 단일 책임 어댑터 계층이 필요하다.

## 결정

`apps/orchestrator/src/dsl/to-mastra.ts`를 신설한다. 입력은 `workflow-parser.ts`가 산출한 parsed workflow + Intent Catalog, 출력은 Mastra `createWorkflow()` 결과 객체다.

### 매핑 표

| ForgeRoom DSL | Mastra equivalent | 비고 |
|---|---|---|
| Sequential step (`type: run`) | `.then(step)` 연쇄 | Resolved Step의 body가 prompt rendering → AgentRunner.run → 종료 검증 → CheckRunner (kind:execute일 때) → diff 저장 → Conductor.update를 한 step body 안에서 모두 실행 |
| `type: group` + `foreach` | `.foreach()` (sequential concurrency 1) | list는 `${id}:items` step body에서 **runtime(iteration bind time)에 lazy 평가**(아래 "foreach list 평가 시점" amendment). as 식별자를 step input으로 바인딩. MVP에서는 항목별 순차. foreach 내부 step의 `pause_after`는 native 지원 (아래 amendment 참조) |
| `type: review_loop` | `.dountil(loopStep, condition)` | review/refine을 하나의 loopStep으로 묶고, parsed `${review.passed}` 값을 condition으로 평가 |
| `pause_after: true` | 해당 step 뒤에 별도 `pauseAfterGate` step append | suspend는 step body 안이 아닌 gate step 안에서 호출 (트레이스 가독성 + Conductor.update 순서 보장) |
| `${...}` 변수 보간 | 어댑터가 step body 진입 전(= runtime bind time)에 평가해 step input으로 주입 | foreach `as` 바인딩 포함. foreach list 표현식도 runtime lazy 평가(아래 amendment) |
| Intent + Step Harness | Resolved Step 메타로 step body 진입 시점에 합성 | Mastra step 이름은 `${intent_id}:${step_id}` 규칙 |
| `effects` metadata | 어댑터 output에 그대로 보존 | WorkflowRegistry / Reporter / Gateway가 기존대로 effects 기반 판단 |

### Output selector 위치

PipelineEngine이 외부에서 파싱하지 않는다. `${<step_id>.output.slices}`와 `${<step_id>.passed}`는 **execute/review step body 내부**에서 ForgeRoom의 selector parser를 호출해 파싱하고, 결과를 Mastra step output으로 반환한다.

근거: `.dountil()` condition은 step output에 대한 함수이므로, parsed `passed`가 step output에 포함되어야 condition을 깔끔히 표현할 수 있다. retry budget(`MAX_AGENT_ATTEMPTS`)도 selector 검증 실패까지 한 step 안에서 일관되게 소비한다.

영향: `Docs/modules/pipeline-engine.md`의 "Output selector 해석" 섹션은 "PipelineEngine 책임"이 아니라 "ForgeRoom selector parser (step body에서 호출)" 책임으로 갱신한다.

### CheckRunner 위치

`kind: execute` step의 body 내부에서 직접 호출한다. 별도 Mastra step으로 분리하지 않는다.

근거: 분리 시 `check_fix_attempt`와 `check_status`가 별도 step row가 되어 데이터 모델 (ADR-011)과 충돌한다. Check fix는 동일 execute step row의 컬럼 갱신이며, AgentRunner attempt budget을 소비하지 않는다.

### ApprovalGate 위치

이중 배치:
- **Pre-Mastra (admission)**: PipelineEngine.runFull 진입 시점에서 workflow/project 단위 admission. TaskSource는 ApprovalGate를 우회할 수 없다.
- **In-step (runtime)**: AgentRunner 호출 직전 위험 명령/경로 동적 검사. 거부 시 step body가 fail로 종료되며, Mastra trace에는 guarded-failure로 나타난다.

### Conductor.update 시점

agent 실행 → CheckRunner (kind:execute일 때) → diff 저장 → **Conductor.update** → Reporter notify → (필요 시) pauseAfterGate에서 suspend.

근거: Mastra suspend snapshot이 떨어지기 전에 `.forgeroom/context/summary.md`, `feedback.md`가 디스크에 commit되어 있어야 한다. Resume 후 컨텍스트 일관성을 위해 update는 suspend 이전에 동기 완료.

### foreach + pause_after (OQ-M02 amendment, 2026-05-23)

본 ADR 초안은 foreach 내부 step의 `pause_after` 동작을 OQ-M02 스파이크 전까지 보류했다 (confidence 72). 스파이크 결과 **outcome (a) NATIVE**로 확정한다.

결정: sequential `.foreach()` (concurrency 1) 내부 step이 `suspend()`를 호출하면 Mastra가 해당 iteration 위치를 snapshot에 보존하고, resume 시 같은 iteration에서 깔끔히 재개한다 (loop 재시작 없음, 해당 항목 skip 없음). 따라서:

- foreach를 explicit sequential chain으로 lowering할 필요 없음.
- nested `pause_after`를 unsupported로 선언할 필요 없음. DSL 계약 유지.
- `pauseAfterGate` step append 규칙 (위 매핑 표)은 foreach 내부 step에도 그대로 적용된다.

전제: suspend/resume에는 영속 snapshot store가 필요하다 (store 미설정 시 resume은 `No snapshot found`로 실패). ForgeRoom은 SQLite 기반 storage를 구성하므로(ADR-017: TaskStore 권위, Mastra snapshot 보조) 충족.

범위 제한: 이 결정은 MVP의 sequential foreach (concurrency 1)에 한한다. `concurrency > 1` parallel foreach에서 항목별 suspend/resume 식별은 스파이크로 검증되지 않았다. 향후 parallel foreach + per-item pause가 필요하면 재스파이크 대상이다.

근거 자료: `Docs/spikes/2026-05-23-oq-m02-foreach-suspend.md`, 실행 코드 `apps/orchestrator/spikes/oq-m02/foreach-suspend.spike.ts`, codex review confidence 84.

### foreach list 평가 시점 (amendment, 2026-05-23, #20)

본 ADR 초안과 매핑 표의 "`${...}` 변수 보간 → 어댑터가 step body 진입 전에 평가" 문구는 foreach list 표현식의 평가 시점을 명확히 하지 않아, #6 어댑터가 `foreach`의 list(예: `${task.final_slices}`)를 **workflow build 시점**에 평가해 배열 reference를 list step에 캡처했다. 그러나 slice-impl의 list는 build 시점에 비어 있고, 선행 plan/review step이 **runtime**에 생성한다. #8 engine은 이를 우회하려고 build 시점 배열을 in-place로 `splice`해 runtime 값을 흘려보냈는데, 이는 배열 identity 결합으로 fragile하며 build 결과 캐시(`buildMastraWorkflowCached`)와 충돌한다(캐시된 workflow 재사용 시 run 간 slice 누수).

**결정:** "bind time"의 정의를 명확히 한다 — workflow **build** 시점이 아니라 **step input bind 시점 = iteration runtime**이다. foreach list 표현식의 **값**은 `${id}:items` list step의 `execute()`에서 **runtime에 lazy 평가**한다(현재 interpolation source를 읽는다). 어댑터는 build 시점에 list 표현식의 **shape**만 검증하고(`assertForeachExprSupported`), 표현식 자체(HOW)만 보관한다. list step이 build-time 배열 snapshot(WHAT)을 들지 않으므로 engine의 in-place `splice` bridge는 제거되고, engine은 plan/review 완료 시 `interpolation.task.final_slices`를 **재할당**하기만 한다. 결과적으로 build(구조)와 runtime(state)이 완전히 분리되어, 캐시된 workflow를 두 run에 재사용해도 slice가 누수되지 않는다(회귀 테스트: to-mastra.test.ts "does NOT leak slices across two runs of a cached/reused built workflow").

근거 자료: 이슈 #20, codex review confidence 94(.foreach()가 직전 step의 runtime output 배열을 순회함을 확인) / 88(no-leak 테스트 설계 타당성).

### iteration 인덱스 (review_loop)

**OQ-M01 스파이크로 확인됨 (`@mastra/core@1.36.0`, 결과 (b)):** Mastra `.dountil()`은 iteration counter를 step body에 노출하지 **않는다**. `iterationCount`는 `.dountil()` condition predicate에만 주입되며 (loop ceiling 용도), step `execute` payload·`getStepResult`·`requestContext` 어디에도 들어오지 않는다. 따라서 어댑터는 loopStep input/output schema에 `{iteration, passed, prevOutputPath}`를 명시적으로 thread한다. iteration은 ForgeRoom 파일명 규칙(`07_slice_review.0.md`)과 step row의 `iteration` 컬럼에 그대로 반영한다.

manual thread 채널은 step input/output으로 한다(`setState`/`state`도 가능하나 불필요): condition이 이미 `inputData.passed`를 읽으므로(위 "Output selector 위치" 참조) `iteration`을 같은 경로에 두면 데이터 흐름이 하나로 유지된다. mid-loop suspend 후 별도 프로세스에서 resume해도 threaded counter가 보존됨을 스파이크가 확인했다 (snapshot round-trip). 검증: `Docs/spikes/2026-05-23-oq-m01-dountil-iteration.md`.

### 검증

WorkflowRegistry.load → workflow-parser → **to-mastra adapter validate** → Mastra workflow build. Adapter 단계 실패는 startup 실패로 격상하며, `failure_reason=adapter_validation_failed`로 기록한다.

## 결과

- DSL 사용자 계약 (`Docs/concepts/workflow-dsl.md`)은 변경 없음.
- PipelineEngine.runFull은 어댑터를 호출해 Mastra workflow를 빌드하고 Mastra run을 시작한다.
- 어댑터 단위 테스트는 매 DSL primitive당 round-trip 케이스를 포함해야 한다.
- Mastra workflow 객체는 캐시 가능 (yaml hash → built workflow). 캐시 무효화는 yaml 변경 또는 Mastra 버전 변경.

## 관련

- ADR-010 review_loop DSL (의미 유지)
- ADR-011 CheckRunner execute kind 트리거 (호출 위치 명시)
- ADR-013 TaskSource/Reporter boundaries (Reporter 호출 위치 보존)
- ADR-015 Mastra workflow primitives 채택
- ADR-017 TaskStore = 권위, Mastra snapshot = 보조
- OQ-M01 스파이크 `Docs/spikes/2026-05-23-oq-m01-dountil-iteration.md` (iteration 인덱스 결정 근거)
- `Docs/concepts/workflow-dsl.md`
- `Docs/concepts/prompt-file-protocol.md`
- `Docs/modules/pipeline-engine.md`
