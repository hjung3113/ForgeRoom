---
status: living
last_reviewed: 2026-05-21
---

# db/ Context Map

## 책임

SQLite 스키마, 마이그레이션, TaskStore 구현체. core의 TaskStore 인터페이스 만족.

## 주요 파일 (예정)

| 파일 | 역할 |
|---|---|
| `schema.ts` | Drizzle 테이블 정의 (tasks, steps, checks, events, conductor_state) |
| `client.ts` | better-sqlite3 + Drizzle 초기화, PRAGMA 설정 |
| `migrate.ts` | 부팅 시 마이그레이션 적용 |
| `migrations/` | 생성된 마이그레이션 SQL (Drizzle CLI) |
| `sqlite-task-store.ts` | TaskStore 구현체 |

## 같이 읽을 문서

- [데이터 모델](../../../../Docs/concepts/data-model.md) ← **필수**
- [TaskStore 모듈 spec](../../../../Docs/modules/task-store.md)
- [동시성 정책](../../../../Docs/policies/concurrency.md)
- [ADR-002 SQLite 채택](../../../../Docs/decisions/2026-05-21-002-storage-sqlite.md)

## 의존

- 외부: `better-sqlite3`, `drizzle-orm`, `drizzle-kit` (개발)
- 내부: `core/` (TaskStore 인터페이스), `utils/` (logger)

## 진입 가이드

1. data-model 문서로 스키마 확정
2. Drizzle 스키마 작성
3. `drizzle-kit generate` 로 마이그레이션 생성
4. 인터페이스 메서드 1개씩 구현 + 단위 테스트
5. UNIQUE 인덱스 + 트랜잭션 동작 통합 테스트
