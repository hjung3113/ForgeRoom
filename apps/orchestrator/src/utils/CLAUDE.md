---
status: living
last_reviewed: 2026-05-21
---

# utils/ Rules

작업 시작 전 [context-map.md](context-map.md)부터.

## 핵심 규칙

1. **도메인 독립**. ForgeRoom 비즈니스 개념 X. 누구나 가져다 쓸 수 있는 헬퍼만
2. **다른 폴더 import 금지**. utils는 받기만, 주지 않음 (사이클 방지)
3. **부수효과 최소**. 가능한 한 순수 함수
4. **logger·시크릿 마스킹**은 여기. 어디서나 import 가능
5. **테스트 우선**. 헬퍼 함수는 작아도 단위 테스트 보유

## 파일 단위 (예정)

- `logger.ts` — pino 기반 JSON 로거
- `secret-mask.ts` — 토큰 패턴 마스킹
- `paths.ts` — 경로 빌더 (worktree 내부 prompts/outputs 경로 등)
- `env.ts` — 환경변수 검증 + 노출
- `errors.ts` — 베이스 에러 클래스 (`OrchestratorError`)
- `time.ts` — duration, sleep, AbortController 헬퍼 (필요 시)

## 금기

- 비즈니스 로직 (`Task`, `Workflow`, `Step` 같은 도메인 타입 의존)
- 외부 IO (DB, 파일 시스템 직접) — 단 `logger`는 stdout/파일 OK
- 다른 src/ 폴더 import

## 체크리스트

- [ ] 다른 폴더 import 안 했나
- [ ] 단위 테스트 있나
- [ ] 도메인 의존 없나

## 상위 규칙

- [src/CLAUDE.md](../CLAUDE.md)
- [coding-rules](../../../../Docs/rules/coding-rules.md)
