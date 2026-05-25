---
status: decided
date: 2026-05-25
---

# ADR-025: Branch-publication external effect + no-diff terminal success

## 배경

ADR-019는 PR 생성을 PipelineEngine 소유 workflow external effect로 결정했다. 그러나 두 가지 빠진 부분이 있었다:

1. **브랜치 publish 단계 없음** — agent run 완료 후 worktree 변경 사항을 commit/push하는 단계가 없어, PR를 생성하기 전에 head 브랜치가 실제로 원격에 push되지 않았다.
2. **no-diff 종료 경로 없음** — agent run이 변경 사항을 만들지 않을 때(git status --porcelain 빈 출력) clean한 terminal-success 경로가 없었다. PR을 생성할 이유가 없지만 task도 실패 처리하면 안 된다.

## 결정

### 1. Branch-publication external effect (ADR-025 추가)

`settle()`의 success 경로에 branch-publication 단계를 PR effect **이전**에 삽입한다:

1. **Branch publication** — worktree 변경 사항 commit + push (git-cli seam을 통해).
2. **No-diff 분기** — publish 결과가 `noDiff: true`이면 PR 생성 건너뜀 → `task_done_no_diff` ReporterEvent emit → task `done` (terminal SUCCESS).
3. **Diff 있는 경우** — 기존 ADR-019 경로 유지: PR effect 실행 → task `done`.

### 2. Git-cli seam 확장

`app/git-cli.ts`에 두 메서드 추가:

- `commit({ cwd, message })` — `git add --all && git commit --message <msg>`. 실패 시 throw.
- `push({ cwd, branch, remote? })` — `git push <remote> <branch>`. 원격 기본값 `origin`. 실패 시 throw.

### 3. Narrow port interface in core/effects

`BranchPublishPort` interface를 `core/effects/branch-publisher.ts`에 정의:
```ts
interface BranchPublishPort {
  statusPorcelain(cwd: string): Promise<string>;
  commit(input: { cwd: string; message: string }): Promise<void>;
  push(input: { cwd: string; branch: string; remote?: string }): Promise<void>;
}
```

`GitCli`는 이 interface를 구조적으로 만족한다 (app layer에서 wiring). `core`는 `app/git-cli.ts`를 직접 import하지 않는다 (core AGENTS.md rule 1 준수).

### 4. Effect 순서

```
settle() success path:
  1. branchEffect.run()    ← commit + push (ADR-025, new)
     └─ noDiff: true  →  task.done + task_done_no_diff event → return
     └─ noDiff: false →  continue
  2. prEffect.run()        ← PR creation (ADR-019, existing)
  3. task.done
```

### 5. 새 ReporterEvent: task_done_no_diff

`core/types.ts`의 `ReporterEvent` union에 추가:
```ts
| { type: 'task_done_no_diff'; task: Task }
```

Reporter sinks는 "no changes produced by agent; nothing to PR"를 status surface에 게시한다.

### 6. 새 failure code: branch_publish_failed

`core/errors.ts`의 `ORCHESTRATOR_FAILURE_CODES`에 추가. Commit 또는 push 실패 시 `BranchPublishFailedError`를 throw하고 task `failed`로 처리한다 (PR effect의 `pr_create_failed`와 같은 패턴).

## No-diff 신호 판별

`git status --porcelain` 출력이 빈 문자열(trim 후)이면 no-diff로 판단한다. `step-collaborators.ts`의 `diffPath`는 사용하지 않는다 — `diffPath`는 passthrough이고 보통 null이라 신뢰할 수 없다.

## Composition root wiring

`app/composition-root.ts`에 `buildBranchPublisher()` 대신 인라인으로 `GitCli`를 `BranchPublishPort`로 사용하는 `BranchPublisher`를 생성하여 `PipelineEngineDeps.branchPublisher`에 주입한다.

## 결과

- `core/errors.ts`: `branch_publish_failed` 추가
- `core/types.ts`: `task_done_no_diff` ReporterEvent 추가
- `core/effects/branch-publisher.ts`: 신규 (BranchPublishPort + BranchPublisher + BranchPublishFailedError)
- `core/effects/branch-publisher.test.ts`: 신규
- `core/engine/branch-publication-external-effect.ts`: 신규 (engine wrapper)
- `core/engine/pipeline-engine.ts`: settle() 확장, BranchPublicationExternalEffect 주입
- `core/engine/pipeline-engine.test.ts`: ADR-025 integration tests 추가
- `core/reporting/reporter.ts`: task_done_no_diff 렌더링 추가
- `app/git-cli.ts`: commit + push 메서드 추가
- `app/composition-root.ts`: BranchPublisher wiring 추가

## 관련

- ADR-019: PR 생성 external effect (이 ADR이 참조하고 extend함)
- ADR-013: TaskSource/Reporter 경계 (task_done_no_diff는 ADR-013의 Reporter 메커니즘을 통해 전달)
- Issue #63
