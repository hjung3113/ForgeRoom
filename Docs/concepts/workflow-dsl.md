---
status: decided
last_reviewed: 2026-05-21
---

# Workflow DSL

`configs/workflows.yaml`에 이름붙은 워크플로우 라이브러리를 정의한다. 프로젝트는 사용 가능한 워크플로우 목록 + 기본값을 지정하고, 호출 시 선택한다. 기본 제공 workflow는 처음 쓰는 사용자가 체험할 수 있는 sane default이며, 실제 운영에서는 프로젝트별 custom workflow 사용을 전제로 한다.

Custom workflow는 step 순서, prompt template, `foreach`, `review_loop`, `pause_after`, `input_refs`, `vars` 구성을 자유롭게 바꿀 수 있다. 다만 실행 preset은 registry에 등록된 값만 참조한다. MVP에서는 workflow step이 `agent`, `kind`, `harness`를 직접 지정하거나 override하지 않고, 항상 `configs/intents.yaml`의 Intent를 통해 간접 참조한다.

Step의 실행 구성은 `configs/intents.yaml`의 Intent Catalog에 둔다. Workflow step은 intent와 prompt template을 참조하고, PipelineEngine은 step + intent를 합쳐 Resolved Step을 만든 뒤 실행한다.

역할 분리:

- Workflow: step 순서와 제어 흐름
- Executable Step: workflow 안의 실행 슬롯, prompt template, vars, input_refs
- Step Group: `foreach`로 내부 steps를 반복하는 구조
- Review Loop: review가 pass할 때까지 review/refine 쌍을 반복하는 구조
- Intent: Intent Kind, agent, Step Harness를 묶은 실행 구성 preset
- Prompt Template: 해당 step에서 실제로 무엇을 시킬지 렌더링하는 지시 양식
- Conductor: 렌더링된 base prompt에 task summary, 직전 결과, 통합된 user feedback을 반영하는 context 보강자

## Intent Catalog

`configs/intents.yaml`은 최상위 key를 intent id로 사용하는 registry다. 파일명이 이미 registry 의미를 가지므로 최상위 `intents:` wrapper는 두지 않는다.

```yaml
claude_write_plan:
  description: Write an implementation plan with Claude.
  kind: write_plan
  agent: claude
  harness: planning

codex_execute:
  kind: execute
  agent: codex
  harness: implementation

claude_review:
  kind: review
  agent: claude
  harness: review
```

`kind`는 Intent Kind다. MVP에서는 agent 선택을 바꾸지 않고, 검증·리포팅·Conductor 입력용 metadata로 사용한다. CheckRunner는 유일한 실행 정책 예외로 `kind: execute` step 완료 직후에만 실행한다. 모델별 분기는 `kind`가 아니라 Intent id와 `agent`에서 표현한다. 예: `codex_review`, `claude_review`는 둘 다 `kind: review`다.

## 기본 구조

```yaml
<workflow_id>:
  description: <str>
  steps:
    - type: run
      id: <str>
      intent: <intent_id>
      prompt_template: <file>
      input_refs:                  # 다른 step output을 파일 경로로 주입
        <name>: ${<step>.output_path}
      vars:
        <name>: <value>
      pause_after: <bool>

    - type: group
      id: <str>
      foreach: <list-expr>
      as: <name>
      steps: [...]                 # foreach 내부 step 그룹

    - type: review_loop
      id: <str>
      max_iterations: <int>
      until: ${<review_step>.passed}
      review:                      # run step과 같은 executable step spec. type은 쓰지 않음
        id: <str>
        intent: <review_intent_id>
        prompt_template: <file>
        input_refs: {...}
      refine:
        id: <str>
        intent: <refine_or_execute_intent_id>
        prompt_template: <file>
        input_refs: {...}
```

`configs/workflows.yaml`도 최상위 key를 workflow id로 사용하는 registry다. 최상위 `workflows:` wrapper는 두지 않는다.

`type: run`은 Executable Step이고, `intent`와 `prompt_template`을 가진다. `type: group`은 Step Group이고, `foreach`, `as`, `steps`를 가지며 직접 agent를 호출하지 않으므로 `intent`, `prompt_template`, `prompt`를 갖지 않는다. `type: review_loop`은 Review Loop이고, `review`와 `refine`에 각각 Executable Step spec을 가진다.

MVP에서 Executable Step은 Intent의 `kind`, `agent`, `harness`를 override하지 않는다. step별 실행 구성 override는 Intent의 추적성을 약하게 만들기 때문에 Forge Phase 2 검토 항목으로 미룬다.

`prompt_template`, `vars`, `input_refs`는 Intent override가 아니라 prompt rendering input이다. 같은 Intent라도 step의 목적과 범위에 따라 다른 prompt template을 사용할 수 있다. MVP에서는 executable step의 inline `prompt`를 허용하지 않는다. `prompt` 필드가 있으면 WorkflowRegistry validation 실패이며, inline prompt는 Forge Phase 2 후보로 둔다.

`review` intent는 단독 inspection과 refine 입력으로 모두 쓰일 수 있다. MVP 기본 workflow에서는 단독 review-only workflow를 제공하지 않고, 중간 review step은 다음 refine step의 `input_refs.review`로 연결한다. 단독 inspection review workflow는 Forge Phase 2 후보로 둔다.

MVP 기본 `full` workflow에서 design/plan 단계의 review는 pass/fail gate가 아니라 보강 입력이다. `design_refine`과 `impl_plan_refine`은 review 결과를 받아 1회 실행하고, `review_loop`는 code diff 품질 게이트에만 사용한다. custom workflow는 이 구성을 바꿀 수 있다.

MVP의 표준 `input_refs` 이름은 다음만 사용한다.

| 이름 | 의미 |
|---|---|
| `target` | review step이 검사하는 대상 파일 |
| `original` | refine step이 수정 기준으로 삼는 원본 문서 |
| `review` | refine step을 유도하는 review output 전체 파일 |
| `diff` | 단일 구현 step 또는 slice의 코드 변경 diff |
| `full_diff` | Task 전체 누적 diff |

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
| `${task.final_slices}` | 현재 task에서 실행 대상으로 최종 결정된 slice 문자열 list |
| `${<step_id>.output}` | 해당 step의 output 본문 (인라인) |
| `${<step_id>.output.slices}` | MVP에서 유일하게 구조화 추출을 지원하는 step output 값. 해당 step의 `## Slices` 목록을 list로 파싱 |
| `${<step_id>.output_path}` | 해당 step의 output 파일 절대경로 |
| `${<step_id>.diff_path}` | 해당 step 종료 후 git diff 파일 경로 |
| `${<step_id>.passed}` | review output 첫 non-empty line의 `Review Result: pass/fail` 헤더에서 파싱한 통과 여부 |
| `${vars.<name>}` | workflow vars 또는 호출 시 vars |
| `${<foreach_as>}` | foreach `as`로 도입된 식별자 |

### 평가 규칙

1. 누락 변수 → fail-fast (에러 즉시, 다음 step 실행 X)
2. 큰 본문은 인라인 치환(`${design.output}`) 대신 가능하면 `input_refs`로 파일 경로 전달 권장
3. 외부 입력(issue body 등) 치환 전 길이 상한(약 8000 토큰) 적용. 초과 시 truncate + 표시
4. 코드 펜스 wrapping은 템플릿 작성자 책임

## Step Harness

`harness`는 Intent가 참조하는 ForgeRoom 작업 환경 preset이다. hooks, skills, plugins, AGENTS.md/CLAUDE.md 계열 지침, prompt/output contract를 직접 나열하지 않고 이름으로 참조한다.

```yaml
codex_execute:
  kind: execute
  agent: codex
  harness: implementation
```

- Intent에 `harness`가 없으면 IntentRegistry validation 실패
- `harness`는 ForgeRoom prompt/context 구성 개념이고, provider에 전달하는 `runtime_harness`와 구분

## CheckRunner 트리거

- `kind: execute` step이 성공적으로 agent output을 작성하면 CheckRunner를 실행한다.
- `kind: write_plan`, `kind: review`, 문서 보강용 `kind: refine` step은 CheckRunner를 실행하지 않는다.
- `review_loop.refine`이 `kind: execute`이면 매 refine cycle 뒤 CheckRunner를 실행한다.
- review step은 직전 execute/refine 뒤 CheckRunner를 통과한 diff를 검토한다.
- CheckRunner 실패 후 자동 수정이 성공하면 해당 execute step의 `diff_path`는 수정 결과까지 포함한 최신 diff를 가리킨다.

## foreach

```yaml
- type: group
  id: slices
  foreach: ${task.final_slices}
  as: slice
  steps:
    - type: run
      id: slice_impl
      intent: codex_execute
      prompt_template: slice_impl.md
      vars:
        slice: ${slice}
    - type: run
      id: slice_review
      intent: claude_review
      prompt_template: slice_review.md
```

- MVP에서 slice 구현용 `foreach`는 `${task.final_slices}`를 사용한다.
- `<step_id>.output.slices`는 해당 step output의 `## Slices` 섹션에서 `- `로 시작하는 목록을 문자열 list로 파싱한 값이다.
- `task.final_slices`는 `implementation_plan.md`의 `## Slices`로 초기화되고, MVP full workflow에서는 review 결과와 관계없이 항상 실행되는 `refine_plan.md`의 `## Slices`로 최종 갱신된다.
- plan review가 pass여도 `refine_plan.md` step은 실행한다. 이때 review 결과가 pass였다는 사실을 입력으로 전달하고, refine output의 `## Slices`가 최종 실행 대상이 된다.
- MVP의 `implementation_plan.md`와 `refine_plan.md` prompt template은 출력 마지막에 `## Slices` 섹션을 반드시 생성해야 한다.
- `## Slices` 아래의 top-level `- ` bullet만 slice로 인정하며, nested bullet은 무시한다.
- slice가 0개면 PipelineEngine의 output selector 해석 단계에서 검증 실패로 처리하고, 해당 plan/refine step을 같은 session에 유효한 `## Slices` 섹션으로 다시 작성하라고 재요청한다.
- `as`는 현재 slice 문자열을 바인딩한다. MVP에서는 관례적으로 `as: slice`만 사용한다.
- `steps`는 항목당 1회 순차 실행
- 내부 step의 `id`는 외부에서 `${slices.<항목index>.<step_id>.output}` 같은 식 접근 X (MVP 미지원). 필요하면 가장 마지막 항목의 결과만 활용
- slice를 object로 파싱하거나 `goal`, `constraints`, `acceptance` 같은 필드를 구조화하는 output contract는 Forge Phase 2에서 검토한다.

## review_loop

```yaml
- type: review_loop
  id: quality
  until: ${review.passed}
  max_iterations: 3
  review:
    id: review
    intent: claude_review
    prompt_template: review_diff.md
    input_refs:
      diff: ${implement.diff_path}
  refine:
    id: refine
    intent: codex_execute
    prompt_template: refine_from_review.md
    input_refs:
      review: ${review.output_path}
      diff: ${implement.diff_path}
```

- `review` 실행 → `until` 평가 → 거짓이면 `refine` 실행 → 다시 `review` 실행
- `max_iterations`는 refine cycle 최대 횟수다. `max_iterations: 3`이면 최초 review 1회 + refine/review 최대 3회를 실행한다.
- `until`은 loop의 `review.id`에 대한 `${<review_step>.passed}`만 허용한다.
- `max_iterations` 도달 후에도 `until`이 거짓이면 review_loop.status=failed → task.status=failed
- MVP에서 `type: run`은 `until`을 갖지 않는다. 단일 step 조건 반복은 Forge Phase 2에서 필요성을 다시 검토한다.
- `review_loop`는 parent step row를 만들고, 내부 `review`/`refine` 실행 row는 `parent_step_id`로 loop row를 참조한다. 최초 review는 `iteration=0`, 첫 refine 뒤 review는 `iteration=1`이다.

### Review output contract

`kind: review` step은 output의 첫 non-empty line에 다음 중 하나를 써야 한다.

```markdown
Review Result: pass
```

```markdown
Review Result: fail
```

- `Review Result: pass` → `${<review_step>.passed}`는 `true`
- `Review Result: fail` → `${<review_step>.passed}`는 `false`
- 대소문자와 공백은 MVP에서 정확히 일치해야 한다.
- 헤더가 없거나 다른 값이면 review output contract 실패로 간주하고, 같은 session에 올바른 헤더를 포함해 다시 작성하라고 resume 요청한다.
- review 본문은 헤더 아래에 자유롭게 작성하지만, `review_loop` 종료 조건은 이 헤더만 신뢰한다.
- MVP에서 refine step은 `input_refs.review`로 review output 전체 파일을 받는다. findings/body를 구조화 파싱하지 않는다.

## pause_after

```yaml
- type: run
  id: critical_step
  intent: codex_execute
  prompt_template: critical_change.md
  pause_after: true
```

- step 완료 직후 task.status=paused
- 사용자는 중간 산출물을 확인하고 `/ask <task>` 로 질문하거나 피드백을 남길 수 있음
- `/resume <task>` 명령으로 다음 step부터 autonomous run 재개
- 기본값은 `pause_after: false`

## 검증

IntentRegistry.load:

1. intent id 중복 없음, 빈 문자열 아님
2. `kind`, `agent`, `harness` 필수
3. 참조한 agent가 `agents.yaml` 키와 매치
4. 참조한 harness가 `harnesses.yaml` 키와 매치

WorkflowRegistry.load:

1. id 중복 없음, 빈 문자열 아님
2. Executable Step의 intent가 `intents.yaml` 키와 매치
3. `${...}` 표현식이 알려진 step id/필드만 참조
4. `type`은 `run`, `group`, `review_loop`
5. `type: group`은 `foreach` + `as` + `steps`를 동반하고, `intent`, `prompt_template`, `prompt`를 갖지 않음
6. `type: run`, `review_loop.review`, `review_loop.refine`은 `prompt_template`을 필수로 갖고 `prompt`를 갖지 않음
7. `type: review_loop`은 `review`, `refine`, `until`, `max_iterations` 필수
8. `type: review_loop`의 `until`은 `${<review.id>.passed}` 형식만 허용
9. `type: review_loop`의 `review`가 참조하는 Intent는 `kind: review`여야 함
10. workflow의 모든 executable step이 `kind`, `agent`, `harness`를 직접 포함하면 validation 실패 (Forge Phase 2 override 후보)
11. workflow의 모든 executable step이 inline `prompt`를 직접 포함하면 validation 실패 (Forge Phase 2 후보)
12. `prompt_template`은 bundled template root 아래 상대 경로만 허용. 절대경로, `..`, root 밖 symlink escape 금지
13. 참조한 `prompt_template` 파일이 없으면 validation 실패
14. slice 구현 Step Group의 `foreach`는 MVP에서 `${task.final_slices}` 형식만 허용

`configs/workflows.yaml` 자체가 파싱되지 않으면 orchestrator startup은 실패한다. 프로젝트의 `default_workflow` 또는 `allowed_workflows`가 참조하는 workflow가 없거나 validation 실패하면 startup도 실패한다. 참조되지 않은 workflow library 항목이 invalid한 경우에는 해당 workflow를 disabled로 표시하고 startup은 계속 진행한다.

## 미지원 (Forge Phase 2+)

- `when` 조건 분기
- `parallel` 병렬 실행
- 외부 `tool` 호출
- 워크플로우 import/include
- 동적 step 생성
- 단일 `run` step의 `until` 조건 반복
- step-level Intent override (`kind`, `agent`, `harness`)
- 프로젝트별 `template_dir` override 실제 사용
- Intent Kind와 prompt template compatibility 강제 검증
- 임의 output field parser와 prompt template schema 검증
- slice object schema (`goal`, `constraints`, `acceptance` 등)

## 예시

[Forge Phase 1 MVP 풀 워크플로우 예시](../phases/phase-1-mvp.md#예시-워크플로우)
