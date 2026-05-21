---
status: decided
last_reviewed: 2026-05-21
---

# CheckRunner

## 책임

- `projects.yaml`의 `commands` 항목 실행 (test, lint, typecheck 등)
- 실패 시 1회 자동 재시도: 실패 로그를 코드 작성 agent에 전달 → 수정 → 재실행
- 결과 `checks` 테이블에 기록

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

1. `projects.yaml`의 `commands` 키를 정의된 순서대로 실행
2. 하나라도 exit ≠ 0:
   - 실패 로그(stdout+stderr 마지막 200줄)를 `.forgeroom/prompts/check_retry_<commandName>.md`에 작성
   - 워크플로우에서 마지막 코드 작성 step의 agent에 resume 또는 신규 호출로 수정 요청
   - 모든 check 재실행
3. 재시도 후에도 실패 시 task.status=failed

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
