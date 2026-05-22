---
status: decided
date: 2026-05-21
---

# ADR-005: 총괄 Conductor 메타 에이전트 도입 (옵션 B)

## 배경

워크플로우는 yaml로 강제되지만, step 사이의 의미 연결·전체 맥락 유지·사용자 질문 응답은 LLM의 지능이 필요하다. 데이터베이스만으로는 부족하다.

## 옵션

- **A) Persistent session (PTY)**: task당 1개 long-lived 세션. 컨텍스트 손실 적음. 비싸고 OpenClaw PTY 의존
- **B) Headless + 롤링 요약**: 매 호출마다 headless. summary는 DB+파일에 저장. 가볍고 단순

## 결정

**B) Headless + 롤링 요약** (MVP). A는 Phase 2 검토 항목.

## 이유

- MVP 단순성: 세션 관리·중단 회복·자원 누수 회피
- 비용: 매번 짧은 컨텍스트만 보냄. summary 길이 상한 (4000 토큰)으로 통제
- 일관성: 재시작 후 동일 동작 보장 (세션 상태 의존 X)

## 트레이드오프

- summary 품질이 병목. summary가 빠지면 후속 보강 품질 저하
- update 호출이 매 step마다 발생 → task 진행 속도에 영향

## 책임 경계

Conductor는 코드 작성 X, 커밋 X, PR 생성 X. 메타정보(요약, 보강 프롬프트, 답변)만 생산.

위반 방어:
- OpenClaw per-call permission profile 우선 ([OQ-001](../open-questions.md))
- Fallback: git status snapshot + 사후 diff 검사 + revert

후속 결정: [ADR-012](2026-05-22-012-agent-runtime-provider-boundary.md)는 MVP AgentRunRequest에 provider별 per-call permission profile을 넣지 않기로 결정했다. 따라서 MVP Conductor scope 방어는 post-run diff 검사와 revert가 기본이며, provider capability 기반 사전 차단은 Forge Phase 2에서 재검토한다.

## 결과

- `configs/agents.yaml`에 `conductor:` 블록
- 기본 모델: Claude (긴 컨텍스트 강함)
- 인터페이스: `init / update / refine / answer`
- `.forgeroom/context/summary.md` 가 진실의 원천 (DB 미러)

## 후속 검토

- Phase 2: PTY 옵션 (옵션 A) 비교 평가
- OpenClaw per-call permission 지원 시 사전 차단으로 전환
