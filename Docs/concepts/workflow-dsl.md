---
status: decided
last_reviewed: 2026-05-21
---

# Workflow DSL

`configs/workflows.yaml`에 이름붙은 워크플로우 라이브러리를 정의한다. 프로젝트는 사용 가능한 워크플로우 목록 + 기본값을 지정하고, 호출 시 선택한다.

## 기본 구조

```yaml
workflows:
  <workflow_id>:
    description: <str>
    steps:
      - id: <str>
        agent: <agent_id>
        prompt_template: <file>      # 또는 prompt
        prompt: <inline-str>
        input_refs:                  # 다른 step output을 파일 경로로 주입
          <name>: ${<step>.output_path}
        vars:
          <name>: <value>
        foreach: <list-expr>
        as: <name>
        steps: [...]                 # foreach 내부 step 그룹
        until: <bool-expr>
        max_iterations: <int>
        pause_after: <bool>
```

## 변수 보간

문법: `${...}`. step 시작 직전 1회 평가.

| 표현식 | 의미 |
|---|---|
| `${task.title}` | task 제목 |
| `${task.description}` | task 설명 |
| `${task.project}` | 프로젝트 ID |
| `${task.branch}` | task branch 이름 |
| `${task.worktree_path}` | worktree 절대경로 |
| `${task.issue_number}` | GitHub issue 번호 (없으면 빈 문자열) |
| `${task.full_diff_path}` | task 전체 누적 diff 파일 경로 |
| `${<step_id>.output}` | 해당 step의 output 본문 (인라인) |
| `${<step_id>.output_path}` | 해당 step의 output 파일 절대경로 |
| `${<step_id>.diff_path}` | 해당 step 종료 후 git diff 파일 경로 |
| `${<step_id>.passed}` | 해당 step의 통과 여부 (bool) |
| `${vars.<name>}` | workflow vars 또는 호출 시 vars |
| `${<foreach_as>}` | foreach `as`로 도입된 식별자 |

### 평가 규칙

1. 누락 변수 → fail-fast (에러 즉시, 다음 step 실행 X)
2. 큰 본문은 인라인 치환(`${design.output}`) 대신 가능하면 `input_refs`로 파일 경로 전달 권장
3. 외부 입력(issue body 등) 치환 전 길이 상한(약 8000 토큰) 적용. 초과 시 truncate + 표시
4. 코드 펜스 wrapping은 템플릿 작성자 책임

## foreach

```yaml
- id: phases
  foreach: ${impl_plan_refine.output.phases}
  as: phase
  steps:
    - id: phase_impl
      agent: codex
      vars:
        phase: ${phase}
    - id: phase_review
      agent: claude
```

- `foreach`의 값은 리스트 타입 평가식. 직전 step output에서 추출하려면 마크다운 목록 파서 사용 (Phase 1 단순 구현: `- ` 시작하는 라인 추출)
- `as`로 항목 식별자 도입
- `steps`는 항목당 1회 순차 실행
- 내부 step의 `id`는 외부에서 `${phases.<항목index>.<step_id>.output}` 같은 식 접근 X (MVP 미지원). 필요하면 가장 마지막 항목의 결과만 활용

## until

```yaml
- id: fix
  agent: codex
  until: ${review.passed}
  max_iterations: 3
```

- 본문 실행 → `until` 평가 → 거짓이면 다시 실행
- `max_iterations` 필수
- 도달 시 step.status=failed → task.status=failed

## pause_after

```yaml
- id: critical_step
  agent: codex
  pause_after: true
```

- step 완료 직후 task.status=paused
- `/resume <task>` 명령으로 재개

## 검증 (WorkflowRegistry.load 시)

1. id 중복 없음, 빈 문자열 아님
2. 참조한 agent가 `agents.yaml` 키와 매치
3. `${...}` 표현식이 알려진 step id/필드만 참조
4. foreach는 `as` + `steps`와 동반
5. until 있는 step은 `max_iterations` 필수
6. prompt_template / prompt 중 하나만 존재

## 미지원 (Phase 2+)

- `when` 조건 분기
- `parallel` 병렬 실행
- 외부 `tool` 호출
- 워크플로우 import/include
- 동적 step 생성

## 예시

[Phase 1 MVP 풀 워크플로우 예시](../phases/phase-1-mvp.md#예시-워크플로우)
