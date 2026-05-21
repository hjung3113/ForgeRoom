---
status: decided
last_reviewed: 2026-05-21
---

# PipelineEngine

## 책임

- 워크플로우 DSL 해석 후 step 시퀀스 실행
- 변수 보간, foreach/review_loop 처리
- step 시작 전 Conductor.refine, step 종료 후 Conductor.update 호출
- AgentRunner / CheckRunner 호출
- 일시정지·재개·취소 명령 처리
- 재시작 후 미완료 task 재개

## 인터페이스

```typescript
interface PipelineEngine {
  runFull(projectId: string, input: TaskInput, opts?: RunOpts): Promise<TaskId>
  runNextStep(taskId: TaskId): Promise<void>
  pause(taskId: TaskId): Promise<void>
  resume(taskId: TaskId): Promise<void>
  cancel(taskId: TaskId): Promise<void>
  recoverPending(): Promise<void>     // 재시작 직후 호출
}

interface RunOpts {
  workflowId?: string
  agentOverrides?: Record<string, string>
  vars?: Record<string, string>
}
```

## 실행 알고리즘

```
for each parsed_step in workflow.steps:
  if foreach:
    list = evaluate(foreach.list_expr)
    for each item in list:
      sub_step = bind(parsed_step, item)
      execute_step(sub_step)        # 재귀
  elif review_loop:
    iteration = 0
    loop_row = create_control_step_row(parsed_step)
    execute_review(parsed_step.review, parent=loop_row, iteration)
    while not evaluate(review_loop.until) and iteration < max_iterations:
      execute_refine(parsed_step.refine, parent=loop_row, iteration)
      iteration += 1
      execute_review(parsed_step.review, parent=loop_row, iteration)
    if not evaluate(review_loop.until):
      loop_row.status = failed
      task.status = failed
      return
    loop_row.status = done
  else:
    execute_step(parsed_step)
```

`execute_step` 의 본체는 [prompt-file-protocol](../concepts/prompt-file-protocol.md) 의 "Step 실행 흐름" 참고. Resolved Step의 `kind`가 `execute`이면 agent output 검증 뒤 CheckRunner를 실행하고, checks가 통과한 뒤에 `diff_path`를 확정한다.

`group`과 `review_loop`는 agent를 직접 호출하지 않는 control step row를 만들고, 내부 executable step은 `parent_step_id`로 control row를 참조한다. `review_loop`의 최초 review는 `iteration=0`, 첫 refine은 `iteration=0`, refine 뒤 재실행되는 review는 `iteration=1`을 사용한다.

## 변수 보간 소스

- `${task.*}`: title, description, project, issue_number, branch, worktree_path, full_diff_path
- `${task.final_slices}`: 현재 task에서 실행 대상으로 최종 결정된 slice 문자열 list
- `${<step_id>.output}`, `${<step_id>.output_path}`, `${<step_id>.diff_path}`, `${<step_id>.passed}`
- `${<step_id>.output.slices}`: MVP에서 유일한 구조화 output selector. PipelineEngine이 해당 step output의 `## Slices` 섹션에서 top-level `- ` bullet을 문자열 list로 파싱한다.
- `${<step_id>.passed}`: `kind: review` step output의 첫 non-empty line에 있는 `Review Result: pass/fail` 헤더에서 bool로 파싱한다.
- `${vars.*}`: workflow 정의 + 호출 시 vars
- `${slice}` 등 foreach `as`로 도입된 식별자

## Output selector 해석

AgentRunner는 output 파일 존재 여부, 크기, 기본 거부 응답 같은 generic 파일 검증만 수행한다. `${<step_id>.output.slices}`처럼 workflow DSL 의미가 필요한 output selector는 PipelineEngine이 해석한다.

MVP에서 `${<step_id>.output.slices}` 해석 규칙:

- `## Slices` 섹션 아래의 top-level `- ` bullet만 slice 문자열로 인정
- nested bullet은 무시
- slice가 0개면 selector 검증 실패
- 검증 실패 시 해당 plan/refine step을 같은 session에 유효한 `## Slices` 섹션으로 다시 작성하라고 resume 요청
- 이 재시도는 output 파일 미작성과 같은 resume budget(최대 2회)을 사용

MVP에서 `${<step_id>.passed}` 해석 규칙:

- 대상 step은 `kind: review`여야 한다.
- output의 첫 non-empty line이 정확히 `Review Result: pass`이면 `true`
- output의 첫 non-empty line이 정확히 `Review Result: fail`이면 `false`
- 헤더가 없거나 다른 값이면 selector 검증 실패
- 검증 실패 시 해당 review step을 같은 session에 올바른 `Review Result` 헤더로 다시 작성하라고 resume 요청
- 이 재시도는 output 파일 미작성과 같은 resume budget(최대 2회)을 사용

MVP에서 `task.final_slices` 갱신 규칙:

- `implementation_plan.md` output의 slices로 초기화
- MVP full workflow에서는 plan review 결과와 관계없이 `refine_plan.md`를 항상 실행하고, refine output의 slices로 갱신
- plan review가 pass여도 그 사실을 refine input으로 전달할 뿐, refine step을 skip하지 않음
- slice 구현 Step Group은 특정 plan step output이 아니라 `${task.final_slices}`를 순회
- design/plan review는 default workflow에서 흐름 제어 조건으로 쓰지 않는다. code diff review만 `review_loop`의 gate로 사용한다.

## CheckRunner 트리거

- PipelineEngine은 Resolved Step의 `kind`가 `execute`일 때만 CheckRunner를 호출한다.
- `write_plan`, `review`, 문서 보강용 `refine` step은 checks를 실행하지 않는다.
- `review_loop.refine`이 `kind: execute`이면 각 refine iteration 뒤 checks를 실행하고, 통과한 뒤 다음 review로 넘어간다.
- `slice_impl`과 `slice_refine`은 모두 `kind: execute`이므로 review 전에 checks를 통과해야 한다.
- checks 자동 수정이 성공하면 같은 step row의 attempt/check 기록을 갱신하고, `diff_path`는 자동 수정 결과를 포함한 최신 diff로 저장한다.

## Review input 전달

- `input_refs.review`는 review output 전체 파일 경로다.
- PipelineEngine은 `Review Result` 헤더만 `${<step_id>.passed}`로 파싱한다.
- findings/body는 구조화하지 않고 refine agent가 review 파일을 직접 읽어 해석한다.
- findings schema와 부분 추출은 Forge Phase 2의 output contract 확장 후보로 둔다.

## 정지·재개

- 기본 실행 모드는 autonomous run. workflow가 끝나거나 실패하거나 pause checkpoint를 만날 때까지 다음 step을 계속 실행
- `runNextStep`: task 상태와 workflow 정의를 기준으로 실행 가능한 다음 step 1개만 실행. 임의 `step_id` 지정 실행은 지원하지 않음
- `pause_after: true`: 해당 step 완료 직후 task.status=paused. 사용자가 확인·피드백 후 `/resume`으로 다음 step 진행
- `pause`: 현재 step 종료 후 status=paused. AgentRunner 호출 도중엔 즉시 중단 X (다음 step 진입 직전 체크포인트)
- `resume`: status=paused → running. paused 시점의 다음 step부터 autonomous run 재개
- `cancel`: 즉시 status=canceled, `task_canceled` event 기록, active slot 해제, worktree/branch/PR 보존
- canceled task는 `resume` 불가. 이어서 작업하려면 보존된 worktree/branch를 사람이 확인한 뒤 새 task를 시작하거나 수동 처리
- 특정 step을 생략해야 하면 런타임 skip 대신 그 step이 없는 workflow를 선택한다

## 재시작 회복

- `recoverPending()`: `status IN ('running','paused')` task 조회
- task별 `steps` 마지막 row의 status 검사
  - `done`: 다음 step부터
  - `running`: 해당 step 재시작 (멱등 보장)
  - `failed`: 사용자 결정 대기
- 마지막 row가 control step이면 child rows의 마지막 상태와 `iteration`을 함께 보고 다음 review/refine 실행 지점을 복원한다.
- worktree의 `.forgeroom/` 디렉토리 존재 검증, 없으면 부트스트랩 재실행

## 의존

- WorkflowRegistry
- ProjectRegistry
- TaskStore
- WorktreeManager
- AgentRunner
- Conductor
- CheckRunner
- Reporter
- ApprovalGate

## 에러

| 케이스 | 처리 |
|---|---|
| Agent 실패 | step.attempt++, 1회 재시도. 또 실패 → failed |
| output 파일 미작성 | resume 재시도(최대 2회) |
| `${<step_id>.output.slices}` 파싱 실패 | resume 재시도(최대 2회). 또 실패 → failed |
| `${<step_id>.passed}` 파싱 실패 | resume 재시도(최대 2회). 또 실패 → failed |
| Conductor scope 위반 | git revert, 텍스트만 사용 |
| Check 실패 | 1회 자동 수정 후 재실행 |
| review_loop max_iterations 도달 | failed |
| 변수 보간 누락 | fail-fast |

상세는 [policies/error-retry.md](../policies/error-retry.md).
