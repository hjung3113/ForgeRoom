---
status: planned
last_reviewed: 2026-05-21
---

# Forge Phase 2 — 운영형

MVP 위에 운영성·안전성·유연성 추가.

## 항목

- 재시도 N회 설정화
- 워크플로우 dry-run validator (실행 전 step 그래프 검증)
- Discord에 step별 raw stdout 스트리밍 옵션
- 단독 inspection review workflow (`review_only`)
- 프로젝트별 `template_dir` override 실제 활용
- Workflow DSL inline `prompt` 지원 여부 재검토
- 위험 작업 Discord 승인 게이트 (`/approve <task> <action>`)
- 작업 통계·이력 조회 명령 (`/stats`, `/history`)
- OpenClaw per-call permission profile 통합 (Conductor scope 사전 차단, [OQ-001](../open-questions.md))
- LLM judge 기반 출력 품질 검증
- 자동 일일 백업 (SQLite + worktree 메타)
- 차단 카탈로그 핫리로드
- 토큰 자동 로테이션 가이드
- 로그 로테이션 (30일)
- 사내 환경 TaskSource/Reporter 구현체: Local CLI, GitHub Enterprise, git issue, 사내 chat/ticket
- OpenCodeProvider, HermesProvider, 직접 CLI provider 구현체
- ForgeMap 외부 ingestion: issue/PR history, 공식 문서, 사내 wiki/ticket

## 후보 기능 / Design Target

- ContextProvider 계층: ForgeMap을 기반으로 issue/PR history, 공식 문서, 사내 지식 저장소를 검색·요약해 Conductor 입력에 연결
- Conductor를 task-local RAG에서 project-aware RAG로 확장하되, workflow 순서와 step 목적은 계속 PipelineEngine이 강제
- 최초 `conductor_plan` 단계만 고정하고, 이후 실행 workflow는 Conductor가 승인된 workflow preset 목록 중에서 선택하는 모드
- Interactive feedback session: Conductor가 피드백을 명확히 하기 위한 질문을 만들고, 사용자 답변 thread를 닫은 뒤 `feedback.md`에 통합
- AgentRuntimeProvider 구현체 확장: OpenClaw 외 OpenCode, Hermes 같은 다른 agent runtime gateway를 adapter로 선택 가능하게 검토
- target project에 이미 harness/provider-local 설정이 있을 때 ForgeRoom Step Harness와의 충돌·우선순위·merge 정책 정의
- step-level Intent override: workflow step에서 `kind`, `agent`, `harness` 일부를 직접 override할지 검토
- reusable Step Group Template: 반복 body를 `configs/step-groups.yaml` 같은 별도 registry로 분리하고 workflow에서 참조
- output contract 확장: `${<step>.output.slices}`와 `Review Result` 외 구조화 output field, review findings schema, slice object schema, prompt template required vars/input_refs 검증
- 웹/공식 문서 RAG는 Forge Phase 2 필수 범위가 아니며 connector 확장 후보로 분리

## 미확정 항목

- 어떤 통계가 가장 유용한가 (실시간 vs 일/주 요약)
- LLM judge 비용·정확도 trade-off
- 승인 TTL 기본값
