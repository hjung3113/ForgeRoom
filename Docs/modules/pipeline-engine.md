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

AgentRunner는 output 파일 존재 여부, 크기, 기본 거부 응답 같은 generic 파일 검증만 수행한다. `${<step_id>.output.slices}`처럼 workflow DSL 의미가 필요한 output selector는 **Mastra step body 내부에서 ForgeRoom selector parser**가 해석한다 (ADR-016). 파싱 결과는 Mastra step output으로 반환되어 `.dountil()` condition과 다음 step input에 흐른다. Selector 검증 실패도 같은 output-producing attempt budget을 사용하며, 최종 실패 시 `failure_reason=output_contract_failed`로 기록한다.

MVP에서 `${<step_id>.output.slices}` 해석 규칙:

- `## Slices` 섹션 아래의 top-level `- ` bullet만 slice 문자열로 인정
- nested bullet은 무시
- slice가 0개면 selector 검증 실패
- 검증 실패 시 해당 plan/refine step을 같은 session에 유효한 `## Slices` 섹션으로 다시 작성하라고 resume 요청
- 이 재시도는 AgentRunner의 output-producing attempt budget(`MAX_AGENT_ATTEMPTS`, 기본 3)을 사용

MVP에서 `${<step_id>.passed}` 해석 규칙:

- 대상 step은 `kind: review`여야 한다.
- output의 첫 non-empty line이 정확히 `Review Result: pass`이면 `true`
- output의 첫 non-empty line이 정확히 `Review Result: fail`이면 `false`
- 헤더가 없거나 다른 값이면 selector 검증 실패
- 검증 실패 시 해당 review step을 같은 session에 올바른 `Review Result` 헤더로 다시 작성하라고 resume 요청
- 이 재시도는 AgentRunner의 output-producing attempt budget(`MAX_AGENT_ATTEMPTS`, 기본 3)을 사용

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
- checks 자동 수정은 workflow DSL의 새 step row가 아니다. 성공하면 같은 execute step row의 `check_fix_attempt`와 `check_status`를 갱신하고, `diff_path`는 자동 수정 결과를 포함한 최신 diff로 저장한다. Check fix는 AgentRunner output-producing attempt budget을 소비하지 않는다.

## Review input 전달

- `input_refs.review`는 review output 전체 파일 경로다.
- PipelineEngine은 `Review Result` 헤더만 `${<step_id>.passed}`로 파싱한다.
- findings/body는 구조화하지 않고 refine agent가 review 파일을 직접 읽어 해석한다.
- findings schema와 부분 추출은 Forge Phase 2의 output contract 확장 후보로 둔다.

## yaml DSL → Mastra 어댑터 (ADR-016 구현 메모)

`apps/orchestrator/src/dsl/to-mastra.ts`가 parsed workflow + Intent Catalog를 Mastra `createWorkflow()` 객체로 변환한다. 구현 세부:

- `type: run` → `.then(workerStep)`. worker body 순서: prompt render → AgentRunner.run → output/selector 검증 → CheckRunner(`kind: execute`만) → diff 저장 → Conductor.update.
- `pause_after: true` → worker 뒤에 `${intent}:${step}:pauseAfterGate` step을 append하고, suspend는 gate body에서 호출한다 (Conductor.update는 suspend 이전 완료).
- `type: group` + `foreach` → `${id}:items` 매핑 step으로 list를 산출한 뒤 `.foreach(itemStep, { concurrency: 1 })`. itemStep은 그룹 내부 step들을 한 iteration 안에서 순차 실행하고 `as` 식별자를 step input으로 바인딩한다. 내부 step의 `pause_after`는 itemStep body 안에서 native suspend로 처리한다 (OQ-M02 outcome a).
- `type: review_loop` → `${id}:seed` → `.dountil(loopStep, condition)` → `${id}:verify`. iteration은 OQ-M01 결과(native 미노출)에 따라 loopStep input/output schema로 thread한다. condition은 `inputData.passed`와 1-based `iterationCount`만 읽고, budget 소진 시 throw하지 않고 loop를 멈춘 뒤 verify step이 `review_loop_max_iterations`로 run을 실패시킨다 (condition throw는 run을 reject로 만들기 때문).
- output selector(`${step}.output.slices`, `${step}.passed`)는 worker body 안에서 주입된 parser로 파싱하고 step output(`StepExecution`)으로 반환해 `.dountil` condition과 downstream step으로 흐르게 한다.
- 어댑터 validate 실패는 `AdapterValidationError`(`failure_reason=adapter_validation_failed`)로 격상한다. catch 대상: unknown intent, missing prompt_template, invalid `until`/`review.passed`, review intent가 `kind: review`가 아님.
- 빌드 결과는 `sha256(mastraVersion + intentsSource + yamlSource)` 키로 캐시하며, yaml/intents/Mastra 버전 변경 시 무효화한다.

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

`recoverPending()`은 TaskStore step row를 권위로 본다. Mastra snapshot은 보조이며 권위 비교에 사용하지 않는다 (ADR-017).

- `recoverPending()`: `status IN ('running','paused')` task 조회
- task별 `steps` 마지막 row의 status 검사
  - `done`: 다음 step부터
  - `running`: 해당 step 재시작 (멱등 보장)
  - `failed`: 사용자 결정 대기
- 마지막 row가 control step이면 child rows의 마지막 상태와 `iteration`을 함께 보고 다음 review/refine 실행 지점을 복원한다.
- worktree의 `.forgeroom/` 디렉토리 존재 검증, 없으면 부트스트랩 재실행

### Mastra run resume 분기 (hybrid, ADR-017)

TaskStore가 가리키는 다음 step이 정해지면:

1. `tasks.mastra_run_id`가 not null이고 durable snapshot이 `status: 'suspended'`이며, snapshot이 참조하는 모든 출력 파일이 디스크에 존재하면 → Mastra `run.resume()` 호출. resume이 control-flow/loop 위치(어댑터가 thread한 `iteration` 포함)를 복원하므로 review_loop 재진입을 손으로 계산하지 않는다.
2. 불일치하거나 `mastra_run_id` null이면 → TaskStore pointer로 **신규 Mastra run 시작**. worker body는 멱등(prompt 재렌더 → agent 재실행 → output 재기록 → check 재실행)이므로 step 1부터 replay해 동일 상태를 재구성한다. 다음 step pointer는 절대 snapshot에서 유도하지 않는다.
3. `.forgeroom/outputs/NN_<step_id>.md` 파일이 snapshot이 가리키는 출력 경로와 불일치(파일 부재)하면 파일을 권위로 보고 snapshot을 폐기한 뒤 신규 run을 시작한다. snapshot은 출력 경로만 저장하므로 "파일 부재 = stale"가 구체적 FILE-WINS 검사다.

### recoverPending() 구현 (#9 완성)

`recoverPending()`은 active task(running/paused)를 열거하고 task별로 분기를 고른다:

1. 마지막 step row의 효과적 상태가 `failed` → 사용자 결정 대기, run하지 않음.
2. `.forgeroom/` skeleton이 없으면 `worktreeManager.create`로 재부트스트랩(멱등).
3. `mastra_run_id`가 있고 위 resume 조건을 만족 → `resumeRun()`.
4. 그 외 → snapshot 폐기 후 `startRun()`로 신규 replay.

한 task의 recovery 실패는 나머지를 중단시키지 않는다(해당 task만 `failed`로 기록하고 계속).

## Mastra runner 구현 메모 (#8)

`apps/orchestrator/src/core/pipeline-engine.ts`의 `MastraPipelineEngine`이 위 인터페이스를 구현한다. 내부는 #6 어댑터(`toMastraWorkflow`)가 만든 Mastra workflow run을 감싼다.

- `runFull`은 TaskSource의 유일한 진입점이다: task row 생성 → ApprovalGate admission(pre-Mastra) → WorktreeManager bootstrap → ForgeMap staging → 어댑터로 Mastra workflow build → `wf.createRun()` → `setMastraRunId`(run.start 이전, ADR-017) → `run.start()`.
- ApprovalGate는 이중 배치다: pre-Mastra(workflow/worktree admission)와 in-step(AgentRunner 호출 직전 명령 검사, step body에서 fail). 둘 다 테스트로 커버한다.
- `pause`는 협조적(cooperative)이다. 실행 중인 `run.start()`를 임의 step 사이에서 외부에서 선점할 수 없으므로(Mastra run이 실행 제어권을 가짐), pause는 의도를 기록하고 run이 실제 suspend(pauseAfterGate)로 resolve된 뒤에만 `status='paused'`로 전환한다. `paused`는 요청이 아니라 실제 suspension을 반영한다.
- `resume`은 `mastra_run_id`가 있고 durable snapshot이 존재하면 `run.resume()`, 아니면 TaskStore pointer로 신규 run을 시작한다(#9가 full hybrid를 완성).
- snapshot 영속은 InMemoryStore + 디스크 JSON bridge(OQ-M01에서 검증한 패턴, `FileSnapshotBridge`)로 한다. 프로세스 재시작 후 새 engine/store 인스턴스가 같은 dir에서 resume한다.
- `Reporter`/`ForgeMap`은 아직 미구현이므로 `ReporterSink`/`ForgeMapStager` 최소 seam으로 주입한다. 실제 구현은 별도 issue.
- `recoverPending`은 #9에서 hybrid resume-vs-fresh 분기로 완성됐다(위 "recoverPending() 구현" 참고).
- foreach list 평가 follow-up: 어댑터가 `${task.final_slices}`를 build 시점에 평가해 배열 reference를 캡처하므로, engine은 같은 배열을 in-place로 splice해 runtime slices를 흘려보낸다. 이는 임시 bridge이며, 어댑터가 list step에서 lazy 평가하도록 바꾸는 것이 옳다(별도 follow-up).

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
| Agent 실패 | AgentRunner output-producing attempt budget 사용. 소진 시 failed |
| output 파일 미작성 | AgentRunner output-producing attempt budget 사용. 소진 시 failed |
| `${<step_id>.output.slices}` 파싱 실패 | AgentRunner output-producing attempt budget 사용. 소진 시 failed |
| `${<step_id>.passed}` 파싱 실패 | AgentRunner output-producing attempt budget 사용. 소진 시 failed |
| Conductor scope 위반 | git revert, 텍스트만 사용 |
| Check 실패 | 별도 check fix budget 1회. 실패 로그로 agent 수정 요청 후 모든 check 재실행. 또 실패 → `failure_reason=check_failed_after_fix` |
| review_loop max_iterations 도달 | step.status=failed, task.status=failed, `failure_reason=review_loop_max_iterations` |
| 변수 보간 누락 | fail-fast |

상세는 [policies/error-retry.md](../policies/error-retry.md).
