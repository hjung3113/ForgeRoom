---
status: decided
date: 2026-06-20
---

# ADR-030: Worktree 바인딩 — 태스크별 ephemeral OpenClaw agent

## 배경

2026-06-20 main(`a52422b`) 라이브 부팅 검증에서 전체 파이프라인(boot → GitHubIssueTaskSource → `quick` 워크플로 → 실제 agent)을 **실측 task로 처음** 돌렸고, plan 단계가 `agent_error`로 죽었다 (issue #111).

근본 원인은 **OpenClaw agent의 workspace가 worktree에 바인딩되지 않는다**는 것이다.

- 실행 경로: `OpenClawProvider` → `openclaw agent --json --agent main --message <인라인 프롬프트> [--model] [--timeout]` (gateway mode, 127.0.0.1:18789).
- provider는 이미 프롬프트 파일 내용을 `--message`로 **인라인**하고, agent의 JSON 응답을 받아 출력 파일을 **직접 기록**한다. 즉 agent는 프롬프트/출력 용도로 FS를 건드리지 않는다.
- 그러나 `openclaw agent` CLI에는 `--cwd`/`--workspace` 플래그가 **없다**. gateway mode에서 모든 agent는 전역 설정 `agents.defaults.workspace = $HOME`에서 실행된다.
- ForgeRoom은 태스크마다 git worktree를 생성한다. `quick` = plan(claude) → implement(codex).
  - **plan**: harness 계약이 worktree의 `.forgeroom/context/{task,target-profile,selected-forgemap}.md`를 **읽으라**고 지시. $HOME 기준에서는 없음 → agent가 "무슨 task냐"고 되물음 → `## Slices` 없음 → `agent_error` (실측됨).
  - **implement** (`execute.md`): "worktree에서 실제 코드 변경을 만들라". PR은 worktree의 `git status --porcelain` diff로 만들어진다. 즉 agent가 worktree에 **소스를 기록**해야 한다.

기존 테스트가 못 잡은 이유: `openclaw-provider.e2e.ts`와 `smoke:openclaw`는 자체 완결 프롬프트라 cwd 무관(provider가 stdout→절대경로 출력). 통합 테스트는 fake. worktree-컨텍스트 의존은 이번이 첫 실측.

codex grill(2026-06-20, 2 라운드)로 검증했다. 신뢰도를 항목별로 표기한다.

## 검토한 대안과 기각 근거

### 옵션 1 — 컨텍스트를 `--message`에 전부 인라인 (기각, codex 86)

provider가 이미 프롬프트를 인라인하므로 컨텍스트 파일도 인라인하면 **plan의 읽기**는 해결된다. 그러나 **implement는 worktree에 소스를 기록**해야 하고, 입력 인라인은 쓰기 권한을 주지 못한다. 현재 "agent가 worktree를 변경 → ForgeRoom이 git diff로 PR" 설계에서 인라인-only는 implement를 풀 수 없다. patch-emission 설계(agent가 diff를 내고 ForgeRoom이 apply)는 가능하지만 **다른 실행 모델**이다 — 출력 계약, 검증, 재시도, check-fix, PR diff 소유권을 가로지른다. blocker 크기의 수정이 아니다.

### 옵션 3 — `--local` + 프로세스 cwd = worktree (기각, 실측으로 사망)

cwd=`/tmp/probe`에서 `openclaw agent --local`을 실행하고 cwd-상대 쓰기를 지시했으나, agent는 `workspaceDir=$HOME`을 보고했고 cwd에 아무것도 쓰지 않았다. **workspace는 OpenClaw agent 설정에 바인딩되며 cwd/`--local`과 무관하다.** 옵션 3은 불가능.

## 결정

### 1. 태스크별 ephemeral OpenClaw agent를 worktree에 바인딩 (codex 91)

OpenClaw는 per-agent workspace를 1급으로 지원한다:

```
openclaw agents add <name> --workspace <dir> --non-interactive --model <id> --json   # 격리 agent 생성(workspace+state)
openclaw agents delete <name>                                                        # workspace/state prune
```

태스크마다:

1. 첫 agent step 전에 `fr-<taskid>` agent를 `--workspace <worktree>`로 **생성**한다.
2. plan·implement·재시도 **모든 step**을 이 agent로 실행한다 (`--agent fr-<taskid>`). 절대 `main`으로 fallback하지 않는다. runtime/model은 step별 `--model`로 전환한다 (한 agent의 `defaults.models`에 `claude-cli/*`와 `openai/*`가 모두 있어 plan/implement 둘 다 한 agent로 가능).
3. 터미널 settle(done/failed/cancelled)에서 agent를 **삭제**한다.

**per-role(`fr-<taskid>-planner` 등)이 아니라 per-task** 단일 agent로 한다 (codex 91): task 컨텍스트/세션 공유를 보존하고 lifecycle churn을 최소화한다. per-role은 role별 도구/모델/상태 격리가 실제로 필요해질 때(후속)로 미룬다.

### 2. Unblocking PR가 반드시 포함할 것 (codex 88)

- create-before-run, 생성된 agent를 **모든 step/재시도**에 사용, **delete-on-terminal**(done/failed/cancelled 경로 전부).
- ephemeral agent 이름은 task에 저장하거나 task id에서 **결정적으로** 도출한다 (재시도/resume이 `main`으로 새지 않게).
- **auth smoke (codex 84, 최상위 리스크)**: 새로 생성한 agent가 수동 로그인 없이 설정된 runtime/model(plan은 `claude-cli/claude-opus-4-7`, implement는 `openai/gpt-5.5`) **둘 다** 실행 가능함을 PR에서 증명한다. per-agent auth 부트스트랩이 필요하면 그 자체가 blocker다.

### 3. 후속으로 미룸 (codex 82)

- **boot-time reconciliation** (곧): `fr-*` agent 목록과 nonterminal TaskStore 행을 대조해 stale/unknown agent를 삭제. 이름이 결정적이고 delete-on-settle이 있으면 첫 수정의 blocker는 아니다.
- per-role agent, 풍부한 GC/TTL 정책.
- add/delete 지연: 측정 후 MVP에서는 수용(극단적이지 않은 한).

## 영향받는 문서/코드 (decided 시 같은 커밋에서 갱신)

- `apps/orchestrator/src/app/openclaw-ipc.ts` — agent lifecycle(add/delete) IPC 추가.
- `apps/orchestrator/src/app/openclaw-provider.ts` 또는 `core/agent-runtime/agent-runner.ts` — create-before-run / use / delete-on-terminal 연결.
- `Docs/modules/<agent-runtime>.md`, 해당 폴더 `context-map.md`.
- ADR 파일 기반 프롬프트 패싱 결정과의 관계 명시(인라인 입력은 유지, 쓰기는 worktree-바인딩 agent가 수행).

## 미해결 (decided 전 확인)

- `agents add`가 `defaults.models`를 상속하는지, 아니면 `--model`로 준 단일 모델만 허용하는지 — auth smoke가 plan/implement 두 runtime을 한 agent로 증명하며 함께 검증.
- 동시 task 시 agent 이름 충돌 없음(task id 기반이라 격리되나, 격리 agent 수 상한/리소스 확인).

關聯: issue #111, ADR-027(harness contract staging), ADR-029(full step harness).
