---
status: living
last_reviewed: 2026-05-21
---

# utils/ Context Map

## 책임

도메인 독립 헬퍼. 로거, 시크릿 마스킹, 경로 빌더, 환경변수 검증, 베이스 에러 클래스.

## 주요 파일 (예정)

| 파일 | 역할 |
|---|---|
| `logger.ts` | pino JSON 로거 + 모듈별 child logger |
| `secret-mask.ts` | 토큰·키 패턴 마스킹 |
| `paths.ts` | worktree 내부 표준 경로 빌더 (prompts, outputs, diffs) |
| `env.ts` | zod 기반 환경변수 schema + 검증 |
| `errors.ts` | `OrchestratorError` base 클래스 |
| `time.ts` | sleep, withTimeout 같은 시간 유틸 |

## 같이 읽을 문서

- [coding-rules](../../../../Docs/rules/coding-rules.md) (로깅·에러 섹션)
- [보안 정책](../../../../Docs/policies/security.md) (마스킹 패턴)

## 의존

- 외부: `pino`, `zod`
- 내부: 없음 (단방향)

## 진입 가이드

1. env.ts에 모든 환경변수를 zod schema로 정의
2. logger.ts는 pino 한 인스턴스 + `child({ module: '...' })` 패턴
3. paths.ts에 worktree 표준 경로를 함수로
   - `promptPath(worktree, index, stepId)`
   - `outputPath(worktree, index, stepId)`
   - `diffPath(worktree, index, stepId)`
4. 모두 단위 테스트
