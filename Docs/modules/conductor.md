---
status: decided
last_reviewed: 2026-05-21
---

# Conductor

총괄 메타 에이전트. step 실행에 직접 관여하지 않고, task 전체 컨텍스트를 기억하며 (a) step 프롬프트를 보강하고 (b) 사용자 질문에 답한다.

## 책임

- task별 누적 요약(`.forgeroom/context/summary.md`) 유지
- staged ForgeMap context를 읽어 step 프롬프트 보강에 반영
- step 시작 전 컨텍스트 노트 생성 (실행 프롬프트는 renderer 소유; ADR-027 #121 amendment)
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
  refineNotes(taskId: TaskId, stepId: string, basePrompt: string): Promise<string>
  answer(taskId: TaskId, question: string): Promise<string>
}
```

## 동작 모델 (MVP)

옵션 B 채택: **Headless + 롤링 요약**. 결정: [ADR-005](../decisions/2026-05-21-005-conductor-meta-agent.md).

- 매 호출 = 1회 headless 실행
- 입력: selected ForgeMap context + summary + 직전 step의 prompt/output/diff 요약 + 사용자 피드백 또는 질문
- 출력: 갱신된 summary, feedback.md, **컨텍스트 노트**(refineNotes), 또는 답변

`Conductor.update`는 Mastra workflow run의 suspend 직전에 동기 완료되어야 한다 ([ADR-016](../decisions/2026-05-23-016-dsl-to-mastra-adapter.md)). 순서: agent 실행 → CheckRunner(kind:execute) → diff 저장 → **Conductor.update** → Reporter notify → (pauseAfterGate step에서) Mastra suspend. 이로써 resume 시점에 `.forgeroom/context/summary.md`와 `feedback.md`가 항상 디스크에 commit된 상태를 보장한다.

## 호출 입력 (구성)

`refineNotes`의 경우 (ADR-027 #121 amendment):
```
[CONTEXT]
- task 메타 (task.md)
- selected ForgeMap context (`selected-forgemap.md`, `target-profile.md`)
- 누적 summary
- 통합된 피드백 문서 (`feedback.md`, 존재하는 경우)
- 워크플로우 정의
- 직전 step output (last_step_id 기준)
- executor가 받을 step 프롬프트 (인지용 — 재생산·응답 금지)

[INSTRUCTION]
이 step을 잘 수행하도록 돕는 짧은 컨텍스트 노트만 작성하라(task별 가이드, 리스크,
강조점, 누락-컨텍스트 힌트). deliverable을 author하지 말고, `## Slices` 등 답 섹션을
채우지 말고, step 프롬프트를 재생산하지 마라. 추가할 게 없으면 아무것도 출력하지 마라.
```

출력은 실행 프롬프트를 대체하지 않는다. renderer(`StepCollaborators.renderPrompt`)가 renderer-owned
`base`(harness + template)를 프롬프트로 쓰고, refineNotes 출력은 `.forgeroom/context/refined-notes/<NN>_<step>.md`에
별도 stage한다(비거나 실패 시 생략). step template이 이 노트를 "컨텍스트 전용"으로 참조한다.

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

위반 판정은 `(호출 후 변경 집합) − (호출 전 변경 집합) − {summary.md, feedback.md}`로 계산한다. 호출 전부터 dirty했던 파일은 revert 대상이 아니다. tracked 파일은 `git restore --source=HEAD --worktree`로 복원하고, untracked 파일은 삭제한다. Conductor 자신의 파일 기반 프롬프트 산출물(`.forgeroom/prompts/conductor/`, `.forgeroom/outputs/conductor/`, `.forgeroom/logs/`)은 위반으로 보지 않는다.

### feedback.md Pending→Applied 전이는 코드 소유

`Pending`→`Applied` 전이는 LLM 출력에 의존하지 않고 Conductor 코드가 결정한다(섹션 파싱 후 라인 이동). consuming step이 `done`으로 끝난 `update` 호출에서만 Pending 항목을 `[step: <step_id>]` marker와 함께 Applied로 이동한다. step이 실패하면 Pending을 유지한다. LLM은 summary 서사 갱신만 담당한다. 이로써 전이가 결정적이고 테스트 가능하다.

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

- AgentRunner 실패 → 1회 재시도. 또 실패 시 노트 생략(빈 문자열 반환), renderer-owned 프롬프트 그대로 사용 (graceful degradation). `update`/`answer`는 실패 시 사용자에게 알림.
- summary 길이 폭발 → 4000 토큰 강제 truncate
- scope 위반 → revert + 로그 + 진행 계속

## 관련 결정

- [ADR-005](../decisions/2026-05-21-005-conductor-meta-agent.md)
- [ADR-014](../decisions/2026-05-22-014-forgemap-mvp-project-context.md)
- [Conductor 모델 상세](../concepts/conductor-model.md)
