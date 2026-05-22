---
status: decided
last_reviewed: 2026-05-21
---

# CheckRunner

## 책임

- `projects.yaml`의 `commands` 항목 실행 (test, lint, typecheck 등)
- 실패 시 1회 자동 재시도: 실패 로그를 코드 작성 agent에 전달 → 수정 → 재실행
- 결과를 `checks` 테이블에 append-only로 기록

## 인터페이스

```typescript
interface CheckRunner {
  run(task: Task, project: ProjectMeta): Promise<CheckRunResult>
}

interface CheckRunResult {
  allPassed: boolean
  results: CheckResult[]
}

interface CheckResult {
  commandName: string
  command: string
  exitCode: number
  durationMs: number
  stdoutPath: string
  stderrPath: string
}
```

## 실행 정책

1. PipelineEngine은 Resolved Step의 `kind`가 `execute`인 step 직후에만 CheckRunner를 호출한다.
2. `projects.yaml`의 `commands` 키를 정의된 순서대로 실행
3. 하나라도 exit ≠ 0:
   - 실패 로그(stdout+stderr 마지막 200줄)를 `.forgeroom/prompts/check_retry_<commandName>.md`에 작성
   - `check_fix_attempt = 1`로 기록하고, 워크플로우에서 마지막 코드 작성 step의 agent에 resume 또는 신규 호출로 수정 요청
   - 모든 check 재실행
4. 재시도 후에도 실패 시 task.status=failed

CheckRunner는 `kind: write_plan`, `kind: review`, 문서 보강용 `kind: refine` step 뒤에는 실행하지 않는다. `review_loop.refine`이 `kind: execute`이면 매 refine iteration 뒤 실행하고, 다음 review는 checks를 통과한 diff를 대상으로 한다.

CheckRunner는 ForgeRoom이 직접 실행한다. test/lint/typecheck는 agent runtime 호출이 아니라 프로젝트 검증 명령이며, exit code/stdout/stderr/timeout은 workflow 품질 게이트의 근거이므로 OpenClaw에 위임하지 않는다.

CheckRunner 자동 수정은 AgentRunner의 output-producing attempt budget과 분리된 check fix budget이다. 자동 수정 요청은 AgentRunner를 호출하지만, 원래 execute step이 valid output을 만든 뒤 발생한 품질 게이트 실패를 보정하는 흐름이다. MVP의 check fix budget은 1회이며, 재실패 시 `failure_reason=check_failed_after_fix`로 task.status=failed를 기록한다. 최초 check 결과는 `checks.check_fix_attempt=0`, 자동 수정 후 재실행 결과는 `checks.check_fix_attempt=1`로 보존한다.

자동 수정은 workflow DSL의 새 step row가 아니다. 원 execute step row 아래에 `check_fix_attempt`와 `check_status`로 기록하고, `diff_path`는 자동 수정 결과까지 포함한 최신 diff를 가리킨다. 자동 수정 agent 호출의 prompt/output/log는 별도 artifact로 남긴다.

`check_status=passed`는 첫 check run에서 통과한 상태, `check_status=fixed`는 자동 수정 뒤 통과한 상태, `check_status=failed`는 최종 check 실패 상태다. `kind: execute`가 아닌 step은 `check_status=not_run`을 유지한다.

예:

- `.forgeroom/prompts/check_fix_<step_id>.md`
- `.forgeroom/outputs/check_fix_<step_id>.md`
- `.forgeroom/logs/check_fix_<step_id>.stdout`
- `.forgeroom/logs/check_fix_<step_id>.stderr`

## 명령 정의

```yaml
projects:
  my-app:
    commands:
      test: npm test
      lint: npm run lint
      typecheck: npm run typecheck
```

- 명령 미정의 항목은 스킵 (선택)
- 모든 명령은 worktree path에서 실행 (cwd=worktree)

## 의존

- ProjectRegistry
- TaskStore (checks 기록)
- AgentRunner (재시도 시 수정 요청)

## 에러

- 명령 실행 자체 실패 (cmd not found 등) → exitCode=127, check 실패로 기록
- 타임아웃 → 기본 30분 상한, 초과 시 SIGTERM 후 SIGKILL

## 출력 경로

- `<worktree>/.forgeroom/logs/check_<commandName>.stdout`
- `<worktree>/.forgeroom/logs/check_<commandName>.stderr`

## 보안

- 명령 실행은 worktree 내부로 제한 (cwd 강제)
- ApprovalGate에서 명령 문자열에 금지 패턴(`rm -rf /`, `curl | sh` 등) 있으면 거부
