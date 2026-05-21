---
status: decided
last_reviewed: 2026-05-21
---

# PipelineEngine

## 책임

- 워크플로우 DSL 해석 후 step 시퀀스 실행
- 변수 보간, foreach/until 처리
- step 시작 전 Conductor.refine, step 종료 후 Conductor.update 호출
- AgentRunner / CheckRunner 호출
- 일시정지·재개·스킵·취소 명령 처리
- 재시작 후 미완료 task 재개

## 인터페이스

```typescript
interface PipelineEngine {
  runFull(projectId: string, input: TaskInput, opts?: RunOpts): Promise<TaskId>
  runStep(taskId: TaskId, stepId: string, opts?: RunOpts): Promise<void>
  pause(taskId: TaskId): Promise<void>
  resume(taskId: TaskId): Promise<void>
  skip(taskId: TaskId, stepId: string): Promise<void>
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
  elif until:
    iteration = 0
    while not evaluate(until.condition) and iteration < max_iterations:
      execute_step_iteration(parsed_step, iteration)
      iteration += 1
    if not evaluate(until.condition):
      step.status = failed
      task.status = failed
      return
  else:
    execute_step(parsed_step)
```

`execute_step` 의 본체는 [prompt-file-protocol](../concepts/prompt-file-protocol.md) 의 "Step 실행 흐름" 참고.

## 변수 보간 소스

- `${task.*}`: title, description, project, issue_number, branch, worktree_path, full_diff_path
- `${<step_id>.output}`, `${<step_id>.output_path}`, `${<step_id>.diff_path}`, `${<step_id>.passed}`
- `${vars.*}`: workflow 정의 + 호출 시 vars
- `${phase}` 등 foreach `as`로 도입된 식별자

## 정지·재개

- `pause`: 현재 step 종료 후 status=paused. AgentRunner 호출 도중엔 즉시 중단 X (다음 step 진입 직전 체크포인트)
- `resume`: status=paused → running. paused 시점의 다음 step부터
- `skip`: 지정 step.status=skipped, 다음 step으로
- `cancel`: 즉시 status=canceled, worktree 보존

## 재시작 회복

- `recoverPending()`: `status IN ('running','paused')` task 조회
- task별 `steps` 마지막 row의 status 검사
  - `done`: 다음 step부터
  - `running`: 해당 step 재시작 (멱등 보장)
  - `failed`: 사용자 결정 대기
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
| Conductor scope 위반 | git revert, 텍스트만 사용 |
| Check 실패 | 1회 자동 수정 후 재실행 |
| until max_iterations 도달 | failed |
| 변수 보간 누락 | fail-fast |

상세는 [policies/error-retry.md](../policies/error-retry.md).
