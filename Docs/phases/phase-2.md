---
status: planned
last_reviewed: 2026-05-21
---

# Phase 2 — 운영형

MVP 위에 운영성·안전성·유연성 추가.

## 항목

- 재시도 N회 설정화
- 워크플로우 dry-run validator (실행 전 step 그래프 검증)
- Discord에 step별 raw stdout 스트리밍 옵션
- 프로젝트별 `template_dir` override 실제 활용
- 위험 작업 Discord 승인 게이트 (`/approve <task> <action>`)
- 작업 통계·이력 조회 명령 (`/stats`, `/history`)
- OpenClaw per-call permission profile 통합 (Conductor scope 사전 차단, [OQ-001](../open-questions.md))
- LLM judge 기반 출력 품질 검증
- 자동 일일 백업 (SQLite + worktree 메타)
- 차단 카탈로그 핫리로드
- 토큰 자동 로테이션 가이드
- 로그 로테이션 (30일)

## 미확정 항목

- 어떤 통계가 가장 유용한가 (실시간 vs 일/주 요약)
- LLM judge 비용·정확도 trade-off
- 승인 TTL 기본값
