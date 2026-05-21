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
| **AgentRunner** | OpenClaw에 CLI agent 호출을 위임하는 모듈. ForgeRoom 내부에서 CLI process를 직접 실행하지 않음 |
| **AgentRuntimeProvider** | CLI agent runtime gateway를 ForgeRoom에 연결하는 adapter interface. MVP 구현체는 OpenClawProvider 하나 |
| **Step Harness** | step 실행에 적용할 사전 정의된 작업 환경 preset. prompt contract, hooks, skills, plugins, AGENTS.md/CLAUDE.md 계열 지침, 출력 규칙을 묶어 agent에 로드한다 |
| **Runtime Harness** | OpenClaw/Hermes 같은 runtime provider가 CLI agent를 실행할 때 사용하는 provider-level harness 설정 |
| **OpenClaw** | 외부 의존성. CLI agent runtime gateway. claude-cli, openai-codex, google-gemini-cli 등의 runtime/model/session/auth 차이를 흡수한다. Discord command/event handling은 ForgeRoom의 Gateway 책임 |
| **Workflow** | 이름붙은 step 시퀀스 정의. `configs/workflows.yaml`에 보관 |
| **Intent** | step에 배치되는 재사용 가능한 실행 구성 preset. Intent Kind, agent, Step Harness를 묶어 `configs/intents.yaml`에 보관하며, prompt template은 소유하지 않는다 |
| **Intent Kind** | Intent의 동작 분류. 예: `write_plan`, `execute`, `review`, `refine`, `answer`. MVP에서는 검증·리포팅·Conductor 입력용 metadata이며, `execute` kind는 CheckRunner 실행 트리거로도 쓰인다 |
| **Prompt Template** | step별 실제 지시문을 렌더링하는 템플릿. 같은 Intent라도 step 목적에 따라 다른 prompt template을 사용할 수 있다 |
| **Resolved Step** | Workflow step이 참조한 Intent와 step의 prompt template, vars, input_refs를 합쳐 agent, harness, prompt rendering 입력이 확정된 실행 단위 |
| **Executable Step** | 실제 agent 호출로 이어지는 workflow step. intent, prompt template, vars, input_refs를 가진다 |
| **Step Group** | `foreach`로 내부 steps를 반복 실행하는 workflow 구조. 직접 agent를 호출하지 않으므로 intent와 prompt template을 갖지 않는다 |
| **Review Loop** | review가 pass할 때까지 review/refine 쌍을 반복하는 workflow 구조 |
| **Step** | 워크플로우 내 단일 노드. Executable Step, Step Group, Review Loop 중 하나 |
| **Forge Phase** | ForgeRoom 제품 개발 로드맵 단계. 예: Forge Phase 1 MVP, Forge Phase 2 운영형, Forge Phase 3 처리 단위 확장, Forge Phase 4 Desktop App |
| **Milestone** | Target Project 안의 큰 제품 목표나 릴리스 단위. Forge Phase 3에서 처리 단위 확장 후보로 검토한다 |
| **Project Phase** | Target Project 안의 중간 계획 단위. Forge Phase 3에서 Task 아래 workflow hierarchy로 표현할 수 있는지 검토한다 |
| **Issue** | GitHub Issue 같은 외부 작업 항목. Discord 요청은 Issue가 아닐 수 있으므로 ForgeRoom 내부 실행 단위와 구분한다 |
| **Task** | 사용자가 트리거한 요청을 처리하기 위해 ForgeRoom이 생성하는 실행 인스턴스. MVP에서는 보통 하나의 Issue를 처리하지만, Task는 Issue 자체가 아니라 Branch / Worktree / PR / 실행 이력을 묶는 내부 단위다 |
| **Slice** | 하나의 Task를 실행 가능한 작은 구현 단위로 나눈 것. MVP에서는 workflow의 `foreach: ${task.final_slices}` 에서 각 반복 항목 |
| **Final Slice List** | 현재 task에서 실행 대상으로 최종 결정된 Slice 목록. `implementation_plan.md`의 `## Slices`로 초기화되고, MVP full workflow에서는 review 결과와 관계없이 항상 실행되는 `refine_plan.md`의 `## Slices`로 최종 갱신된다 |
| **Target Project** | ForgeRoom이 작업을 수행하는 대상 소스 프로젝트 또는 repository |
| **Target Profile** | ForgeRoom이 Target Project를 이해하고 다루기 위해 관리하는 canonical 문서. target repo에 기본 저장하지 않고, task 실행 시 Runtime Context로 staging한다 |
| **Runtime Context** | 특정 task 실행을 위해 worktree 내부 `.forgeroom/context/`에 생성되는 파일 묶음. `summary.md`, `feedback.md`, `target-profile.md` 같은 task-local snapshot을 포함 |
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
