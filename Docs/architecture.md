---
status: decided
last_reviewed: 2026-05-21
---

# 아키텍처

## 시스템 다이어그램

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
│  │ TaskSource   │   │ Core                         │   │
│  │ - Discord    │   │ - TaskStore (SQLite)         │   │
│  │ - GitHub     │──▶│ - PipelineEngine             │   │
│  └──────────────┘   │ - WorkflowRegistry           │   │
│                     │ - ProjectRegistry            │   │
│                     │ - ForgeMap                   │   │
│                     │ - WorktreeManager            │   │
│                     │ - AgentRunner                │   │
│                     │   (→ AgentRuntimeProvider)   │   │
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

## 런타임·저장소

- **런타임**: Node.js + TypeScript (단일 프로세스). 결정: [ADR-001](decisions/2026-05-21-001-runtime-nodejs-typescript.md)
- **저장소**: SQLite (better-sqlite3 + Drizzle ORM). 결정: [ADR-002](decisions/2026-05-21-002-storage-sqlite.md)
- **에이전트 실행**: AgentRuntimeProvider 경유. MVP 구현체는 OpenClawProvider. 결정: [ADR-012](decisions/2026-05-22-012-agent-runtime-provider-boundary.md)
- **프롬프트 전달**: 파일 기반. 결정: [ADR-004](decisions/2026-05-21-004-file-based-prompt-passing.md)
- **Project Context**: ForgeMap. 결정: [ADR-014](decisions/2026-05-22-014-forgemap-mvp-project-context.md)

ForgeRoom은 orchestration/product layer다. MVP에서는 Discord/GitHub UX, workflow 실행, task 상태, worktree/branch/PR, ForgeMap/Conductor context 관리를 책임지고, CLI agent process 실행은 AgentRuntimeProvider에 위임한다. MVP provider 구현체는 OpenClawProvider 하나다.

예외적으로 CheckRunner의 test/lint/typecheck는 ForgeRoom이 직접 실행한다. 이는 agent runtime 호출이 아니라 프로젝트 품질 게이트이며, exit code/stdout/stderr/timeout을 ForgeRoom이 직접 기록·판단해야 한다.

## 통신 경로

- **Discord**: WebSocket gateway (클라이언트 outbound)
- **GitHub**: Octokit + Issue label polling, PR 생성 outbound
- **OpenClaw**: AgentRuntimeProvider의 MVP 구현체, 로컬 IPC/HTTP (loopback)
- **inbound 포트**: 0개

## 모듈 목록

| 모듈 | 책임 | 상세 |
|---|---|---|
| ProjectRegistry | 프로젝트 yaml 로드/조회 | [modules/project-registry.md](modules/project-registry.md) |
| ForgeMap | Target Project context 생성·선택·staging | [modules/forgemap.md](modules/forgemap.md) |
| WorkflowRegistry | 워크플로우 yaml 로드/조회 | [modules/workflow-registry.md](modules/workflow-registry.md) |
| AgentRegistry | agent id를 runtime provider 설정으로 resolve | [modules/agent-runner.md](modules/agent-runner.md) |
| TaskStore | SQLite CRUD, 큐 역할 | [modules/task-store.md](modules/task-store.md) |
| PipelineEngine | 워크플로우 DSL 해석·실행 | [modules/pipeline-engine.md](modules/pipeline-engine.md) |
| WorktreeManager | git worktree·branch 관리 | [modules/worktree-manager.md](modules/worktree-manager.md) |
| AgentRunner | AgentRuntimeProvider 호출, 파일 IO | [modules/agent-runner.md](modules/agent-runner.md) |
| Conductor | task별 컨텍스트 유지, 보조 | [modules/conductor.md](modules/conductor.md) |
| CheckRunner | test/lint/typecheck 실행 | [modules/check-runner.md](modules/check-runner.md) |
| Reporter | ReporterSink을 통한 Discord/GitHub 알림 발송 | [modules/reporter.md](modules/reporter.md) |
| DiscordGateway | Discord slash command TaskSource | [modules/discord-gateway.md](modules/discord-gateway.md) |
| GitHubGateway | GitHub Issue TaskSource, PR 생성 | [modules/github-gateway.md](modules/github-gateway.md) |
| ApprovalGate | 위험 명령 거부 | [modules/approval-gate.md](modules/approval-gate.md) |

## 폴더 구조 (런타임)

```
~/forgeroom/
├── apps/orchestrator/        # Node + TS 단일 프로세스
├── configs/                  # projects.yaml, workflows.yaml, agents.yaml, discord.yaml
├── templates/                # 프롬프트 템플릿
├── maps/                     # ForgeMap project context
├── scripts/
├── docs/
├── logs/
├── worktrees/                # task별 worktree
├── data/forgeroom.sqlite
├── .env
└── package.json
```

## 데이터 흐름 (요약)

1. Discord/GitHub TaskSource가 트리거 수신
2. ProjectRegistry/WorkflowRegistry 검증
3. ApprovalGate 권한 검사
4. TaskStore.create
5. WorktreeManager.create → `.forgeroom/` 디렉토리 부트스트랩
6. PipelineEngine이 task start 단계에서 ForgeMap ContextSelector 호출
7. ContextSelector가 관련 project context를 `.forgeroom/context/`에 staging
8. Conductor.init
9. PipelineEngine.execute (step 단위 반복)
   - 템플릿 + 변수 보간 → Conductor.refine → `prompts/NN.md` 저장
   - AgentRunner.run (AgentRuntimeProvider 위임) → `outputs/NN.md`
   - 파일 검증 → `kind: execute`이면 CheckRunner → diff 저장 → Conductor.update (동기) → Reporter.notify (비동기)
10. 마지막 execute step의 CheckRunner 통과 확인
11. PR 생성, Discord 알림
12. 사람이 GitHub에서 머지

상세는 [PipelineEngine 모듈](modules/pipeline-engine.md) 참고.
