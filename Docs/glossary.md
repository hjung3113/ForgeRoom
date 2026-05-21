---
status: living
last_reviewed: 2026-05-21
---

# Glossary

## 용어

| 용어 | 정의 |
|---|---|
| **ForgeRoom** | 본 프로젝트 이름. 로컬 멀티에이전트 오케스트레이터 |
| **Orchestrator** | ForgeRoom의 중앙 실행 프로세스. 단일 Node.js 프로세스 |
| **PipelineEngine** | Orchestrator 내부 모듈. 워크플로우 DSL 해석·실행 담당 |
| **Conductor** | Orchestrator 내부 메타 에이전트. task별 컨텍스트 유지, step 프롬프트 보강, `/ask` 응답 |
| **AgentRunner** | OpenClaw에 CLI agent 호출을 위임하는 모듈 |
| **OpenClaw** | 외부 의존성. CLI agent runtime 제공 (claude-cli, openai-codex, google-gemini-cli 등) + Discord gateway |
| **Workflow** | 이름붙은 step 시퀀스 정의. `configs/workflows.yaml`에 보관 |
| **Step** | 워크플로우 내 단일 실행 단위. id, agent, prompt, 변수, foreach/until 포함 |
| **Phase** | 두 가지 의미. (a) 프로젝트 로드맵의 단계(Phase 1 MVP / Phase 2 / Phase 3). (b) workflow의 `foreach: ${...phases}` 에서 각 구현 단계 |
| **Task** | 사용자가 트리거한 한 개 작업 단위. 1 Issue / 1 Branch / 1 Worktree / 1 PR에 대응 |
| **Worktree** | git worktree. task 격리용 작업 디렉토리 |
| **Check** | 코드 품질 게이트 (test, lint, typecheck 등) |
| **Reporter** | Discord/GitHub 알림 발송 모듈 |
| **Gateway** | 외부 인터페이스 수신 모듈. DiscordGateway, GitHubGateway |
| **ApprovalGate** | 위험 명령·경로·작업 거부 모듈 |
| **ADR** | Architecture Decision Record. 한 결정 = 한 ADR |
| **Override** | 호출 시 워크플로우 step의 agent 매핑을 임의 변경하는 옵션 |
| **input_refs** | 워크플로우 step에 다른 step의 output 파일 경로를 주입하는 필드 |
| **resume** | (a) AgentRunner: 같은 세션 이어서 호출. (b) PipelineEngine: paused task 재개 |
| **scope 위반** | Conductor가 허용된 파일(`summary.md`) 외 worktree를 수정한 경우 |
| **fail-fast** | 잘못된 상태 발견 시 즉시 중단, 다음 단계 실행 X |
| **graceful degradation** | 일부 기능 실패 시 핵심 기능은 유지 (예: Conductor 실패 시 base prompt 그대로) |
| **idempotent create** | 같은 입력으로 여러 번 호출해도 결과 동일 (worktree 재사용 등) |
