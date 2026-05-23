---
status: decided
date: 2026-05-23
---

# ADR-015: PipelineEngine 실행 substrate로 Mastra workflow primitives 채택

## 배경

PipelineEngine은 yaml DSL을 해석해 step 시퀀스를 실행하고, `foreach`/`review_loop`/`pause_after`/pause-resume-cancel/recoverPending을 모두 자체 코드로 관리한다. resume 정확성, snapshot/replay, run 시각화는 MVP에서 가장 부담이 큰 잔여 영역이며, 동시에 mature workflow framework가 무료로 제공하는 영역이다.

대안 검토 (claude+codex dialog, 2026-05-23):
- **LangGraph (Python 전환)**: 워크플로우 framework로 강력하지만 풀 재작성 비용 + 언어 전환 + IPC 오버헤드. MVP 가치 대비 비용 과다.
- **Hybrid (TS gateway + Python core)**: 영속화/로깅/파일 경로 계약 중복 → 최악.
- **CrewAI/AutoGen**: agent-collaboration framework. ForgeRoom의 explicit DSL + worktree ownership과 충돌.
- **Inngest**: durable step execution은 우수하나 단일 프로세스 로컬 MVP에 비해 인프라가 무겁다. Forge Phase 2 후보로 유지.
- **상태 유지 (자체 구현)**: pause/resume/snapshot 코드 자체 유지 비용 + Studio급 시각화 자체 구현 비용이 framework 도입 비용보다 크다.

## 결정

PipelineEngine을 Mastra workflow runner로 재정의한다.

Mastra가 흡수하는 영역:
- 워크플로우 control flow primitives: `.then` / `.foreach` / `.dountil` / `.dowhile`
- Suspend/resume snapshot
- Local Studio 시각화 (graph view, step inspector, trace)

ForgeRoom이 소유 유지:
- Conductor (`refine`/`update`/`answer`/`feedback`/scope guard)
- 파일 prompt 프로토콜 (`.forgeroom/{prompts,outputs,diffs,context}/`)
- WorktreeManager / AgentRunner / AgentRuntimeProvider / OpenClawProvider
- TaskStore (권위 상태 저장소; ADR-017 참조)
- CheckRunner / Reporter / Gateways / ApprovalGate / ForgeMap

배제 영역 (rejected):
- Mastra Memory는 Conductor `summary.md`/`feedback.md`를 대체하지 않는다. DB-backed agent memory와 파일 아티팩트는 제품/디버깅 계약이 다르다.

## 결과

- PipelineEngine 인터페이스 (`runFull`, `pause`, `resume`, `cancel`, `recoverPending`)는 유지하고, 내부 구현이 Mastra workflow run을 wrapping한다.
- yaml DSL → Mastra workflow 변환은 ADR-016 어댑터에서 정의한다.
- TaskStore step row와 Mastra snapshot의 권위 관계는 ADR-017에서 정의한다.
- Mastra Studio는 dev 환경에서 `localhost:4111`로 실행하고, production은 default off (보안 보호).
- Mastra 버전 lock 필요 (1.0 이전이면 minor pinning + 업그레이드 시 회귀 테스트).

## 관련

- ADR-001 Node.js+TypeScript 런타임 (지속)
- ADR-005 Conductor 메타 에이전트 (Conductor 책임 유지)
- ADR-010 review_loop DSL (DSL 의미 유지, 실행만 Mastra primitives로 매핑)
- ADR-011 CheckRunner execute kind 트리거 (CheckRunner 호출 위치는 ADR-016 step body 안)
- ADR-012 AgentRuntimeProvider boundary (변경 없음)
- ADR-016 yaml DSL → Mastra workflow 어댑터
- ADR-017 TaskStore = 권위, Mastra snapshot = 보조
- 설계 spec: [Docs/superpowers/specs/2026-05-23-mastra-narrow-scope-design.md](../superpowers/specs/2026-05-23-mastra-narrow-scope-design.md)
