---
status: living
last_reviewed: 2026-05-21
---

# db/ Rules

작업 시작 전 [context-map.md](context-map.md)부터.

## 핵심 규칙

1. **TaskStore 인터페이스(`core/task-store.ts`)의 구현체만 여기**. 인터페이스는 core 소유
2. **마이그레이션 필수**. 스키마 변경 = 새 마이그레이션 추가. 기존 마이그레이션 수정 금지
3. **트랜잭션 명시적**. 다중 INSERT/UPDATE는 한 트랜잭션
4. **better-sqlite3 동기 API 활용**. 단일 프로세스이므로 동기로 단순화 가능. 하지만 외부 노출 인터페이스는 async 유지 (Phase 3 마이그레이션 대비)
5. **PRAGMA**: WAL 모드, foreign_keys=ON, busy_timeout 적당히

## 파일 단위

- `schema.ts` — Drizzle 스키마 정의
- `migrations/` — 자동 생성된 마이그레이션 SQL
- `client.ts` — better-sqlite3 + Drizzle 초기화
- `sqlite-task-store.ts` — TaskStore 구현체
- `migrate.ts` — 부팅 시 자동 마이그레이션 실행

## 금기

- 비즈니스 로직 (core 영역)
- raw SQL 직접 작성 (Drizzle 사용. 예외: 성능 임계 + 명시적 주석)
- 마이그레이션 down 작성 (Phase 1 제외)

## 체크리스트

- [ ] 인덱스 정의가 [data-model](../../../../Docs/concepts/data-model.md)과 일치
- [ ] 멱등성 핵심 path (events delivered_at, tasks unique active) 테스트
- [ ] in-memory sqlite로 단위 테스트
- [ ] 마이그레이션이 빈 DB에 깨끗이 적용되나

## 상위 규칙

- [src/CLAUDE.md](../CLAUDE.md)
- [데이터 모델](../../../../Docs/concepts/data-model.md)
- [동시성 정책](../../../../Docs/policies/concurrency.md)
