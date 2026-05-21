---
status: living
last_reviewed: 2026-05-21
---

# gateway/ Context Map

## 책임

Discord, GitHub 외부 인터페이스 어댑터. 외부 입력 수신·검증, core 호출, 외부 API 발송.

## 주요 파일 (예정)

| 파일 | 역할 | spec |
|---|---|---|
| `discord-gateway.ts` | 슬래시 명령 수신·allowlist·core 라우팅 | [Docs/modules/discord-gateway.md](../../../../Docs/modules/discord-gateway.md) |
| `github-gateway.ts` | Issue label polling·PR 생성 | [Docs/modules/github-gateway.md](../../../../Docs/modules/github-gateway.md) |
| `types.ts` | 게이트웨이 외부 노출 타입 | — |

## 같이 읽을 문서

- [Discord Gateway spec](../../../../Docs/modules/discord-gateway.md)
- [GitHub Gateway spec](../../../../Docs/modules/github-gateway.md)
- [Reporter (응답 발송)](../../../../Docs/modules/reporter.md)
- [보안 정책](../../../../Docs/policies/security.md)

## 의존

- 외부: `discord.js`, `@octokit/rest`
- 내부: `core/` (PipelineEngine, Reporter, Conductor)

## 진입 가이드

1. spec의 명령·이벤트 목록 정독
2. SDK는 인터페이스로 감싼 후 core에 주입 가능하게 (테스트 위해)
3. allowlist는 가장 먼저 적용
