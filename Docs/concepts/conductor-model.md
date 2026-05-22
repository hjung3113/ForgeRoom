---
status: decided
last_reviewed: 2026-05-21
---

# Conductor 모델

## 두 레이어 협업

| 시스템 (yaml + 엔진) | Conductor (LLM 메타 에이전트) |
|---|---|
| step 순서 강제 | task별 누적 컨텍스트 기억 |
| worktree/branch 관리 | 사용자 질문 응답 |
| Check 실행·재시도 결정 | step 프롬프트 사전 튜닝 |
| Discord 알림 발송 | 단계 간 의미 연결 |

Conductor는 코드 작성 X, 커밋 X, PR 생성 X.

Conductor는 task-local context compiler에 가깝다. 외부 지식베이스를 기본 검색하는 일반 RAG가 아니라, 현재 task의 staged ForgeMap subset, summary, workflow 정의, step output, diff, 사용자 feedback을 모아 다음 agent가 실행할 프롬프트를 더 정확하게 만든다.

다음 step 지시 관점에서 PipelineEngine은 구조적 지시를 소유한다: workflow order, step id, intent, prompt template, vars, input_refs. ForgeMap은 Target Project의 canonical project context를 소유한다. Conductor는 context 보강을 소유한다: staged ForgeMap subset, task summary, 직전 결과, 통합된 user feedback을 렌더링된 base prompt에 반영한다.

Conductor는 workflow 순서, step 목적, intent, agent, harness, prompt template을 바꾸지 않는다.

Forge Phase 2 이후에는 ContextProvider 계층을 추가해 issue/PR history, 공식 문서, 사내 지식 저장소 같은 외부 지식을 검색·요약하고 Conductor 입력에 연결할 수 있다. MVP에서는 외부 RAG를 구현하지 않고 ForgeMap에서 선택된 task-local context만 사용한다.

## 동작 모델 (MVP: 옵션 B — Headless + 롤링 요약)

다른 옵션과 비교한 채택 근거는 [ADR-005](../decisions/2026-05-21-005-conductor-meta-agent.md).

매 호출 시 SQLite의 summary + `.forgeroom/context/summary.md` 파일을 진실의 원천으로 사용.

```
[update]
input:  현재 summary + 방금 끝난 step의 prompt/output/diff 요약
output: 갱신된 summary (마크다운, ≤4000 토큰)
side effect: SQLite + summary.md 갱신

[refine]
input:  selected-forgemap.md + target-profile.md + summary + feedback.md + 워크플로우 정의 + 직전 step output + 현재 step base_prompt
output: 보강된 프롬프트 텍스트
side effect: 없음 (prompts/ 디렉토리에 PipelineEngine이 저장)

[integrateFeedback]
input:  summary + 아직 반영되지 않은 user_feedback events + 직전 step output 경로
output: 다음 step에 넘길 피드백 요약 문서
side effect: feedback.md 갱신 + 반영 marker 기록

[answer]
input:  summary + 최근 N개 step output 경로 + 사용자 질문
output: 답변 텍스트
side effect: 없음
```

## summary 구조 (권장)

```markdown
# Task Summary

## Goal
<short>

## Decisions
- ...

## Progress
- <step_id>: <one-line outcome>
- ...

## Open Questions
- ...

## Risks
- ...
```

## Scope 위반 방어

Conductor 호출 전 `git status` snapshot, 호출 후 비교.

```
변경 파일 - {"<summary_path>", "<feedback_path>"} =
  - 비어 있음: 정상
  - 그 외: 위반
    1. git checkout <files>  (worktree만 revert)
    2. logs/conductor_scope_violation.log 추가
    3. Conductor 응답 텍스트는 그대로 사용
```

MVP AgentRunRequest에는 provider별 per-call permission profile을 넣지 않는다. Conductor scope 방어는 post-run diff 검사와 revert를 기본으로 한다. Provider capability 기반 사전 차단은 Forge Phase 2에서 재검토한다.

## Conductor 에이전트 설정

`configs/agents.yaml`:

```yaml
conductor:
  openclaw_runtime: claude-cli
  model: anthropic/claude-opus-4-7
```

다른 모델로 바꾸려면 `model` 만 교체. workflow와 무관.

## 호출 빈도와 비용

매 step마다 update + refine 2회 호출. task당 step 수가 N이면 호출 ≈ 2N + 사용자 `/ask` 횟수.

- 입력 길이 제어: summary는 4000 토큰 상한, 직전 step output은 요약 또는 partial read
- 캐시: OpenClaw가 prompt caching 지원하면 활용 (Claude API 통합 시)

## 실패 시 동작 (graceful degradation)

| 호출 | 실패 시 |
|---|---|
| `update` | 1회 재시도. 또 실패 시 summary 갱신 생략, 다음 step 진행. Reporter 알림 |
| `integrateFeedback` | 1회 재시도. 또 실패 시 feedback.md 갱신 생략, 다음 step 진행 전 사용자에게 알림 |
| `refine` | 1회 재시도. 또 실패 시 base_prompt 그대로 사용, 진행 |
| `answer` | 1회 재시도. 또 실패 시 사용자에게 "answer 실패, summary 직접 확인 권장" |

## 관련 문서

- [modules/conductor.md](../modules/conductor.md)
- [modules/forgemap.md](../modules/forgemap.md)
- [ADR-005](../decisions/2026-05-21-005-conductor-meta-agent.md)
- [ADR-014](../decisions/2026-05-22-014-forgemap-mvp-project-context.md)
