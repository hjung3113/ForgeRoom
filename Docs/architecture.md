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

## 런타임·저장소

- **런타임**: Node.js + TypeScript (단일 프로세스). 결정: [ADR-001](decisions/2026-05-21-001-runtime-nodejs-typescript.md)
- **저장소**: SQLite (better-sqlite3 + Drizzle ORM). 결정: [ADR-002](decisions/2026-05-21-002-storage-sqlite.md)
- **에이전트 실행**: OpenClaw 위임. 결정: [ADR-003](decisions/2026-05-21-003-agent-runner-openclaw-delegation.md)
- **프롬프트 전달**: 파일 기반. 결정: [ADR-004](decisions/2026-05-21-004-file-based-prompt-passing.md)

ForgeRoom은 orchestration/product layer다. Discord/GitHub UX, workflow 실행, task 상태, worktree/branch/PR, Conductor context 관리를 책임지고, CLI agent process 실행은 OpenClaw runtime gateway에 위임한다. ForgeRoom 내부에서 claude/codex/gemini CLI를 직접 `child_process`로 실행하지 않는다.

예외적으로 CheckRunner의 test/lint/typecheck는 ForgeRoom이 직접 실행한다. 이는 agent runtime 호출이 아니라 프로젝트 품질 게이트이며, exit code/stdout/stderr/timeout을 ForgeRoom이 직접 기록·판단해야 한다.

## 통신 경로

- **Discord**: WebSocket gateway (클라이언트 outbound)
- **GitHub**: Octokit + Issue label polling, PR 생성 outbound
- **OpenClaw**: 로컬 IPC/HTTP (loopback)
- **inbound 포트**: 0개

## 모듈 목록

| 모듈 | 책임 | 상세 |
|---|---|---|
| ProjectRegistry | 프로젝트 yaml 로드/조회 | [modules/project-registry.md](modules/project-registry.md) |
| WorkflowRegistry | 워크플로우 yaml 로드/조회 | [modules/workflow-registry.md](modules/workflow-registry.md) |
| OpenClawAgentRegistry | OpenClaw runtime 목록 노출 | [modules/agent-runner.md](modules/agent-runner.md) |
| TaskStore | SQLite CRUD, 큐 역할 | [modules/task-store.md](modules/task-store.md) |
| PipelineEngine | 워크플로우 DSL 해석·실행 | [modules/pipeline-engine.md](modules/pipeline-engine.md) |
| WorktreeManager | git worktree·branch 관리 | [modules/worktree-manager.md](modules/worktree-manager.md) |
| AgentRunner | OpenClaw 호출, 파일 IO | [modules/agent-runner.md](modules/agent-runner.md) |
| Conductor | task별 컨텍스트 유지, 보조 | [modules/conductor.md](modules/conductor.md) |
| CheckRunner | test/lint/typecheck 실행 | [modules/check-runner.md](modules/check-runner.md) |
| Reporter | Discord/GitHub 알림 발송 | [modules/reporter.md](modules/reporter.md) |
| DiscordGateway | 슬래시 명령 수신 | [modules/discord-gateway.md](modules/discord-gateway.md) |
| GitHubGateway | Issue 라벨 polling, PR 생성 | [modules/github-gateway.md](modules/github-gateway.md) |
| ApprovalGate | 위험 명령 거부 | [modules/approval-gate.md](modules/approval-gate.md) |

## 폴더 구조 (런타임)

```
~/forgeroom/
├── apps/orchestrator/        # Node + TS 단일 프로세스
├── configs/                  # projects.yaml, workflows.yaml, agents.yaml, discord.yaml
├── templates/                # 프롬프트 템플릿
├── scripts/
├── docs/
├── logs/
├── worktrees/                # task별 worktree
├── data/forgeroom.sqlite
├── .env
└── package.json
```

## 데이터 흐름 (요약)

1. Discord/GitHub 트리거 수신
2. ProjectRegistry/WorkflowRegistry 검증
3. ApprovalGate 권한 검사
4. TaskStore.create
5. WorktreeManager.create → `.forgeroom/` 디렉토리 부트스트랩
6. Conductor.init
7. PipelineEngine.execute (step 단위 반복)
   - 템플릿 + 변수 보간 → Conductor.refine → `prompts/NN.md` 저장
   - AgentRunner.run (OpenClaw 위임) → `outputs/NN.md`
   - 파일 검증 → `kind: execute`이면 CheckRunner → diff 저장 → Conductor.update (동기) → Reporter.notify (비동기)
8. 마지막 execute step의 CheckRunner 통과 확인
9. PR 생성, Discord 알림
10. 사람이 GitHub에서 머지

상세는 [PipelineEngine 모듈](modules/pipeline-engine.md) 참고.
