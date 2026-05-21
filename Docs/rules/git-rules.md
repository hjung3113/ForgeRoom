---
status: decided
last_reviewed: 2026-05-21
---

# Git 룰

## 브랜치

- 기본 브랜치: `main`
- 작업 브랜치 (사람): `feat/<short>`, `fix/<short>`, `chore/<short>`, `docs/<short>`
- 작업 브랜치 (에이전트): `agent/<project>-<task-id-short>` (ForgeRoom orchestrator가 자동 생성)
- `main` 직접 push 금지. 반드시 PR

## 커밋 메시지

Conventional Commits 느슨한 버전:

```
<type>: <subject>

<body, optional>

Co-Authored-By: ...    # 옵션
```

type:
- `feat`: 새 기능
- `fix`: 버그 수정
- `docs`: 문서만
- `refactor`: 동작 변경 없는 구조 개선
- `test`: 테스트만
- `chore`: 빌드·도구·설정
- `perf`: 성능 개선
- `style`: 포맷 (논리적 변경 없음)

subject:
- 영어 또는 한국어 통일 (PR 내에선 한 종류)
- 명령형 ("add X", "fix Y") 또는 평서형 ("X 추가")
- 70자 이내

body:
- WHY 중심
- 어떤 결정 ADR을 따랐는지 명시 가능 (`See ADR-005`)

## 커밋 단위

- 한 커밋 = 한 논리적 변경
- 빌드 가능 + 테스트 통과 상태로
- 큰 변경은 작게 쪼개기. plan의 한 task ≈ 1 커밋

## PR

- 제목: 커밋 메시지 첫 줄 형식
- 본문:
  - Summary (3줄 이내)
  - 영향 받는 모듈·문서
  - 관련 ADR/OQ 링크
  - 테스트 방법
- 자체 리뷰 후 등록
- review checklist (Phase 2에서 자동화)

## 머지

- squash merge 기본 (PR 단위 깔끔히 보존)
- main에 머지된 커밋은 force-push 금지
- 머지는 사람 수동 (GitHub UI)

## Hook (Husky)

pre-commit:
1. `pnpm lint`
2. `pnpm typecheck`
3. `pnpm test:unit`

pre-push (Phase 2):
- 빠른 통합 테스트

`--no-verify` 사용 금지. hook 실패 시 원인 수정 후 재시도.

## `.gitignore` 핵심

```
node_modules/
data/*.sqlite
data/*.sqlite-shm
data/*.sqlite-wal
logs/
worktrees/
.env
.env.local
*.log
.DS_Store
dist/
.tsbuildinfo
```

## 시크릿

- `.env` git 무시 절대 유지
- 토큰·키 패턴이 의심되는 파일은 커밋 전 차단 (Phase 2: pre-commit secret scan)

## 태그 (Phase 2)

- `v0.1.0` SemVer 시작
- MVP 완료 시점에 `v0.1.0` 태깅
