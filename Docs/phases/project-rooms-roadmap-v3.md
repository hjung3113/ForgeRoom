---
status: draft
last_reviewed: 2026-05-25
owner: hjung3113
---

# ForgeRoom Project Rooms Roadmap

## 요약

ForgeRoom은 현재 “로컬 단일 머신 중앙 오케스트레이터가 Discord/GitHub 입력을 받아 프로젝트별 worktree에서 agent workflow를 실행하고 PR을 만든다”는 방향이 잘 잡혀 있다. 다만 OpenClaw와 Mastra는 지금보다 더 제품 UX의 중심에 둘 수 있다.

이 문서는 다음 방향을 제안한다.

> ForgeRoom을 단순 agent workflow runner가 아니라, 프로젝트별 AI 작업방(Project Room)을 만들고 Discord channel, OpenClaw session/agent/canvas, Mastra Studio/workflow/time-travel을 하나의 운영 경험으로 묶는 로컬 PR 생산 시스템으로 확장한다.

핵심 제품 개념은 **Project Room**이다.

- Discord 채널 하나가 프로젝트 방이 된다.
- OpenClaw session/agent namespace가 프로젝트별로 분리된다.
- Mastra workflow run은 각 task의 실행 그래프와 운영 콘솔 역할을 한다.
- OpenClaw Canvas 또는 이후 데스크톱 앱은 Project Room dashboard가 된다.
- Desktop App은 Discord/OpenClaw Canvas/Mastra Studio에서 검증한 UX를 통합하는 최종 형태로 간다.

## 현재 문서 기준 판단

### 현재 Phase 1

Phase 1은 MVP다.

- Discord/GitHub Issue trigger
- ForgeMap context staging
- worktree 생성
- AgentRunner + OpenClawProvider
- workflow DSL 실행
- CheckRunner
- PR 자동 생성
- Discord/GitHub Reporter
- 위험 명령 거부
- recoverPending

Phase 1에서는 새 UX를 크게 벌리기보다, 이후 확장을 위한 seam만 추가하는 것이 좋다.

### 현재 Phase 2

Phase 2는 “운영형”이다. 현재 문서에 있는 키워드는 다음이다.

- workflow dry-run validator
- step별 stdout streaming
- review_only workflow
- Discord 승인 게이트
- `/stats`, `/history`
- OpenClaw per-call permission profile
- LLM judge
- 백업/로그/토큰/차단 카탈로그 운영성
- 외부 TaskSource/Reporter
- ContextProvider
- 다른 AgentRuntimeProvider
- harness/provider-local 설정 충돌 정책
- output contract 확장
- reusable Step Group Template

따라서 Phase 2에는 “운영 UX”와 “OpenClaw/Mastra 기능 활용을 위한 모델 확장”을 넣는 것이 자연스럽다.

### 현재 Phase 3

Phase 3는 “확장형”이다. 현재 문서에 있는 키워드는 다음이다.

- 데스크톱 앱 UI
- Tailscale 원격 접속
- 한 task 내 병렬 sub-task
- custom CLI agent
- 조건 분기 `when`
- 외부 `tool` 호출
- workflow import/include
- 동적 step 생성
- 작업 재시도 큐
- 실패 자동 회복
- 다중 머신 orchestrator 검토

따라서 Phase 3에는 Project Room dashboard, OpenClaw sub-agent lanes, Mastra time travel/replay lab, desktop app seed를 넣는 것이 자연스럽다.

### 문서 간 타이밍 정리

현재 overview 쪽에는 데스크톱 앱 GUI가 Phase 4 비범위로 언급되어 있고, phase-3 문서에는 데스크톱 앱 UI가 Phase 3 항목으로 들어가 있다.

이 문서는 다음처럼 정리한다.

- **Phase 2**: Discord/OpenClaw/Mastra를 활용한 운영형 Project Room 기반 구축
- **Phase 3**: Project Room을 dashboard/parallel/replay 중심으로 확장
- **Phase 3.5 또는 Phase 4**: 독립 데스크톱 앱으로 통합

즉, desktop app 자체를 너무 빨리 만들기보다 Discord + OpenClaw Canvas + Mastra Studio에서 UX를 먼저 검증하고, 그 검증된 화면을 데스크톱 앱으로 옮기는 순서가 좋다.

## 핵심 제품 개념: Project Room

Project Room은 ForgeRoom이 관리하는 프로젝트 단위 운영 공간이다.

Project Room 하나는 다음을 묶는다.

- ForgeRoom project id
- repository path
- default workflow
- Discord project channel
- GitHub repository/labels
- OpenClaw project session
- OpenClaw role agents
- Mastra workflow runs
- ForgeMap context
- task history
- PR history
- approval policy
- dashboard state

예시 설정:

```yaml
projects:
  forgeroom:
    repo: ~/projects/ForgeRoom
    default_workflow: full
    discord:
      channel_id: "C_FORGEROOM"
      thread_mode: per_task
      commands:
        allow:
          - run
          - status
          - history
          - approve
          - feedback
    openclaw:
      room: forgeroom
      project_session: "fr:forgeroom:project"
      session_strategy: project_issue_task
      agents:
        coordinator: "fr-forgeroom-main"
        planner: "fr-forgeroom-planner"
        implementer: "fr-forgeroom-impl"
        reviewer: "fr-forgeroom-reviewer"
        researcher: "fr-forgeroom-research"
      permission_profiles:
        planning: read_only
        implementation: coding
        review: read_only
        research: read_only
    mastra:
      expose_operator_tools: true
      studio_project: "forgeroom"
```

## Discord Project Channels

### 의도

Discord를 단순 command 입력창이 아니라 Project Room의 human-facing control plane으로 사용한다.

프로젝트별 Discord channel을 만들면 다음이 좋아진다.

- 프로젝트별 task 상태가 한 곳에 모인다.
- task별 thread를 만들 수 있다.
- project-specific workflow command를 더 짧게 만들 수 있다.
- `/run`에서 project id를 매번 입력하지 않아도 된다.
- approval, feedback, ask, history가 해당 프로젝트 문맥에서 자연스럽게 동작한다.
- 나중에 desktop app으로 옮길 화면의 UX를 Discord에서 먼저 검증할 수 있다.

### 제안 UX

프로젝트 채널:

```text
#fr-forgeroom
#fr-myapp
#fr-infra
```

task thread:

```text
#fr-forgeroom
  └─ [TASK-42] Add Discord project channels
  └─ [TASK-43] Improve OpenClaw session binding
```

명령:

```text
/run "Discord 채널별 프로젝트 관리 추가"
/run workflow:quick "간단 버그 수정"
/status
/history
/stats
/approve TASK-42 risky-command
/feedback TASK-42 "이 부분은 web UI보다 CLI 먼저"
/ask TASK-42 "현재 왜 멈춰있어?"
/room
/room sessions
/room canvas
```

### Phase 배치

**Phase 2 초반**에 하는 것이 좋다.

이유:

- 기존 Phase 2에 `/stats`, `/history`, Discord 승인 게이트가 이미 있다.
- Project Room의 human-facing UX가 먼저 있어야 OpenClaw/Mastra 확장 기능도 보이게 된다.
- Desktop App 전에 Discord에서 정보 구조를 검증할 수 있다.

### 최소 구현

- `projects.yaml`에 `discord.channel_id` 추가
- DiscordGateway가 channel id로 project를 역해석
- project channel에서 `/run` 호출 시 project 생략 가능
- task 시작 시 task thread 생성
- Reporter가 task thread에 step 이벤트 기록
- `/room`, `/history`, `/stats` 추가

## OpenClaw Project Sessions

### 의도

OpenClaw를 단순 CLI 실행 gateway가 아니라, Project Room의 agent/session runtime으로 활용한다.

현재는 전역 OpenClaw agent id 하나로 모든 run을 처리하는 형태에 가깝다. 이를 프로젝트/역할/태스크별 session namespace로 확장한다.

### Session 계층

권장 session key 구조:

```text
fr:<project>:project
fr:<project>:issue:<issue_number>
fr:<project>:task:<task_id>
fr:<project>:task:<task_id>:planner
fr:<project>:task:<task_id>:implementer
fr:<project>:task:<task_id>:reviewer
fr:<project>:task:<task_id>:researcher
```

역할:

- `project` session: 장기 프로젝트 문맥, room status, 최근 작업 요약
- `issue` session: GitHub issue 단위 논의
- `task` session: ForgeRoom task 실행 단위
- role session: planner/implementer/reviewer/researcher 역할별 대화 및 결과

### 중요한 설계 원칙

OpenClaw session은 ForgeRoom의 권위 상태가 아니다.

권위 상태는 계속 다음에 둔다.

- TaskStore
- `.forgeroom/` artifact files
- git worktree/branch
- Mastra workflow run id와 snapshot은 보조

OpenClaw session은 다음 용도다.

- agent runtime continuity
- project/issue/task별 conversation memory
- sub-agent orchestration
- debugging transcript
- operator visibility
- Canvas/dashboard 연결

### Phase 배치

**Phase 2 중반**에 하는 것이 좋다.

이유:

- Phase 2에 OpenClaw per-call permission profile이 이미 있다.
- AgentRuntimeProvider 확장 전에 OpenClaw를 제대로 쓰는 구조를 먼저 잡아야 한다.
- Discord Project Channels와 결합하면 체감 가치가 크다.

### 최소 구현

- `AgentRunRequest` 또는 provider extension에 `runtimeAgentId`, `sessionKey`, `permissionProfile` 추가
- `OpenClawProvider`가 전역 `config.agentId` 대신 resolved runtime context를 사용
- `TaskStore`에 OpenClaw 실행 메타 추가
  - `openclaw_agent_id`
  - `openclaw_session_id`
  - `openclaw_session_key`
  - `openclaw_role`
- `/room sessions` 명령 추가
- Reporter에 session link/status 노출

## OpenClaw Role Agents

### 의도

ForgeRoom workflow의 intent/harness와 OpenClaw agent를 연결해 역할별 실행 환경을 분리한다.

예시:

| ForgeRoom intent kind | ForgeRoom harness | OpenClaw agent | Permission |
|---|---|---|---|
| write_plan | planning | project-planner | read-only |
| refine | planning | project-planner | read-only |
| execute | implementation | project-implementer | coding |
| review | review | project-reviewer | read-only |
| research | research | project-researcher | read-only |

### 효과

- planner와 implementer의 memory가 섞이지 않는다.
- reviewer는 write tool을 제한할 수 있다.
- researcher는 sub-agent로 돌리기 쉽다.
- project별 agent 설정을 달리할 수 있다.
- 나중에 custom CLI agent/provider를 붙이기 쉬워진다.

### Phase 배치

**Phase 2 중반**.

OpenClaw Project Sessions와 같은 milestone에 포함한다.

## OpenClaw Canvas Dashboard

### 의도

OpenClaw Canvas를 ForgeRoom의 lightweight visual dashboard로 사용한다.

Canvas는 desktop app 이전의 실험장으로 보면 좋다.

표시할 것:

- project room status
- running tasks
- workflow step graph
- current active step
- check result
- review loop iteration
- branch/worktree/PR
- OpenClaw session tree
- pending approval
- recent failures
- ForgeMap selected context
- task timeline

### UX

```text
/room canvas
```

을 호출하면 해당 project의 Canvas dashboard가 열린다.

Canvas는 처음에는 정적 HTML + JSON polling으로 충분하다.

```text
~/forgeroom/canvas/<project>/index.html
~/forgeroom/canvas/<project>/room-state.json
```

나중에는 OpenClaw A2UI surface update로 변경한다.

### Phase 배치

**Phase 2 후반 또는 Phase 3 초반**.

이유:

- Phase 2의 `/stats`, `/history`, stdout streaming, approval UX가 어느 정도 생긴 뒤에 dashboard가 의미 있다.
- Phase 3의 desktop app UI를 만들기 전에 Canvas로 화면 구성을 검증할 수 있다.

### 최소 구현

- `CanvasReporterSink`
- `room-state.json` writer
- project room dashboard HTML template
- `/room canvas` command
- task timeline + active step + PR/check card부터 표시

## Mastra Operator Console

### 의도

Mastra Studio를 단순 workflow 확인 용도가 아니라 ForgeRoom 운영 콘솔로 확장한다.

Mastra Studio는 agent/workflow/tool을 테스트하고 관리하는 UI로 쓸 수 있으므로, ForgeRoom의 내부 조작을 Mastra tools로 노출하면 좋다.

### 노출할 tools

Read-only부터 시작한다.

```text
forgeroom.project.list
forgeroom.project.status
forgeroom.task.list
forgeroom.task.read
forgeroom.task.timeline
forgeroom.diff.read
forgeroom.check.logs
forgeroom.openclaw.sessions
forgeroom.room.state
```

이후 write tool:

```text
forgeroom.task.pause
forgeroom.task.resume
forgeroom.task.cancel
forgeroom.task.retry
forgeroom.approval.grant
forgeroom.openclaw.spawnResearch
```

### Phase 배치

**Phase 2 중반~후반**.

이유:

- Phase 2는 운영형이므로 Studio를 operator console로 활용하기 좋다.
- write tool은 approval/security 모델이 생긴 뒤에 열어야 한다.
- 초기에는 read-only tool만으로도 Studio의 가치가 커진다.

### 최소 구현

- `apps/orchestrator/src/mastra/tools/` 추가
- TaskStore/ProjectRegistry/Reporter artifact 읽기 tool
- Mastra Studio에서 task status, diff, logs 조회
- write tool은 `ApprovalGate` 통과하도록 강제

## Mastra Replay Lab / Time Travel

### 의도

Mastra time travel을 task 진행의 권위 경로로 쓰기보다, 실패 분석과 workflow/prompt 실험용 Replay Lab으로 쓴다.

사용 예:

```text
/replay TASK-42 from slice_review
/replay TASK-42 from impl_plan with workflow:full_v2
/replay TASK-42 from final_review with model:claude-opus
```

### ForgeRoom에서의 의미

- 실패한 step만 다시 실행해 원인 분석
- prompt template 변경 영향 비교
- workflow variant 비교
- model/harness 비교
- output contract 변경 테스트
- check failure 재현

### 중요한 제한

Replay Lab 결과는 기본적으로 production task state를 변경하지 않는다.

권위 상태를 변경하려면 별도 명시가 필요하다.

```text
/replay TASK-42 from final_review --apply
```

초기 버전에서는 `--apply`를 지원하지 않는 것이 안전하다.

### Phase 배치

**Phase 3 초반**.

이유:

- Phase 2에서는 task 운영 안정성에 집중한다.
- Phase 3에서 실패 자동 회복, retry queue, 동적 workflow를 다루기 시작할 때 Replay Lab이 의미가 커진다.

## OpenClaw Sub-agent Lanes

### 의도

OpenClaw sub-agent/session 기능을 활용해 research/review/spec 분해를 병렬로 처리한다.

다만 Phase 1/2의 핵심 안전 원칙은 “한 task에서 하나의 worktree를 순차적으로 수정”하는 것이다. 따라서 초기 sub-agent는 read-only lane으로 제한한다.

### Read-only lanes

추천 lane:

- `research_lane`: 관련 코드/문서 조사
- `risk_lane`: 위험도/보안/마이그레이션 리스크 분석
- `test_lane`: 테스트 영향 범위 분석
- `docs_lane`: 문서 변경 필요 범위 분석
- `review_lane`: diff review 보조

이 lane들은 파일을 수정하지 않고 report artifact만 만든다.

```text
.forgeroom/subagents/
  research.md
  risk.md
  tests.md
  docs.md
```

### Write lanes는 나중

실제 병렬 write sub-task는 충돌/merge/검증 문제가 크기 때문에 Phase 3 중후반으로 미룬다.

필요한 기반:

- sub-worktree per sub-task
- merge strategy
- conflict resolver
- per-subtask check
- final integration review
- retry queue
- approval policy

### Phase 배치

- **Phase 2 후반**: read-only sub-agent lanes
- **Phase 3 중반**: parallel write sub-task 검토 및 제한적 구현

## Project Room History / Stats

### 의도

ForgeRoom의 운영성을 높이고 desktop app dashboard의 데이터 기반을 만든다.

### 지표

Project Room별:

- task count
- success/failure/cancel rate
- average duration
- average review loop count
- check failure count
- output contract failure count
- PR created/merged count
- manual intervention count
- agent/runtime failure count
- token/timeout trend
- most failing workflow step

명령:

```text
/history
/stats
/stats week
/stats workflow:full
/stats agent:reviewer
```

### Phase 배치

**Phase 2 초반~중반**.

기존 Phase 2 항목에 이미 `/stats`, `/history`가 있으므로 Project Room 단위로 설계하면 된다.

## Desktop App

### 의도

Desktop App은 처음부터 만들기보다, Discord + OpenClaw Canvas + Mastra Studio에서 검증된 Project Room UX를 통합한다.

Desktop App 화면:

- Project list
- Project Room dashboard
- Kanban/task board
- Workflow graph
- Activity timeline
- Logs/diff/check viewer
- Approval inbox
- OpenClaw session tree
- Mastra replay lab
- Settings/projects/workflows/agents editor
- Local health check
- Tailscale/remote access status

### Phase 배치

**Phase 3.5 또는 Phase 4**.

현재 phase-3 문서에는 desktop app이 Phase 3에 있고, overview에는 Phase 4로 되어 있다. 추천은 다음이다.

- Phase 3: dashboard model과 Canvas prototype
- Phase 3.5: read-only desktop dashboard
- Phase 4: full desktop app with controls/settings/remote

### 기술 선택

Tauri가 더 어울려 보인다.

이유:

- 로컬 단일 머신 앱
- 파일/프로세스/SQLite와 가까움
- 가벼운 dashboard 성격
- Rust sidecar로 orchestrator lifecycle 관리 가능

Electron은 web stack 호환성과 개발 속도는 좋지만, ForgeRoom의 local-first lightweight 방향에는 Tauri가 더 자연스럽다.

단, Mastra Studio를 그대로 embed하거나 복잡한 webview integration이 필요하면 Electron도 검토한다.

## Phase별 제안 로드맵

### Phase 1.5 — MVP 안정화 직후 seam 추가

목표: 큰 UX 기능을 만들기 전, Project Room을 넣을 자리만 만든다.

작업:

1. `ProjectRoom` 도메인 용어 추가
2. `projects.yaml`에 `discord`, `openclaw`, `mastra` section 예약
3. TaskStore에 provider/session metadata column 추가
4. Reporter event schema를 dashboard 친화적으로 정리
5. DiscordGateway가 channel → project mapping을 지원
6. OpenClawProvider가 per-run agent/session metadata를 받을 수 있게 interface 확장
7. Mastra tools 등록 위치만 만든다

완료 정의:

- 기존 Phase 1 workflow가 깨지지 않는다.
- project channel에서 `/run`을 project id 없이 호출할 수 있다.
- OpenClaw agent id를 project/role 단위로 override할 수 있다.
- task row에 OpenClaw session metadata가 남는다.

### Phase 2A — Discord Project Channels

목표: Project Room의 human-facing UX를 Discord에서 먼저 완성한다.

작업:

1. channel별 project binding
2. task별 thread 생성
3. `/room`, `/history`, `/stats`
4. Reporter event를 project channel/thread에 라우팅
5. `/approve` 위험 작업 승인 게이트
6. raw stdout streaming 옵션

완료 정의:

- 프로젝트별 Discord channel이 운영 대시보드처럼 동작한다.
- task thread 하나만 보면 해당 task의 진행 상태를 파악할 수 있다.
- 승인/피드백/질문이 task thread 문맥에 붙는다.

### Phase 2B — OpenClaw Project Sessions & Role Agents

목표: OpenClaw의 session/agent 기능을 ForgeRoom runtime model에 편입한다.

작업:

1. ProjectRoom session namespace
2. role agent mapping
3. per-call permission profile
4. `/room sessions`
5. session history/status 조회
6. read-only researcher/reviewer session 실험
7. harness → OpenClaw permission/tool profile mapping 정책 초안

완료 정의:

- 프로젝트별 OpenClaw session tree를 볼 수 있다.
- planner/implementer/reviewer가 서로 다른 OpenClaw agent/session으로 실행된다.
- review/research agent는 read-only profile로 제한된다.

### Phase 2C — Mastra Operator Console

목표: Mastra Studio를 ForgeRoom 운영 콘솔로 활용한다.

작업:

1. read-only ForgeRoom tools
2. task/diff/log/check 조회
3. project room state 조회
4. workflow dry-run validator와 Studio 연결
5. write tools는 approval policy 뒤에 제한적으로 추가

완료 정의:

- Mastra Studio에서 ForgeRoom task 상태와 artifact를 조회할 수 있다.
- workflow graph만 보는 것이 아니라, 실제 task 운영 데이터까지 볼 수 있다.

### Phase 2D — Canvas Dashboard Prototype

목표: Desktop App 전 단계의 시각 dashboard를 만든다.

작업:

1. `CanvasReporterSink`
2. `room-state.json`
3. Project Room dashboard HTML
4. `/room canvas`
5. task timeline, active step, check result, PR card
6. pending approval card

완료 정의:

- OpenClaw Canvas에서 project room 상태를 볼 수 있다.
- Discord보다 시각적으로 task 진행을 파악하기 쉽다.
- Desktop App의 화면 구조 검증 자료가 된다.

### Phase 3A — Replay Lab

목표: 실패 분석과 workflow/prompt 실험 환경을 만든다.

작업:

1. Mastra time travel wrapper
2. task artifact → replay context builder
3. replay result를 production task와 분리 저장
4. workflow/model/harness variant 실행
5. replay 비교 report

완료 정의:

- 실패한 step을 production state 변경 없이 재실행할 수 있다.
- prompt/workflow 변경 효과를 비교할 수 있다.

### Phase 3B — Read-only Sub-agent Lanes

목표: OpenClaw sub-agent 기능을 안전하게 활용한다.

작업:

1. `openclaw_subagents` control step
2. read-only lane profiles
3. research/risk/test/docs report artifact
4. parent workflow에서 aggregate
5. Mastra graph/Canvas/Discord에 child session 표시

완료 정의:

- 구현 전에 여러 read-only specialist가 병렬로 report를 만든다.
- 결과 report가 plan/implement step prompt에 들어간다.
- worktree write 충돌은 없다.

### Phase 3C — Parallel Write Sub-task

목표: 진짜 병렬 구현을 제한적으로 검토한다.

작업:

1. sub-worktree per sub-task
2. merge/integration step
3. conflict handling
4. subtask-level checks
5. final integration review
6. retry queue

완료 정의:

- 독립적인 slice 두 개 이상을 병렬 구현할 수 있다.
- 충돌 시 안전하게 fail하거나 human approval로 전환한다.

### Phase 3.5/4 — Desktop App

목표: 검증된 Project Room UX를 하나의 앱으로 통합한다.

작업:

1. read-only dashboard
2. task board
3. workflow graph
4. logs/diff/check viewer
5. approval inbox
6. settings editor
7. OpenClaw session tree
8. Mastra replay lab
9. Tailscale/remote access
10. orchestrator lifecycle management

완료 정의:

- Discord 없이도 로컬에서 Project Room을 운영할 수 있다.
- Discord는 remote/mobile control plane으로 남는다.
- Desktop App은 local operator console이 된다.

## 추천 구현 순서

가장 먼저 할 것:

1. **ProjectRoom domain + config schema**
2. **Discord channel → project binding**
3. **Task thread routing**
4. **OpenClaw per-run agent/session metadata**
5. **`/room sessions`**
6. **Mastra read-only operator tools**
7. **Canvas dashboard prototype**

이 순서가 좋은 이유:

- 사용자 체감이 빠르다.
- 기존 MVP workflow를 크게 흔들지 않는다.
- Desktop App으로 갈 정보 구조를 일찍 검증한다.
- OpenClaw/Mastra 기능을 “붙인 기술”이 아니라 “제품 UX”로 끌어올린다.

## 구현 이슈 후보

### Issue 1 — Add ProjectRoom config schema

```text
Add ProjectRoom config schema for Discord channel binding, OpenClaw room/session settings, and Mastra operator exposure.
```

Acceptance:

- `projects.yaml`에서 `discord.channel_id`, `openclaw.room`, `openclaw.agents`, `mastra.expose_operator_tools`를 읽는다.
- 기존 config는 migration 없이 동작한다.
- ProjectRegistry가 ProjectRoom view를 제공한다.

### Issue 2 — Route Discord project channels to ProjectRoom

```text
Allow Discord project channels to imply project context for /run, /status, /history, and /stats.
```

Acceptance:

- project channel에서 `/run` 호출 시 project id 생략 가능
- task별 thread 생성
- Reporter가 thread에 event 기록
- `/room`이 현재 channel의 ProjectRoom status 표시

### Issue 3 — Support OpenClaw role agent/session selection per run

```text
Extend AgentRunRequest/OpenClawProvider to resolve OpenClaw agent id and session key from project, task, and role.
```

Acceptance:

- 전역 `FORGEROOM_OPENCLAW_AGENT` fallback 유지
- project/role override 가능
- task step row 또는 run artifact에 agent/session metadata 기록
- resume 시 동일 session 사용

### Issue 4 — Add ProjectRoom session commands

```text
Add /room sessions and /room session <key> commands for OpenClaw session visibility.
```

Acceptance:

- current project room의 session 목록 조회
- task별 OpenClaw session key 표시
- session status/history 일부 표시
- visibility/safety policy 준수

### Issue 5 — Expose read-only ForgeRoom tools to Mastra Studio

```text
Expose ProjectRoom, TaskStore, diff, check logs, and timeline as read-only Mastra tools.
```

Acceptance:

- Mastra Studio에서 task list/read 가능
- diff/check log artifact 조회 가능
- write operation 없음
- tool 결과가 project/task id 기준으로 제한됨

### Issue 6 — Build CanvasReporterSink prototype

```text
Render ProjectRoom state into OpenClaw Canvas as a lightweight live dashboard.
```

Acceptance:

- `room-state.json` 생성
- Canvas HTML에서 task timeline 표시
- active step/check/PR/approval 상태 표시
- `/room canvas`에서 열 수 있음

### Issue 7 — Add Replay Lab prototype

```text
Use Mastra time travel to replay failed or selected workflow steps without mutating production task state.
```

Acceptance:

- selected task/step replay 가능
- replay result 별도 저장
- production TaskStore 상태 변경 없음
- model/workflow/harness variant 비교 가능

### Issue 8 — Add read-only OpenClaw sub-agent lanes

```text
Add read-only research/risk/test/docs sub-agent lanes before implementation steps.
```

Acceptance:

- sub-agent outputs are saved as artifacts
- no file writes by child agents
- parent workflow aggregates reports
- child session tree appears in room status

## 결정 필요 사항

1. Desktop App을 Phase 3로 유지할지, Phase 3.5/4로 재정의할지
2. Project Room을 공식 도메인 용어로 채택할지
3. Discord project channel을 필수로 할지 optional로 할지
4. OpenClaw session key naming convention
5. OpenClaw role agent를 project별로 강제할지 fallback만 둘지
6. Mastra Studio write tools를 언제 열지
7. Canvas dashboard를 OpenClaw-specific 기능으로 둘지, 나중 desktop app과 공유 가능한 renderer로 만들지
8. read-only sub-agent lanes를 Phase 2 후반에 넣을지 Phase 3로 미룰지

## 최종 추천

Project Room은 Phase 2의 중심축으로 올리는 것이 좋다.

- Phase 2: Discord Project Channels + OpenClaw Project Sessions + Mastra Operator Tools
- Phase 2.5: OpenClaw Canvas Dashboard
- Phase 3: Replay Lab + Read-only Sub-agent Lanes + Parallel Sub-task 준비
- Phase 3.5/4: Desktop App

이렇게 가면 ForgeRoom은 단순 자동 PR 생성기를 넘어서, 여러 프로젝트를 방 단위로 운영하는 로컬 AI 개발 관제 시스템이 된다.


# 추가 섹션 — Multi-Model Runtime & Adaptive Routing

## 왜 필요한가

ForgeRoom은 이미 다음 구조를 갖고 있다.

- workflow DSL
- intent/harness abstraction
- AgentRuntimeProvider abstraction
- OpenClawProvider
- review_loop
- CheckRunner
- ForgeMap/Conductor
- project-aware orchestration 방향성

즉, ForgeRoom은 단순히 “프롬프트 하나를 모델 하나에 보내는 도구”가 아니다.

ForgeRoom은 이미 다음을 알고 있다.

- 현재 step의 목적
- risk level
- workflow 위치
- 실패 횟수
- review loop 상태
- diff 크기
- check 실패 여부
- context 길이
- 프로젝트 중요도

따라서 ForgeRoom은 일반적인 model router보다 더 정교하게 “어떤 모델을 언제 써야 하는지” 판단할 수 있다.

## OpenClaw/OpenCode 기반 Multi-Model 방향

OpenClaw는 이미 여러 provider/runtime/model을 지원한다.

활용 가능한 예:

- Anthropic Claude
- OpenAI / Codex
- Google Gemini
- Z.AI / GLM
- OpenCode Go catalog
- DeepSeek
- Qwen
- Kimi
- Ollama/local model
- OpenRouter

따라서 ForgeRoom은 직접 모든 provider SDK를 붙이기보다:

```text
ForgeRoom
  → OpenClaw/OpenCode
      → Provider/Runtime/Model
```

형태로 가는 것이 유지보수와 확장성 면에서 훨씬 좋다.

## 추천 모델 역할 분담

| 모델 계열 | 추천 역할 |
|---|---|
| Claude | 설계, 복잡 리팩터링, 최종 리뷰 |
| OpenAI/Codex | 코드 수정, 테스트 수정, deterministic implementation |
| Gemini | 대형 context 조사, broad research, docs/web scan |
| Z.AI/GLM | 저비용 planning/refine/review |
| DeepSeek/Qwen | 대량 reasoning batch, 보조 reviewer |
| Ollama/local | low-risk local/private task |

## 핵심 개념: Model Policy

workflow는 직접 model을 고르지 않는다.

대신 intent가 `model_policy`를 참조한다.

예:

```yaml
intents:
  implement_slice:
    kind: execute
    model_policy: code_budget_then_escalate
    harness: implementation
```

실제 model 선택은 ModelPolicyRegistry가 담당한다.

```yaml
model_policies:
  code_budget_then_escalate:
    primary:
      runtime: opencode-go
      model: glm-5
    fallback:
      runtime: openai
      model: gpt-5.5
    escalate_if:
      - check_failed
      - review_loop_iteration_gte: 2
```

## 추천 아키텍처

```text
Workflow Step
  ↓
IntentResolver
  ↓
ModelPolicyRegistry
  ↓
RuntimeSelection
  ↓
OpenClaw/OpenCode Provider
  ↓
Provider Runtime
  ↓
Selected Model
```

## ForgeRoom에 맞는 Routing 특징

Manifest 같은 일반 router는 “query”를 기준으로 모델을 선택한다.

ForgeRoom은 다음을 이미 알고 있기 때문에 더 강력하다.

- step kind
- workflow graph
- diff metadata
- review loop 상태
- failure history
- project criticality
- token budget
- context length
- check results
- approval state

즉, ForgeRoom은 “workflow-aware model routing”이 가능하다.

## 단계별 도입 전략

### Phase 2B — Static Model Policies

목표:

- 여러 모델/runtime/provider를 안전하게 연결
- rule 기반 routing만 지원

작업:

1. `configs/model-policies.yaml`
2. `model_policy` field 추가
3. provider/runtime/model resolve
4. fallback model
5. escalation policy
6. model selection artifact 저장

예:

```json
{
  "selected_model": "glm-5",
  "fallback": "gpt-5.5",
  "reason": [
    "low_risk_execute",
    "budget_mode=save"
  ]
}
```

완료 정의:

- workflow가 특정 model hardcode 없이 실행 가능
- fallback/escalation 가능
- OpenClaw/OpenCode runtime 혼합 가능

### Phase 2C — Cost & Usage Telemetry

목표:

- 어떤 model이 실제로 얼마나 효율적인지 측정

저장 항목:

- runtime
- provider
- model
- input_tokens
- output_tokens
- estimated_cost
- latency
- failure_kind
- review_iterations
- check_failures

추가 명령:

```text
/stats model
/stats cost
/stats latency
/room budget
```

완료 정의:

- 프로젝트별 model usage 파악 가능
- budget hotspot 분석 가능
- dashboard/Canvas/Mastra에서 usage 확인 가능

### Phase 3A — Replay-based Policy Evaluation

목표:

- Replay Lab에서 model policy를 비교 평가

예:

```text
/replay TASK-42 with policy:cheap
/replay TASK-42 with policy:strict_review
```

비교 항목:

- total cost
- latency
- review loop count
- check pass rate
- manual intervention
- diff quality

완료 정의:

- workflow/model policy A/B 비교 가능
- replay 결과를 production task와 분리 저장

### Phase 3B — Adaptive Router

목표:

- 정적 정책 대신 상황 기반 scoring routing

입력 feature 예:

- step kind
- diff size
- risk label
- context length
- workflow position
- previous failures
- model health
- current budget
- latency target
- project priority

출력:

```json
{
  "selected": "claude-sonnet",
  "score": 0.91,
  "reason": [
    "large_diff",
    "high_risk",
    "final_review"
  ]
}
```

완료 정의:

- task 상황에 따라 model 자동 선택
- 동일 workflow라도 step/context에 따라 다른 model 사용

### Phase 3C — Manifest Integration or ForgeRoom-native Router

목표:

- Manifest plugin 연동 여부 결정
- 또는 ForgeRoom-native adaptive router 강화

선택지:

1. Manifest를 OpenClaw plugin으로 사용
2. ForgeRoom-native router 유지
3. 둘을 혼합

추천:

초기에는 ForgeRoom-native routing이 더 좋다.

이유:

- ForgeRoom은 workflow semantics를 알고 있다.
- step metadata를 활용할 수 있다.
- review/check/history와 직접 연결된다.
- project-aware optimization이 가능하다.

Manifest integration은:
- telemetry
- dashboard
- external runtime aggregation
- provider normalization

용도로 후반에 검토한다.

## OpenClaw/OpenCode 활용 전략

추천 방향:

### OpenClaw

역할:

- primary runtime gateway
- session management
- role agents
- Canvas
- permission profiles
- provider abstraction

### OpenCode

역할:

- alternative runtime catalog
- low-cost model routing
- GLM/Kimi/MiniMax 활용
- coding-oriented execution path

### ForgeRoom

역할:

- workflow semantics
- orchestration
- project-aware routing
- policy engine
- evaluation/replay
- operator UX

즉:

```text
ForgeRoom decides
OpenClaw/OpenCode executes
```

## Desktop App와 연결

Adaptive routing이 들어가면 Desktop App/dashboard에서 다음이 중요해진다.

표시할 것:

- current model per step
- routing reason
- fallback chain
- cost timeline
- token usage
- latency
- provider health
- escalation history

예:

```text
TASK-42
  impl_slice
    primary: glm-5
    escalated_to: gpt-5.5
    reason:
      - check_failed
      - review_loop=2
```

이 정보는 Discord보다 Canvas/Desktop App에서 훨씬 가치가 크다.

## 추천 구현 순서

1. `model_policy` schema 추가
2. static fallback routing
3. usage/cost telemetry
4. dashboard visualization
5. replay-based comparison
6. adaptive router
7. Manifest integration 검토

## 추천 결론

Multi-model routing은 ForgeRoom에 매우 잘 맞는다.

하지만 핵심은 “모델을 많이 붙이는 것”이 아니다.

핵심은:

> ForgeRoom이 workflow와 프로젝트 문맥을 이해한 상태에서,
> 가장 적절한 runtime/model을 선택하는 orchestration intelligence를 갖는 것

이다.

추천 방향:

- Phase 2: Static routing + telemetry
- Phase 3: Adaptive routing + replay evaluation
- 후반: Manifest integration 검토

그리고 OpenClaw/OpenCode는 “runtime layer”, ForgeRoom은 “workflow intelligence layer”로 역할을 분리하는 것이 가장 깔끔하다.

---

# 추가 섹션 — Harness & Runtime Profile Roadmap

## 왜 Harness가 핵심인가

ForgeRoom을 만든 원래 목적은 다음에 가깝다.

- 커스텀 workflow를 저장해두고 작업에 맞게 꺼내 쓰기
- 여러 agent가 협업하게 하기
- 각 역할에 맞는 환경, 도구, 지침, 모델을 부여하기
- agent가 맡은 역할에 충실하게 만들기

이 목표에서 Harness는 핵심 모듈이다.

Workflow가 “무슨 순서로 할지”를 정한다면, Harness는 “각 step이 어떤 환경과 규칙 안에서 실행될지”를 정한다.

권장 개념 모델:

```text
Project Room
  └─ Workflow
      └─ Step
          └─ Intent
              ├─ Kind
              ├─ Agent
              ├─ Model Policy
              └─ Harness
                  ├─ Instructions
                  ├─ Tools
                  ├─ Permissions
                  ├─ Skills
                  ├─ Hooks
                  ├─ Runtime Config
                  └─ Output Contract
```

## 현재 상태 판단

ForgeRoom에는 이미 Harness 개념의 씨앗이 있다.

- Workflow DSL 문서에서 Intent는 `kind`, `agent`, `harness`를 묶는 execution preset이다.
- `HarnessRegistry`는 harness id와 source를 검증하고 resolve한다.
- `AgentRegistry`는 agent config에 지정된 harness가 registry에 존재하는지 검증한다.
- 문서상 AgentRunner는 harness source를 task worktree의 runtime context로 fetch/copy/link하고 validate해야 한다.

하지만 실제 구현은 아직 registry/validation 중심이고, 다음은 아직 핵심 구현이 필요하다.

- HarnessInstaller
- RuntimeProfileCompiler
- OutputContractValidator
- provider-specific profile translation
- per-step runtime context staging
- harness telemetry/debug view

## 권장 구조

### HarnessRegistry

역할:

- 어떤 harness가 있는지 로드
- source path 안전성 검증
- harness id resolve

예:

```yaml
harnesses:
  planning:
    source: harnesses/planning
  implementation:
    source: harnesses/implementation
  review:
    source: harnesses/review
  research:
    source: harnesses/research
```

### HarnessInstaller

역할:

- 선택된 harness source를 읽는다.
- `harness.yaml`, instruction files, skills, hooks, contracts를 validate한다.
- task worktree의 `.forgeroom/runtime/<step_id>/`에 stage한다.
- step output validator와 provider request에 runtime context path를 넘긴다.

권장 stage layout:

```text
<worktree>/.forgeroom/runtime/<step_id>/
  harness.yaml
  AGENTS.md
  CLAUDE.md
  skills/
  hooks/
  plugins.yaml
  prompt-contract.md
  output-contract.md
  permissions.yaml
  tools.yaml
```

### RuntimeProfileCompiler

역할:

- provider-neutral Harness를 provider-specific 실행 요청으로 변환한다.

예:

| Harness 항목 | OpenClaw | Claude Code | Codex/OpenAI | Gemini |
|---|---|---|---|---|
| instructions | AGENTS/CLAUDE/context prompt | AGENTS/CLAUDE | prompt prefix/AGENTS | GEMINI/AGENTS/prompt |
| skills | OpenClaw skills | prompt/skill docs | prompt/tool docs | prompt/tool docs |
| permissions | OpenClaw permission profile | CLI permission/hook | sandbox policy | CLI flags |
| tools | OpenClaw tools/MCP | MCP/tools | MCP/tools | MCP/tools |
| output contract | ForgeRoom validator | ForgeRoom validator | ForgeRoom validator | ForgeRoom validator |

초기에는 provider-specific 변환을 과하게 만들지 말고, OpenClaw 중심으로 시작한다.

### OutputContractValidator

역할:

- Harness가 요구하는 output format을 검증한다.
- 기존 `## Slices`, `Review Result: pass/fail` 검증을 일반화한다.
- 검증 실패 시 AgentRunner resume/retry budget을 사용한다.

예:

```yaml
contracts:
  output:
    min_bytes: 50
    required_sections:
      - Summary
      - Changes
      - Validation
```

review harness:

```yaml
contracts:
  output:
    first_line_regex: "^Review Result: (pass|fail)$"
    required_sections:
      - Findings
      - Required Changes
```

## Harness 예시

### planning

```yaml
id: planning
description: Planning and decomposition harness.

applies_to:
  kinds:
    - write_plan
    - refine

tools:
  allow:
    - read_file
    - grep
    - git_diff
  deny:
    - write_file
    - shell_write

permissions:
  filesystem: read_only
  shell: disabled
  network: disabled

contracts:
  output:
    required_sections:
      - Summary
      - Plan
      - Slices
```

### implementation

```yaml
id: implementation
description: Code-writing harness.

applies_to:
  kinds:
    - execute
    - refine

tools:
  allow:
    - read_file
    - write_file
    - grep
    - git_diff
    - run_tests
  deny:
    - write_outside_worktree
    - secret_read
    - network

permissions:
  filesystem: worktree_only
  shell: project_checks_only
  network: disabled

checks:
  run_after: true
```

### review

```yaml
id: review
description: Read-only diff review harness.

applies_to:
  kinds:
    - review

tools:
  allow:
    - read_file
    - grep
    - git_diff
    - read_logs
  deny:
    - write_file
    - shell_write

permissions:
  filesystem: read_only
  shell: disabled

contracts:
  output:
    first_line_regex: "^Review Result: (pass|fail)$"
```

### research

```yaml
id: research
description: Read-only project and external research harness.

tools:
  allow:
    - read_file
    - grep
    - docs_search
    - web_search
  deny:
    - write_file

contracts:
  output:
    required_sections:
      - Findings
      - Evidence
      - Recommendations
```

## Step 실행 흐름 변경

현재 흐름은 대략 다음과 같다.

```text
workflow step
→ intent resolve
→ prompt render
→ conductor refine
→ AgentRunner.run
→ output validation
→ CheckRunner
→ Conductor.update
```

Harness 적용 후 권장 흐름:

```text
workflow step
→ intent resolve
→ agent resolve
→ harness resolve
→ model_policy resolve
→ HarnessInstaller.stage(step, worktree)
→ RuntimeProfileCompiler.compile(provider, harness, agent, model_policy)
→ prompt render with runtime_context_path
→ conductor refine
→ AgentRunner.run(runtimeProfile)
→ output contract validation
→ CheckRunner
→ Conductor.update
```

Harness install은 prompt render 전에 수행한다. 그래야 prompt template이 현재 step의 runtime context path를 정확히 참조할 수 있다.

## 별도 프로젝트로 분리할지 여부

초기에는 ForgeRoom 내부 모듈로 둔다.

이유:

- Harness는 Workflow DSL, IntentRegistry, AgentRegistry, ModelPolicy, ApprovalGate, CheckRunner, OutputContract와 강하게 결합된다.
- 너무 빨리 별도 패키지로 빼면 추상화 비용이 커진다.
- Project Room과 runtime provider 설계가 아직 안정화되지 않았다.

추천 내부 구조:

```text
apps/orchestrator/src/core/
  harness-registry.ts
  harness-installer.ts
  runtime-profile.ts
  runtime-profile-compiler.ts
  output-contract-validator.ts

configs/
  harnesses.yaml

harnesses/
  planning/
  implementation/
  review/
  research/
  docs/
  security/
```

나중에 Phase 3 이후 여러 프로젝트에서 공유할 필요가 생기면 별도 패키지로 분리한다.

```text
@forgeroom/harness-kit
```

## Phase 배치

### Phase 1.5 — HarnessInstaller MVP

목표:

- 현재 문서에 있는 Step Harness 개념을 실제 실행 경로에 연결한다.

포함:

- `HarnessInstaller`
- `harness.yaml` 최소 schema
- harness source validation
- `.forgeroom/runtime/<step_id>/` staging
- `runtime_context_path`를 prompt에 전달
- AGENTS.md / CLAUDE.md / output-contract.md stage
- output min bytes + required sections validation

완료 정의:

- Intent의 `harness`가 실제 파일 context로 stage된다.
- agent step output이 harness output contract로 검증된다.
- 기존 workflow가 깨지지 않는다.

### Phase 2A — Role-Aware Harness Profiles

목표:

- `kind`, `agent`, `model_policy`와 harness를 역할별로 정교하게 연결한다.

포함:

- planning / implementation / review / research 기본 harness
- kind와 harness compatibility validation
- agent와 harness compatibility validation
- read-only/write profile 구분
- ApprovalGate와 permission profile 연결
- Discord `/room harnesses` 또는 `/task harness` 조회

완료 정의:

- review harness는 write tool을 사용할 수 없다.
- implementation harness는 worktree-only write만 허용된다.
- 각 step artifact에 사용된 harness id/version/source가 기록된다.

### Phase 2B — Provider Profile Compilation

목표:

- Harness를 OpenClaw/OpenCode/Gemini/Claude/Codex 등 runtime별 요청으로 변환할 수 있게 한다.

포함:

- `RuntimeProfileCompiler`
- OpenClaw permission/tool profile 매핑
- provider fallback when unsupported
- runtime-specific instruction file naming policy
- provider capability validation
- model_policy와 harness의 compatibility check

완료 정의:

- 같은 `implementation` harness가 OpenClaw run request에 provider profile로 반영된다.
- provider가 지원하지 않는 기능은 warning artifact로 남고 안전한 fallback을 선택한다.

### Phase 2C — Harness Dry-Run & Debug UI

목표:

- workflow 실행 전에 harness/install/runtime profile을 검증한다.

포함:

- workflow dry-run validator와 통합
- harness source 존재 여부 검증
- required files 검증
- permission/tool conflict 검증
- output contract preview
- Mastra Studio read-only tool로 harness inspect
- Canvas/Discord에 harness metadata 표시

완료 정의:

- `/dry-run workflow` 또는 Studio에서 step별 harness/runtime profile을 볼 수 있다.
- 실행 전에 누락 파일/권한 충돌을 잡는다.

### Phase 3A — Dynamic Harness Selection

목표:

- step kind뿐 아니라 task complexity, risk, model policy, project profile에 따라 harness를 선택한다.

포함:

- `harness_policy`
- project-specific override
- risk-based stronger review harness
- low-risk lightweight harness
- security/docs/test specialized harness
- Replay Lab에서 harness policy 비교

완료 정의:

- 같은 workflow라도 task risk에 따라 review harness가 강화될 수 있다.
- Replay Lab에서 harness A/B 비교가 가능하다.

### Phase 3B — Sub-agent Harnesses

목표:

- OpenClaw sub-agent lanes와 role harness를 연결한다.

포함:

- read-only research harness
- risk/security harness
- test impact harness
- docs impact harness
- child session runtime context
- parent aggregation contract

완료 정의:

- 각 sub-agent가 자기 harness로 격리 실행된다.
- child output은 parent step의 structured input으로 들어간다.

### Phase 3C — Shareable Harness Packs

목표:

- 반복적으로 쓰는 harness를 프로젝트 간 공유 가능하게 한다.

포함:

- harness pack manifest
- versioning
- install/update
- local registry
- import from project-local presets
- future plugin marketplace 준비

완료 정의:

- 여러 프로젝트가 같은 harness pack version을 쓸 수 있다.
- project override와 global harness precedence가 명확하다.

### Phase 3.5/4 — Harness Manager UI

목표:

- Desktop App에서 harness를 보고 편집하고 검증한다.

포함:

- harness list
- harness file editor
- permission/tool visualizer
- output contract tester
- project override editor
- usage/failure stats
- “generate harness from description” assistant

완료 정의:

- Desktop App에서 role별 harness를 관리할 수 있다.
- 새로운 harness를 wizard로 만들고 dry-run으로 검증할 수 있다.

## 구현 이슈 후보

### Issue — Implement HarnessInstaller

```text
Implement HarnessInstaller and staged runtime context for workflow steps.
```

Acceptance:

- HarnessRegistry source를 읽는다.
- `harness.yaml`, `AGENTS.md`, `output-contract.md`를 validate한다.
- `.forgeroom/runtime/<step_id>/`에 stage한다.
- AgentRunner request에 `runtimeContextPath`를 추가한다.
- selected harness metadata를 step artifact에 기록한다.

### Issue — Add OutputContractValidator

```text
Generalize workflow output validation through harness output contracts.
```

Acceptance:

- required sections 검증
- first line regex 검증
- min bytes 검증
- selector validation과 retry/resume budget 통합
- failure reason은 `output_contract_failed`

### Issue — Add RuntimeProfileCompiler

```text
Compile provider-neutral harness profiles into provider-specific runtime requests.
```

Acceptance:

- OpenClaw profile compilation
- unsupported capability warning
- safe fallback
- provider capability check

### Issue — Add default harnesses

```text
Add built-in planning, implementation, review, research, docs, and security harnesses.
```

Acceptance:

- default workflow가 built-in harness를 사용한다.
- 각 harness에 instructions, permissions, contracts가 있다.
- dry-run validator 통과

### Issue — Add Harness Debug Surface

```text
Expose harness metadata in Discord, Canvas, and Mastra Studio.
```

Acceptance:

- step별 harness id/version/source 표시
- runtime context path 표시
- dry-run 결과 표시
- permission/tool profile 표시

## 최종 추천

Harness는 Phase 1.5 또는 Phase 2 초반에 넣는 것이 좋다.

이유:

- 원래 ForgeRoom의 핵심 목표와 가장 직접적으로 연결된다.
- OpenClaw role agents, model routing, Project Room, sub-agent lanes의 기반이다.
- 나중에 붙이면 workflow/agent/model 설계를 다시 뜯어고칠 가능성이 크다.

추천 순서:

1. HarnessInstaller MVP
2. OutputContractValidator
3. default harnesses
4. role-aware harness profiles
5. provider profile compiler
6. dry-run/debug surface
7. dynamic harness selection
8. shareable harness packs
