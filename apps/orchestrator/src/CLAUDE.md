---
status: living
last_reviewed: 2026-05-21
---

# apps/orchestrator/src Rules

작업 시작 전 [context-map.md](context-map.md)부터 읽어라.

## 핵심 규칙

1. **단일 프로세스**. 멀티 워커·클러스터 시도 금지 (Phase 3 영역).
2. **의존성 주입**. 모듈은 생성자에서 의존성을 받음. global·singleton 금지.
3. **각 폴더 책임 엄수**:
   - `core/` — 비즈니스 로직 (PipelineEngine, Conductor, AgentRunner, WorktreeManager, CheckRunner, Reporter, ApprovalGate, Registry들, TaskStore 인터페이스)
   - `gateway/` — Discord/GitHub 등 외부 인터페이스 어댑터
   - `dsl/` — 워크플로우 yaml 파서·변수 보간·foreach/until 처리
   - `db/` — Drizzle 스키마·마이그레이션·SQLite 바인딩 (TaskStore 구현체)
   - `utils/` — 도메인 독립 헬퍼만 (로거, 시크릿 마스킹, 경로 유틸 등)
4. **types.ts 컨벤션**. 폴더 외부에 공개하는 타입은 `<folder>/types.ts`에 모음.
5. **import 방향**:
   - `gateway → core`, `dsl → core`, `db → core` 허용
   - `core → gateway/dsl/db` 금지 (의존성 역전 위반)
   - `utils`는 누구나 import 가능, `utils`는 다른 폴더 import 금지

## 금기

- `console.log`/`console.error` 직접 사용 — 정의된 logger 사용
- `process.env.*` 직접 참조 — `config/env.ts`(예정)를 통해 검증된 값만
- 위 폴더의 책임 경계 위반 (예: gateway에 비즈니스 로직)
- worktree 경로를 환경변수가 아닌 코드에 하드코딩
- 외부 패키지 명령(`exec`) 호출 시 사용자 입력을 직접 문자열 보간

## 체크리스트 (PR 전)

- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test:unit` 통과 (pre-commit이 강제)
- [ ] 새 모듈은 `types.ts`로 외부 타입 노출
- [ ] 의존성 추가/변경은 ADR 또는 PR 본문에 명시
- [ ] 영향 받은 `Docs/modules/<name>.md` 갱신
- [ ] 변경된 폴더의 `context-map.md` 갱신 (주요 파일 표)

## 상위 규칙

- [전역 코딩 룰](../../../Docs/rules/coding-rules.md)
- [네이밍](../../../Docs/rules/naming-rules.md)
- [테스트](../../../Docs/rules/testing-rules.md)
- [에러·재시도 정책](../../../Docs/policies/error-retry.md)
- [보안 정책](../../../Docs/policies/security.md)
