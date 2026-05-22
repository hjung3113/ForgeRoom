---
status: decided
last_reviewed: 2026-05-21
---

# Conductor

총괄 메타 에이전트. step 실행에 직접 관여하지 않고, task 전체 컨텍스트를 기억하며 (a) step 프롬프트를 보강하고 (b) 사용자 질문에 답한다.

## 책임

- task별 누적 요약(`.forgeroom/context/summary.md`) 유지
- staged ForgeMap context를 읽어 step 프롬프트 보강에 반영
- step 시작 전 base prompt 보강
- step 종료 후 summary 갱신
- step 사이 사용자 피드백을 다음 step 프롬프트 보강에 반영
- `/ask` 명령 응답
- `/feedback` 명령으로 기록된 사용자 지시를 다음 `refine` 입력에 포함
- **코드 작성 X, 커밋 X, PR 생성 X**

## 인터페이스

```typescript
interface Conductor {
  init(taskId: TaskId): Promise<void>
  update(taskId: TaskId, stepResult: StepResult): Promise<void>  // 동기, 다음 step 시작 전 완료
  integrateFeedback(taskId: TaskId): Promise<void>
  refine(taskId: TaskId, stepId: string, basePrompt: string): Promise<string>
  answer(taskId: TaskId, question: string): Promise<string>
}
```

## 동작 모델 (MVP)

옵션 B 채택: **Headless + 롤링 요약**. 결정: [ADR-005](../decisions/2026-05-21-005-conductor-meta-agent.md).

- 매 호출 = 1회 headless 실행
- 입력: selected ForgeMap context + summary + 직전 step의 prompt/output/diff 요약 + 사용자 피드백 또는 질문
- 출력: 갱신된 summary, feedback.md, 보강 프롬프트, 또는 답변

## 호출 입력 (구성)

`refine`의 경우:
```
[CONTEXT]
- task 메타 (task.md)
- selected ForgeMap context (`selected-forgemap.md`, `target-profile.md`)
- 누적 summary
- 통합된 피드백 문서 (`feedback.md`, 존재하는 경우)
- 워크플로우 정의
- 직전 step output (last_step_id 기준)
- 현재 step base_prompt

[INSTRUCTION]
이 step의 base_prompt를 task 맥락에 맞게 보강하라.
원래 의도를 변경하지 말고, 구체성·근거를 추가하라.
```

`integrateFeedback`의 경우:
```
[CONTEXT]
- 기존 summary
- 아직 반영되지 않은 `user_feedback` events
- 직전 step output 경로

[INSTRUCTION]
다음 step에 넘길 사용자 지시를 `.forgeroom/context/feedback.md`로 정리하라.
기존 step output은 덮어쓰지 말고, 피드백을 반영했다는 marker를 남겨 중복 반영을 막아라.
성공 시 `feedback_integrated`, 실패 시 `feedback_integration_failed` event를 기록해 Reporter가 timeline에 표시하게 한다.
```

`update`의 경우:
```
[CONTEXT]
- 기존 summary
- 방금 끝난 step의 prompt/output/diff 요약
- feedback.md의 Pending 항목

[INSTRUCTION]
summary를 갱신하라. 길이 상한 4000 토큰.
step이 성공적으로 완료됐으면 이번 step에 반영된 Pending feedback을 Applied로 이동하라.
```

`answer`의 경우:
```
[CONTEXT]
- summary
- selected ForgeMap context
- 최근 N개 step output 경로
- 사용자 질문

[INSTRUCTION]
질문에 사실 기반으로 답하라. 모르는 건 모른다고 말하라.
```

## Scope 위반 방어

호출 전 git status snapshot, 호출 후 diff. 변경 파일 중 `.forgeroom/context/summary.md`와 `.forgeroom/context/feedback.md` 외 존재 시:

1. 변경 파일 `git checkout <file>`로 revert
2. `logs/conductor_scope_violation.log` 기록
3. Conductor의 텍스트 응답은 그대로 사용

MVP AgentRunRequest에는 provider별 per-call permission profile을 넣지 않는다. Conductor scope 방어는 post-run diff 검사와 revert를 기본으로 한다. Provider capability 기반 사전 차단은 Forge Phase 2에서 재검토한다.

## 에이전트 슬롯

`configs/agents.yaml`의 `conductor:` 블록에서 정의. 기본: Claude.

```yaml
conductor:
  provider: openclaw
  runtime: claude-cli
  model: anthropic/claude-opus-4-7
```

## 의존

- AgentRunner
- TaskStore (conductor_state)
- TaskStore (user_feedback events)
- 파일 시스템 (`.forgeroom/context/`)

## 에러

- AgentRunner 실패 → 1회 재시도. 또 실패 시 보강 생략하고 base_prompt 그대로 사용 (graceful degradation). `update`/`answer`는 실패 시 사용자에게 알림.
- summary 길이 폭발 → 4000 토큰 강제 truncate
- scope 위반 → revert + 로그 + 진행 계속

## 관련 결정

- [ADR-005](../decisions/2026-05-21-005-conductor-meta-agent.md)
- [ADR-014](../decisions/2026-05-22-014-forgemap-mvp-project-context.md)
- [Conductor 모델 상세](../concepts/conductor-model.md)
