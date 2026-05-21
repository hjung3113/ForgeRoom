# ForgeRoom — 작업 진입 가이드

이 레포에서 작업할 때 반드시 따른다.

## 첫 진입 순서

1. [Docs/overview.md](Docs/overview.md) — 무엇을 만드는가
2. [Docs/architecture.md](Docs/architecture.md) — 시스템 구성
3. 작업할 모듈의 [Docs/modules/<name>.md](Docs/modules/) 또는 개념의 [Docs/concepts/<topic>.md](Docs/concepts/)
4. 진입할 폴더의 `context-map.md`

## 절대 룰

- **설계 결정은 ADR 동반**. 기존 문서에 영향 주는 변경은 ADR `proposed` → 사용자 승인 → `decided` + 영향 문서 동시 갱신
- **placeholder 금지**. TBD/TODO 코드·문서에 남기지 않음
- **시크릿 절대 커밋 X**. `.env` 등은 `.gitignore` 유지
- **main 직접 push 금지**. PR로만
- **`--no-verify` 금지**. hook 실패 시 원인 수정

## 규칙 파일 (필독)

| 영역 | 위치 |
|---|---|
| 코딩 원칙 | [Docs/rules/coding-rules.md](Docs/rules/coding-rules.md) |
| 네이밍 | [Docs/rules/naming-rules.md](Docs/rules/naming-rules.md) |
| 테스트 | [Docs/rules/testing-rules.md](Docs/rules/testing-rules.md) |
| 문서 작성 | [Docs/rules/doc-rules.md](Docs/rules/doc-rules.md) |
| Git/커밋/PR | [Docs/rules/git-rules.md](Docs/rules/git-rules.md) |
| Context Map | [Docs/rules/context-map-rules.md](Docs/rules/context-map-rules.md) |

## 폴더 규약

- 모든 코드 폴더에 `CLAUDE.md` (이 폴더의 규칙) + `context-map.md` (이 폴더의 안내) 존재
- 새 폴더 만들면 두 파일 함께 생성

## 핵심 결정 요약 (최신 상태는 ADR 참고)

- 런타임: Node.js + TypeScript
- DB: SQLite + Drizzle
- Agent 실행: OpenClaw 위임
- 프롬프트 전달: 파일 기반 (worktree `.forgeroom/`)
- 총괄 Conductor 메타 에이전트 (옵션 B: headless + 롤링 요약)
- 워크플로우는 라이브러리 + 호출 시 선택
- 데스크탑 앱·Tailscale = Phase 3
- Phase 1 MVP 범위: [Docs/phases/phase-1-mvp.md](Docs/phases/phase-1-mvp.md)

## 미해결 항목

[Docs/open-questions.md](Docs/open-questions.md) — 진행 중 결정·검증 필요 항목

## 용어 충돌 방지

작업 전 [Docs/glossary.md](Docs/glossary.md) 확인. 특히 `Conductor` vs `Orchestrator`, `Phase` 의 두 의미 등.

## 작업 워크플로우 (사람·에이전트 공통)

1. plan 또는 task 확인
2. 진입 폴더의 `context-map.md` → `CLAUDE.md` 읽기
3. 관련 모듈 spec + 개념 문서 확인
4. 테스트 먼저 또는 동시에 작성
5. 구현
6. lint + typecheck + test 통과 (pre-commit이 강제)
7. 커밋 (1 task = 1 commit 권장)
8. 영향 받은 문서 갱신
9. PR
