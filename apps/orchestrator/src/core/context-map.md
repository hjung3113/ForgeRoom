---
status: living
last_reviewed: 2026-05-21
---

# core/ Context Map

## 책임

ForgeRoom의 비즈니스 로직. 워크플로우 실행, 에이전트 호출, worktree 관리, 작업 상태 머신, 알림. 외부 IO는 어댑터(다른 폴더)를 통해.

## 주요 파일 (예정)

| 파일 | 모듈 | spec |
|---|---|---|
| `pipeline-engine.ts` | PipelineEngine | [Docs/modules/pipeline-engine.md](../../../../Docs/modules/pipeline-engine.md) |
| `conductor.ts` | Conductor | [Docs/modules/conductor.md](../../../../Docs/modules/conductor.md) |
| `agent-runner.ts` | AgentRunner (OpenClaw 위임 호출) | [Docs/modules/agent-runner.md](../../../../Docs/modules/agent-runner.md) |
| `worktree-manager.ts` | WorktreeManager | [Docs/modules/worktree-manager.md](../../../../Docs/modules/worktree-manager.md) |
| `check-runner.ts` | CheckRunner | [Docs/modules/check-runner.md](../../../../Docs/modules/check-runner.md) |
| `reporter.ts` | Reporter | [Docs/modules/reporter.md](../../../../Docs/modules/reporter.md) |
| `approval-gate.ts` | ApprovalGate | [Docs/modules/approval-gate.md](../../../../Docs/modules/approval-gate.md) |
| `project-registry.ts` | ProjectRegistry | [Docs/modules/project-registry.md](../../../../Docs/modules/project-registry.md) |
| `workflow-registry.ts` | WorkflowRegistry | [Docs/modules/workflow-registry.md](../../../../Docs/modules/workflow-registry.md) |
| `openclaw-agent-registry.ts` | OpenClawAgentRegistry | [Docs/modules/agent-runner.md](../../../../Docs/modules/agent-runner.md) |
| `task-store.ts` | TaskStore 인터페이스 | [Docs/modules/task-store.md](../../../../Docs/modules/task-store.md) |
| `types.ts` | 공개 타입 모음 | — |
| `errors.ts` | 도메인 에러 클래스 | — |

## 의존 방향

- core → utils 만 허용
- core 내부 모듈 간엔 자유 (Engine은 다수 모듈 조합)

## 같이 읽을 문서

- [DSL 개념](../../../../Docs/concepts/workflow-dsl.md)
- [데이터 모델](../../../../Docs/concepts/data-model.md)
- [Conductor 모델](../../../../Docs/concepts/conductor-model.md)
- [프롬프트 프로토콜](../../../../Docs/concepts/prompt-file-protocol.md)
- [에러·재시도 정책](../../../../Docs/policies/error-retry.md)

## 진입 가이드

1. 작업 모듈의 spec 1개 정독
2. spec의 "인터페이스" 섹션을 `types.ts`에 옮기는 데서 시작
3. 단위 테스트로 메서드 1개씩 구현
