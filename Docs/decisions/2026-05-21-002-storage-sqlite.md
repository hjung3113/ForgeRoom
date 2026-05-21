---
status: decided
date: 2026-05-21
---

# ADR-002: 저장소로 SQLite 채택 (vs Postgres)

## 배경

작업 큐(재시작 시 이어가기) + step/check/event 이력 보존이 필요하다. 후보: in-memory, SQLite, Postgres, Redis/BullMQ.

## 옵션

- **In-memory**: 단순. 재시작 시 소실. MVP에서도 부적합 (orchestrator 재시작 회복 요구)
- **SQLite**: 파일 1개, 데몬 없음, zero-ops. 단일 writer
- **Postgres**: 강력하지만 Docker/데몬 운영 부담. 단일 머신 MVP엔 과함
- **Redis/BullMQ**: 운영용 큐, MVP엔 과잉

## 결정

**SQLite (better-sqlite3 + Drizzle ORM)**.

## 이유

- orchestrator는 로컬 단일 프로세스 → 동시 쓰기 경합 거의 없음
- 설치 단계 0개. Postgres는 Docker compose 추가, 학습·운영 비용
- 백업 = 파일 복사
- Drizzle ORM으로 Phase 3 확장 시 Postgres 마이그레이션 부담 낮춤

## 결과

- DB 경로: `~/forgeroom/data/forgeroom.sqlite`
- Migration: Drizzle migrations
- 단일 writer 모델, 모든 트랜잭션은 orchestrator 프로세스 내부에서

## 후속 검토

- 동시성 폭증 / 분산 클러스터 진입 시 Postgres 이관
- 백업 자동화는 Phase 2
