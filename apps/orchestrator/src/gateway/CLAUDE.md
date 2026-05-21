---
status: living
last_reviewed: 2026-05-21
---

# gateway/ Rules

작업 시작 전 [context-map.md](context-map.md)부터.

## 핵심 규칙

1. **얇은 어댑터로 유지**. 외부 SDK(discord.js, Octokit)와 core 사이의 통역만. 비즈니스 로직 금지
2. **외부 IO 모두 여기**. core에서 discord.js나 Octokit을 직접 import하면 안 됨
3. **입력 검증·sanitize 책임**. 외부에서 들어온 명령·이슈 본문은 여기서 검증 후 core로 전달
4. **allowlist 적용 지점**. Discord 사용자 ID 검사, GitHub repo 등록 검사 모두 여기
5. **재시도·backoff**. API 호출 실패 시 여기서 backoff. core 호출은 깔끔하게

## 파일 단위

- `discord-gateway.ts`
- `github-gateway.ts`
- `clients/` (sub-folder, 필요 시): SDK 래핑

## 금기

- 워크플로우 해석·step 실행 로직 (core 영역)
- TaskStore 직접 호출 (`PipelineEngine` 같은 core API를 통해)
- 시크릿 로깅

## 체크리스트

- [ ] core 모듈을 직접 호출하나 (TaskStore X)
- [ ] 입력 검증·allowlist 적용했나
- [ ] API 에러를 도메인 에러로 변환했나
- [ ] mock 가능하도록 SDK는 생성자 주입했나

## 상위 규칙

- [src/CLAUDE.md](../CLAUDE.md)
- [보안 정책](../../../../Docs/policies/security.md)
