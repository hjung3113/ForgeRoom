# ForgeRoom 설계 명세

- **작성일**: 2026-05-21
- **상태**: MVP 설계 확정 (Phase 1 범위)
- **기반 문서**: `Docs/local_multi_agent_collaboration_design_concise.md` + 워크플로우 슬라이드 7장 + 데스크탑 앱 목업 2장
- **범위**: 로컬 단일 머신에서 동작하는 중앙 멀티에이전트 오케스트레이터. 데스크탑 앱은 Phase 3.

---

## 1. 목적과 핵심 원칙

### 목적

- 모바일·원격에서 로컬 프로젝트에 작업 지시
- 로컬에 설치된 CLI 에이전트(Claude Code, Codex, Gemini CLI 등)를 그대로 활용
- Discord는 명령·알림·승인 UI, GitHub Issue/PR은 작업 원장
- 작업별 branch + worktree로 충돌 방지
- 실제 프로젝트에는 최소 파일만 추가 (`AGENTS.md` 정도)
- 워크플로우는 yaml로 자유롭게 정의·재사용

### 핵심 원칙

1. 오케스트레이터는 중앙에 1개만 둔다 (`~/forgeroom/`)
2. 실제 프로젝트에는 거의 아무것도 심지 않는다
3. 프로젝트는 설정(`projects.yaml`)으로 등록한다
4. 한 작업 = 1 Issue = 1 Branch = 1 Worktree = 1 PR
5. 작업은 worktree로 격리한다
6. 소통은 Discord / GitHub로 한다
7. 실행은 로컬에서 한다
8. 품질은 Git / 테스트 / 리뷰로 강제한다
9. 에이전트는 turn-taking, 같은 worktree 공유
10. 프롬프트는 파일 기반 전달(CLI 직접 주입 X)

---

## 2. 아키텍처 개요

```
┌────────────────────────────────────────────────────────┐
│ Cloud (outbound only)                                  │
│   Discord ↔ GitHub                                     │
└──────────────────▲─────────────────────────────────────┘
                   │ outbound (ws/HTTPS)
┌──────────────────┴─────────────────────────────────────┐
│ Local Machine — ForgeRoom Orchestrator (단일 프로세스)  │
│                                                        │
│  ┌──────────────┐   ┌──────────────────────────────┐   │
│  │ Gateway      │   │ Core                         │   │
│  │ - DiscordBot │   │ - TaskStore (SQLite)         │   │
│  │ - GitHubHook │──▶│ - PipelineEngine             │   │
│  └──────────────┘   │ - WorkflowRegistry           │   │
│                     │ - ProjectRegistry            │   │
│                     │ - WorktreeManager            │   │
│                     │ - AgentRunner (→ OpenClaw)   │   │
│                     │ - Conductor (메타 에이전트)   │   │
│                     │ - CheckRunner                │   │
│                     │ - Reporter                   │   │
│                     │ - ApprovalGate               │   │
│                     └──────────────────────────────┘   │
│                                                        │
│  ~/forgeroom/                  ← 설정·DB·로그          │
│  ~/forgeroom/worktrees/<project>-<task>/               │
│  ~/projects/<project>/         ← 실제 레포 (변경 최소) │
└────────────────────────────────────────────────────────┘
```

- **런타임**: Node.js + TypeScript
- **저장소**: SQLite (better-sqlite3 + Drizzle ORM)
- **에이전트 실행**: OpenClaw에 위임 (claude-cli, openai-codex, google-gemini-cli 등)
- **외부 통신**: outbound only. Discord WebSocket + GitHub API polling. inbound 포트 X
- **Tailscale**: MVP 제외, Phase 3에서 데스크탑 앱과 함께 도입

---

## 3. 모듈 분해

| 모듈 | 책임 | 의존 |
|---|---|---|
| ProjectRegistry | `configs/projects.yaml` 로드/검증, 프로젝트 메타 조회 API | yaml 파서 |
| WorkflowRegistry | `configs/workflows.yaml` 로드, 워크플로우 이름으로 조회 | yaml 파서 |
| OpenClawAgentRegistry | OpenClaw 설정 읽어 사용 가능 agent runtime 목록 노출 | OpenClaw API |
| TaskStore | SQLite. task/step/check/event/conductor_state CRUD, 큐 역할 | better-sqlite3, Drizzle |
| PipelineEngine | 워크플로우 DSL 해석, 단계 실행, foreach/until 처리, 일시정지/재개/스킵 | TaskStore, AgentRunner, CheckRunner, Conductor |
| WorktreeManager | `git worktree` 생성·삭제, branch 관리, `.forgeroom/` 디렉토리 부트스트랩 | git CLI |
| AgentRunner | OpenClaw에 에이전트 호출 위임 (headless 기본, PTY 옵션), 파일 기반 IO | OpenClaw IPC/HTTP |
| Conductor | task별 누적 컨텍스트 유지, step 프롬프트 보강, 사용자 질문 응답 | AgentRunner |
| CheckRunner | `projects.yaml`에 명시된 명령 실행, 결과 파싱, 1회 자동 재시도 트리거 | child_process |
| Reporter | 단계별 Discord 메시지, GitHub PR 코멘트, 멱등성 보장 | DiscordClient, Octokit, TaskStore.events |
| DiscordGateway | 슬래시 명령 파싱, allowlist 검증, PipelineEngine 호출 | discord.js |
| GitHubGateway | Issue 라벨 polling, PR 생성, 라벨 매치 시 작업 트리거 | Octokit |
| ApprovalGate | 위험 명령(deploy/migration/main 직접 수정/`.env` 접근 등) 거부 | path/cmd 매처 |

### 핵심 인터페이스

```typescript
interface PipelineEngine {
  runFull(projectId: string, input: TaskInput, opts?: RunOpts): Promise<TaskId>
  runStep(taskId: TaskId, stepId: string, opts?: RunOpts): Promise<void>
  pause(taskId: TaskId): Promise<void>
  resume(taskId: TaskId): Promise<void>
  skip(taskId: TaskId, stepId: string): Promise<void>
  cancel(taskId: TaskId): Promise<void>
}

interface RunOpts {
  workflowId?: string                       // 미지정 시 projects.yaml의 default_workflow
  agentOverrides?: Record<string, string>   // { plan: 'gemini-agent', review: 'claude' }
  vars?: Record<string, string>             // 호출 시 추가 변수
}

interface AgentRunner {
  run(req: {
    agentId: string                         // OpenClaw runtime 식별자
    promptPath: string                      // worktree 내 프롬프트 파일 절대경로
    outputPath: string                      // worktree 내 출력 파일 절대경로
    cwd: string                             // worktree 경로
    mode: 'headless' | 'pty'
    timeoutMs?: number
  }): Promise<AgentRunResult>
  resume(sessionId: string, addendumPromptPath: string): Promise<AgentRunResult>
}

interface Conductor {
  init(taskId: TaskId): Promise<void>
  update(taskId: TaskId, stepResult: StepResult): Promise<void>     // summary 갱신
  refine(taskId: TaskId, stepId: string, basePrompt: string): Promise<string>
  answer(taskId: TaskId, question: string): Promise<string>
}
```

---

## 4. 데이터 모델 (SQLite + Drizzle)

```typescript
// tasks: 한 작업 단위
tasks {
  id: string                       // uuid
  project_id: string               // projects.yaml key
  workflow_id: string              // workflows.yaml key
  title: string
  description: string
  status: 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'canceled'
  source: 'discord' | 'github-label'
  issue_number: number | null
  branch_name: string
  worktree_path: string            // 절대경로
  pr_number: number | null
  agent_overrides: json            // { 'design': 'gemini-agent', ... }
  vars: json                       // 호출 시 전달된 vars
  created_at, updated_at: timestamp
}

// steps: 파이프라인 단계 실행 기록
steps {
  id: string                       // uuid
  task_id: string                  // fk
  step_id: string                  // workflow DSL의 id (자유 문자열)
  parent_step_id: string | null    // foreach 내부 step의 부모
  iteration: number                // until/foreach 반복 번호 (기본 0)
  agent_id: string                 // 실제 사용된 OpenClaw runtime
  status: 'pending' | 'running' | 'paused' | 'done' | 'failed' | 'skipped'
  attempt: number                  // 출력 파일 재생성/agent 재시도 카운터
  prompt_path: string              // 절대경로
  output_path: string              // 절대경로
  diff_path: string | null
  exit_code: number | null
  started_at, finished_at: timestamp
}

// checks: CheckRunner 실행 결과
checks {
  id: string
  step_id: string                  // 어떤 단계 직후 실행됐는지
  command_name: string             // 'test' | 'lint' | 'typecheck' 또는 자유 문자열
  command: text                    // 실제 실행 명령
  exit_code: number
  stdout_path: string              // 큰 출력은 파일로
  stderr_path: string
  duration_ms: number
  created_at: timestamp
}

// events: Reporter 발송 멱등성
events {
  id: string
  task_id: string
  type: string                     // 'plan_done', 'check_result', 'pr_created', 'failure', 'ask_response' 등
  payload: json
  destination: 'discord' | 'github'
  delivered_at: timestamp | null
  created_at: timestamp
}

// conductor_state: task별 Conductor 컨텍스트
conductor_state {
  task_id: string                  // pk
  summary: text                    // 누적 요약 (마크다운)
  last_step_id: string | null
  last_updated: timestamp
  summary_path: string             // .forgeroom/context/summary.md 절대경로
}
```

### 핵심 불변식

- **1 task = 1 worktree = 1 branch = 1 PR**
- 동일 `project_id`에 `status IN ('running','paused')` 인 task는 최대 1개 (in-process 락 + DB 유니크 인덱스로 강제)
- step 재시도 시 같은 row의 `attempt` 증가, 새 row 생성 X (이력은 logs/ 디렉토리 + diff snapshot으로 보존)
- prompt/output 본문은 파일이 primary, DB에는 경로만 저장

---

## 5. 워크플로우 DSL

### 라이브러리 + 호출 모델

워크플로우는 `configs/workflows.yaml`에 이름으로 정의. 프로젝트는 사용 가능한 워크플로우 목록 + 기본값 지정. 호출 시 선택.

```yaml
# configs/workflows.yaml
workflows:
  full:
    description: "설계→리뷰→보강→계획→phase 반복 구현→최종 리뷰"
    steps:
      - id: design
        agent: claude
        prompt_template: "design.md"

      - id: design_review
        agent: codex
        prompt_template: "review.md"
        input_refs:
          target: ${design.output_path}

      - id: design_refine
        agent: claude
        prompt_template: "refine.md"
        input_refs:
          original: ${design.output_path}
          review: ${design_review.output_path}

      - id: impl_plan
        agent: claude
        prompt_template: "impl_plan.md"

      - id: impl_plan_review
        agent: codex

      - id: impl_plan_refine
        agent: claude

      - id: phases
        foreach: ${impl_plan_refine.output.phases}    # output 마크다운에서 phase 리스트 파싱
        as: phase
        steps:
          - id: phase_impl
            agent: codex
            prompt_template: "phase_impl.md"
            vars:
              phase: ${phase}

          - id: phase_review
            agent: claude
            prompt_template: "review.md"
            input_refs:
              diff: ${phase_impl.diff_path}

          - id: phase_refine
            agent: codex
            until: ${phase_review.passed}
            max_iterations: 3
            prompt_template: "refine.md"

      - id: final_review
        agent: claude
        input_refs:
          full_diff: ${task.full_diff_path}

      - id: final_refine
        agent: codex

      - id: final_rereview
        agent: claude

  quick:
    description: "간단 작업"
    steps:
      - id: plan
        agent: claude
      - id: implement
        agent: codex
      - id: review
        agent: claude
      - id: fix
        agent: codex
        until: ${review.passed}
        max_iterations: 2

  hotfix:
    description: "긴급 수정"
    steps:
      - id: fix
        agent: codex
      - id: review
        agent: claude
```

```yaml
# configs/projects.yaml
projects:
  my-app:
    path: /Users/me/projects/my-app
    default_branch: main
    package_manager: npm
    default_workflow: quick
    allowed_workflows: [full, quick, hotfix]
    template_dir: null                  # null이면 ~/forgeroom/templates 사용
    commands:
      test: npm test
      lint: npm run lint
      typecheck: npm run typecheck
```

```yaml
# configs/agents.yaml — OpenClaw runtime 참조
agents:
  claude:
    openclaw_runtime: claude-cli
    model: anthropic/claude-opus-4-7
  codex:
    openclaw_runtime: openai-codex
    model: openai/gpt-5.5
  gemini:
    openclaw_runtime: google-gemini-cli
    model: google/gemini-3.1-pro-preview

conductor:
  openclaw_runtime: claude-cli
  model: anthropic/claude-opus-4-7
```

### MVP 표현력

지원:
- 자유 step `id` (문자열)
- step별 `agent` 지정 + 호출 시 `agentOverrides`로 덮어쓰기
- `prompt_template`(파일 경로) 또는 inline `prompt`
- `input_refs`: 다른 step의 output/diff 파일 경로 주입
- 변수 보간: `${task.*}`, `${<step_id>.output}`, `${<step_id>.output_path}`, `${<step_id>.diff_path}`, `${<step_id>.passed}`, `${vars.*}`, `${phase}` (foreach 내부)
- `foreach: <list-expr> / as: <name> / steps: [...]`: 직전 step 출력에서 추출한 리스트 반복
- `until: <bool-expr> / max_iterations: N`: 조건 충족까지 반복
- `pause_after: true`: 단계 종료 후 자동 정지

미지원 (Phase 2+):
- `when` 조건 분기
- `parallel` 병렬 실행
- 외부 `tool` 호출
- 워크플로우 import/include
- 동적 step 생성 (현재 시점에 없던 step을 런타임 추가)

### 변수 보간 규칙

1. 모든 `${...}` 치환은 step 시작 직전 1회 평가
2. 누락 변수 → fail-fast (에러 즉시, 다음 step 실행 X)
3. 큰 본문(`${design.output}`)은 인라인 치환하지 말고 가급적 `input_refs`로 파일 경로 전달
4. prompt injection 방어:
   - 외부 입력(issue body 등) 치환 전 길이 상한(8000 토큰 추정치) 적용
   - 코드 펜스로 wrapping 권장 (템플릿 작성자 책임)

---

## 6. 파일 기반 프롬프트 전달

### 폴더 컨벤션 (worktree 내부)

```
<worktree>/.forgeroom/
├── context/
│   ├── task.md              # 작업 메타: 제목, 설명, issue 링크, workflow 이름
│   ├── summary.md           # Conductor가 유지하는 누적 요약
│   └── workflow.md          # 사용된 워크플로우 스냅샷
├── prompts/
│   ├── 01_design.md
│   ├── 02_design_review.md
│   ├── 03_design_refine.md
│   └── ...
├── outputs/
│   ├── 01_design.md
│   ├── 02_design_review.md
│   └── ...
├── diffs/
│   ├── 03_design_refine.diff
│   └── ...
└── logs/
    ├── 01_design.stdout
    └── 01_design.stderr
```

### Step 실행 흐름

```
1. WorktreeManager가 worktree + .forgeroom/ 디렉토리 초기화 (task 시작 1회)
2. PipelineEngine: 다음 step 선택
3. 템플릿 로드 (templates/<prompt_template>)
4. 변수 보간 (${...} 치환)
5. Conductor.refine(task_id, step_id, base_prompt) → 보강 프롬프트
6. .forgeroom/prompts/NN_<step_id>.md 에 저장
7. AgentRunner.run({
     agentId, promptPath, outputPath, cwd: worktree, mode: 'headless'
   })
   - OpenClaw 호출 (단순한 지시):
     "Read .forgeroom/prompts/NN_<step_id>.md and follow it.
      Write your response to .forgeroom/outputs/NN_<step_id>.md"
8. 종료 검증:
   - exists(outputPath) && size >= MIN_BYTES?
     - 실패 시 step.attempt++. attempt < MAX_RETRY (2): resume로 출력 파일 작성 재요청
     - MAX_RETRY 초과: step.status=failed
9. git diff → diffs/NN_<step_id>.diff 저장
10. step.status=done
11. Conductor.update(task_id, stepResult) 호출 — **동기**. scope revert가 다음 step 시작 전에 끝나야 안전. 호출 종료 후 다음 step으로
12. Reporter.notify(step_done) 비동기 (멱등성: events 테이블 우선 기록 → 발송 → delivered_at 갱신)
```

### 장점

- CLI 인자 길이 한계 회피, 장문 프롬프트 안정성
- agent가 partial read 가능 (큰 diff는 head/grep)
- worktree에 모든 흔적 보존 → 디버깅·감사 직접 가능
- Conductor가 같은 파일 트리 읽으면 자연스럽게 컨텍스트 보유
- 다음 step agent는 worktree만 보면 됨, DB 의존 X

---

## 7. Conductor (총괄 메타 에이전트)

### 역할 (관여 X, 보조 O)

| 시스템 (yaml/엔진) | Conductor (LLM) |
|---|---|
| step 순서 강제 | task별 누적 컨텍스트 기억 |
| worktree/branch 관리 | 사용자 질문 응답 |
| Check 실행·재시도 결정 | step 프롬프트 사전 튜닝 |
| Discord 알림 발송 | 단계 간 의미 연결 |

Conductor는 **코드 작성 X, 커밋 X, PR 생성 X**. 메타정보만 생산.

### 동작 모델 (MVP: 옵션 B — Headless + 롤링 요약)

- task당 1개 Conductor 컨텍스트, DB의 `conductor_state.summary` + 파일 `.forgeroom/context/summary.md`에 보존
- 매 step 종료: `Conductor.update(task, step, output, diff)` → 새 summary 생성 → 저장
- 매 step 시작 전: `Conductor.refine(task, step, base_prompt)` → 보강 프롬프트 반환
- 사용자 질문: `Conductor.answer(task, question)` → summary + 최근 step output 참조 답변

### Discord 명령

```
/ask <task-id> "phase 2 왜 실패했어?"
/ask <task-id> "지금 어디까지 진행됐어?"
```

### Conductor 호출 입력

- task 메타데이터
- summary (누적)
- 직전 step의 prompt + output + diff (요약본)
- 워크플로우 전체 정의
- 사용자 질문(answer 경우)

### Conductor 호출 출력

- 갱신된 summary (마크다운, 길이 상한 4000 토큰)
- 보강 프롬프트 (base + 컨텍스트 주입)
- 답변 텍스트 (`/ask` 응답)

### Scope 위반 방어 (MVP fallback)

OpenClaw per-call permission이 지원되면 우선 활용. 미지원 시:

```
Conductor 호출 전: git status snapshot 캡처
Conductor 호출 후: git diff
  변경 파일 중 .forgeroom/context/summary.md 외 존재:
    - `git checkout <file>` 으로 revert
    - logs/conductor_scope_violation.log 기록
    - Conductor의 텍스트 응답은 그대로 사용 (메타정보만 활용)
```

---

## 8. 작업 흐름

### 트리거

1. **Discord 명령**:
   ```
   /run <project> "<title>" [--workflow=quick] [--override design=gemini]
   /plan <project> "<title>"
   /code <task-id> [--override=codex]
   /review <task-id>
   /pause <task-id>
   /resume <task-id>
   /skip <task-id> <step-id>
   /cancel <task-id>
   /status [project|task-id]
   /ask <task-id> "<question>"
   ```
2. **GitHub Issue 라벨**: 등록된 프로젝트 레포에서 라벨(예: `agent`) polling. 매치되는 새 Issue 발견 시 default_workflow로 자동 트리거.

### 풀 파이프라인 시퀀스

```
1. Gateway 명령 수신 → ProjectRegistry/WorkflowRegistry 검증
2. ApprovalGate: 워크플로우 + 프로젝트 권한 검사. 위험 명령 거부
3. TaskStore.create(task) → status=queued
4. WorktreeManager.create(task)
   - git worktree add -b agent/<project>-<task-id> ...
   - .forgeroom/ 디렉토리 + context/task.md, context/workflow.md 작성
5. Conductor.init(task_id)
6. PipelineEngine.execute(task):
   for each step in workflow:
     a. (foreach) input list 평가, 반복 step 생성
     b. (until) 매 iteration: 본문 실행 → 조건 평가
     c. base_prompt 생성 (템플릿 + 보간)
     d. Conductor.refine → 보강 프롬프트
     e. prompts/NN.md 저장
     f. AgentRunner.run → outputs/NN.md
     g. 파일 존재·길이 검증, 실패 시 resume 재시도 (최대 2회)
     h. diff 저장
     i. step.status=done, Conductor.update, Reporter.notify
7. 모든 step 종료 후 CheckRunner:
   - projects.yaml의 `commands` 항목들 순차 실행
   - 실패 시 1회 자동 재시도:
     - 실패 stdout/stderr를 .forgeroom/prompts/check_retry.md 에 작성
     - workflow의 마지막 코드 작성 agent에게 resume으로 수정 요청
     - check 재실행
   - 또 실패 시 task.status=failed
8. Check 통과:
   - git push origin <branch>
   - PR 생성(Octokit), 본문은 templates/pr_template.md + summary
   - task.pr_number 저장
9. Reporter: Discord 메시지 "PR #N 생성, 머지 대기"
10. task.status=done
11. 사람이 GitHub에서 머지
```

### 일시정지·재개·스킵

- `/pause <task>`: 현재 step 완료 후 정지. status=paused
- `/resume <task>`: paused → running, 다음 step부터
- `/skip <task> <step-id>`: 해당 step.status=skipped, 다음 step으로
- `/cancel <task>`: 즉시 중단, worktree 보존 (수동 정리)

---

## 9. 에러·재시도 정책

| 실패 지점 | 처리 |
|---|---|
| Agent 실행 실패(timeout/exit≠0) | step.attempt++, 즉시 1회 재시도. 또 실패 → step.status=failed, task.status=failed, Discord 알림 |
| Agent가 output 파일 미작성 | step.attempt++. attempt<2: resume으로 파일 작성 재요청. 초과 시 failed |
| Conductor scope 위반 | 변경 파일 revert, 텍스트 응답은 사용, 로그 기록. step은 정상 진행 |
| Check 실패 | 1회 자동 재시도: 실패 로그를 코드 작성 agent에 전달 → 수정 → check 재실행. 또 실패 시 task.status=failed |
| `until` 루프 max_iterations 도달 | step.status=failed, task.status=failed (조건 미충족) |
| Git 충돌(rebase 실패) | task.status=failed, 사람 개입 알림 |
| PR 생성 실패(GitHub API) | exponential backoff 3회. 다 실패 시 task.status=failed, 로컬 branch 유지 |
| Orchestrator 크래시 중간 | 재시작 시 `status IN ('running','paused')` task 조회. worktree의 `.forgeroom/` 상태 기반으로 마지막 step부터 resume |

### 멱등성 보장

- **Reporter.events**: 전송 전 row 생성 → 전송 후 `delivered_at` 갱신. 재시작 시 미전송 event만 재발송
- **Worktree 재생성**: 이미 존재하면 재사용 (idempotent create)
- **PR 생성**: branch에 이미 PR 있으면 update, 없으면 create
- **Step 재실행**: 같은 step_id에 대해 prompt/output 파일 덮어쓰기, attempt 증가

---

## 10. 동시성

- 프로세스 내 `Map<projectId, RunningLock>` + SQLite UNIQUE 인덱스로 강제
- 같은 `project_id` 동시 실행 = 최대 1개 (queued 대기)
- 다른 `project_id` 간엔 병렬 실행 가능
- queue 정책: project별 FIFO

---

## 11. 보안

| 항목 | MVP 정책 |
|---|---|
| 시크릿 | `.env` (Discord bot token, GitHub token, OpenClaw 인증 토큰). git 무시 |
| Discord allowlist | `configs/discord.yaml`에 사용자 ID 화이트리스트. 외 사용자 명령 거부 |
| 프로젝트 접근 | `configs/projects.yaml` 등록된 path만 접근 |
| 위험 명령 | ApprovalGate가 거부: `git push --force`, `main` 직접 commit, `rm -rf`, `.env` 읽기/쓰기, 마이그레이션 SQL, 임의 시스템 디렉토리 |
| PR 머지 | 항상 사람 수동 (GitHub UI) |
| inbound 포트 | 0개 (outbound only) |
| Tailscale | MVP 제외, Phase 3 |
| 로그 위생 | stdout/stderr 저장 시 토큰·시크릿 패턴 마스킹 (`AKIA[0-9A-Z]+`, `ghp_*`, `sk-*` 등) |
| Conductor scope | OpenClaw permission profile 우선, fallback으로 git diff revert |

---

## 12. 폴더 구조

### 중앙 워커 레포(`~/forgeroom/`)

```
forgeroom/
├── apps/
│   └── orchestrator/
│       ├── src/
│       │   ├── index.ts
│       │   ├── gateway/
│       │   │   ├── discord.ts
│       │   │   └── github.ts
│       │   ├── core/
│       │   │   ├── pipeline-engine.ts
│       │   │   ├── task-store.ts
│       │   │   ├── worktree-manager.ts
│       │   │   ├── agent-runner.ts
│       │   │   ├── conductor.ts
│       │   │   ├── check-runner.ts
│       │   │   ├── reporter.ts
│       │   │   ├── project-registry.ts
│       │   │   ├── workflow-registry.ts
│       │   │   └── approval-gate.ts
│       │   ├── dsl/
│       │   │   ├── workflow-parser.ts
│       │   │   ├── variable-interpolator.ts
│       │   │   ├── foreach.ts
│       │   │   └── until.ts
│       │   └── db/
│       │       ├── schema.ts
│       │       └── migrations/
│       ├── package.json
│       └── tsconfig.json
├── configs/
│   ├── projects.yaml
│   ├── workflows.yaml
│   ├── agents.yaml
│   └── discord.yaml
├── templates/
│   ├── design.md
│   ├── review.md
│   ├── impl_plan.md
│   ├── phase_impl.md
│   ├── refine.md
│   ├── final_review.md
│   └── pr_template.md
├── scripts/
│   ├── create_worktree.sh
│   ├── cleanup_worktree.sh
│   └── run_checks.sh
├── docs/
│   └── architecture.md
├── logs/
├── worktrees/
├── data/
│   └── forgeroom.sqlite
├── .env.example
├── README.md
└── package.json
```

### 실제 프로젝트(`~/projects/<project>/`)

```
my-app/
├── src/
├── package.json
├── README.md
└── AGENTS.md           # 선택, 권장
```

`AGENTS.md` 최소 예시:

```md
# AGENTS.md

## 규칙
- 기존 코드 스타일과 폴더 구조를 따른다.
- main 브랜치에서 직접 작업하지 않는다.
- 새 라이브러리는 승인 없이 추가하지 않는다.
- 테스트 없는 기능 변경은 피한다.
- formatter / linter / test를 실행한다.
- .env, token, key, secret 파일은 읽거나 수정하지 않는다.

## 역할
- Codex: 구현과 테스트 수정
- Claude Code: 계획, 리뷰, 리스크 점검
- Gemini: 보조 리뷰·아이디어
```

---

## 13. 배포

- MVP: 로컬 터미널에서 `pnpm dev` 또는 `node dist/index.js`
- Phase 2+: systemd 또는 docker-compose로 상시 실행
- CLI 운영 명령:
  ```
  forgeroom up
  forgeroom status
  forgeroom stop
  forgeroom migrate
  ```

---

## 14. 로드맵

### Phase 1 — MVP (확장 자동화)

- Orchestrator 단일 프로세스 (Node + TS)
- ProjectRegistry, WorkflowRegistry, OpenClawAgentRegistry (yaml 3종)
- TaskStore (SQLite + Drizzle), 마이그레이션
- PipelineEngine: 자유 step + 변수 보간 + `foreach` + `until` + `max_iterations` + `pause_after`
- AgentRunner: OpenClaw 위임 (headless 기본, PTY 옵션)
- Conductor: 옵션 B(headless + 롤링 요약), `update/refine/answer`
- WorktreeManager: 1 task = 1 worktree, `.forgeroom/` 초기화
- 파일 기반 프롬프트 전달(prompts/, outputs/, diffs/)
- 파일 미작성 시 resume 재시도(최대 2회)
- Conductor scope 위반 fallback (git diff revert)
- CheckRunner: projects.yaml 명령 실행, 실패 시 1회 자동 재시도
- DiscordGateway: `/run`, `/plan`, `/code`, `/review`, `/pause`, `/resume`, `/skip`, `/cancel`, `/status`, `/ask`
- GitHubGateway: Issue label polling, PR 자동 생성
- Reporter: 단계별 Discord 알림 + PR 코멘트 + 멱등성
- ApprovalGate: 위험 명령 거부
- 검증 시나리오: 프로젝트 1개 + workflow 3개(full/quick/hotfix) + agent override

### Phase 2 — 운영형

- 재시도 N회 설정화
- 워크플로우 dry-run validator (실행 전 step 그래프 검증)
- Discord에 step별 raw stdout 스트리밍 옵션
- 프로젝트별 template_dir override 실제 활용
- 위험 작업 Discord 승인 게이트(merge 외)
- 작업 통계/이력 조회 명령
- OpenClaw per-call permission profile 통합(Conductor scope)
- LLM judge 기반 출력 품질 검증

### Phase 3 — 확장형

- 데스크탑 앱 UI (대시보드, 칸반, 파이프라인 그래프, 활동 로그)
- Tailscale 통합 (앱 원격 접속)
- 병렬 sub-task (한 task 안 동시 실행)
- 커스텀 CLI agent 직접 등록(OpenClaw 외부)
- 조건 분기 `when`, 외부 `tool` 호출
- 워크플로우 import/include
- 작업 재시도 큐, 실패 자동 회복

---

## 15. MVP 완료 정의

1. 프로젝트 1개 등록 후 Discord `/run` 호출로 풀 파이프라인 자동 실행
2. workflow별(`full`/`quick`/`hotfix`) 호출 정상 작동
3. agent override CLI 옵션 동작 (`--override design=gemini`)
4. 단계별 Discord 알림 도착
5. `/ask <task>` 로 task 컨텍스트 질문 응답
6. PR 자동 생성, GitHub에서 머지 가능
7. orchestrator 재시작 후 진행 중 task 이력 복구 + 다음 step부터 resume
8. 위험 명령 거부 검증
9. step output 파일 미작성 시 자동 재시도 동작
10. Conductor scope 위반 시 git revert 동작

---

## 16. 비범위 (명시적으로 제외)

- 데스크탑 앱 GUI
- Tailscale / 외부 inbound 접근
- 다중 머신 orchestrator (cluster)
- 비동기 분산 큐 (Redis/BullMQ)
- 병렬 sub-task within a task
- 사용자별 권한 분리 (Discord allowlist만)
- LLM judge 기반 자동 품질 평가
- 동적 워크플로우 변형 (런타임 step 삽입/삭제)

이상 항목은 Phase 2/3 또는 그 이후로 미룬다.
