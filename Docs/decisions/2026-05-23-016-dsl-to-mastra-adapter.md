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
| `type: group` + `foreach` | `.foreach()` (sequential concurrency 1) | as 식별자를 step input으로 바인딩. MVP에서는 항목별 순차 |
| `type: review_loop` | `.dountil(loopStep, condition)` | review/refine을 하나의 loopStep으로 묶고, parsed `${review.passed}` 값을 condition으로 평가 |
| `pause_after: true` | 해당 step 뒤에 별도 `pauseAfterGate` step append | suspend는 step body 안이 아닌 gate step 안에서 호출 (트레이스 가독성 + Conductor.update 순서 보장) |
| `${...}` 변수 보간 | 어댑터가 step body 진입 전에 평가해 step input으로 주입 | foreach `as` 바인딩 포함 |
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

### iteration 인덱스 (review_loop)

Mastra `.dountil()`이 step body에 iteration counter를 노출하는지는 MVP 스파이크 전까지 불확실(OQ-M01 참조). 어댑터는 loopStep input에 `{iteration, passed, prevOutputPath}`를 명시적으로 thread한다. iteration은 ForgeRoom 파일명 규칙(`07_slice_review.0.md`)과 step row의 `iteration` 컬럼에 그대로 반영한다.

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
- `Docs/concepts/workflow-dsl.md`
- `Docs/concepts/prompt-file-protocol.md`
- `Docs/modules/pipeline-engine.md`
