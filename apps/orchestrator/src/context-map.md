---
status: living
last_reviewed: 2026-05-21
---

# apps/orchestrator/src Context Map

## 책임

ForgeRoom Orchestrator 단일 프로세스의 모든 코드. Discord/GitHub 게이트웨이, 워크플로우 DSL 해석, 에이전트 호출, 작업 상태 관리, PR 생성을 담당.

## 폴더 구조

```
src/
├── core/        # 비즈니스 로직 (Engine, Conductor, Registry, TaskStore 인터페이스)
├── gateway/     # Discord, GitHub 외부 인터페이스 어댑터
├── dsl/         # 워크플로우 yaml 파서·변수 보간
├── db/          # Drizzle 스키마·마이그레이션·SQLite (TaskStore 구현)
├── utils/       # 도메인 독립 헬퍼 (logger, secret-mask, path utils)
└── index.ts     # 진입점 (예정)
```

각 폴더는 자체 `context-map.md` + `CLAUDE.md`.

## import 방향

```
gateway ──┐
dsl     ──┼──▶ core ──▶ utils
db      ──┘
```

- core는 외부 폴더 import 금지
- utils는 단방향 (받기만)

## 같이 읽을 문서

- 진입점: [Docs/overview.md](../../../Docs/overview.md)
- 아키텍처: [Docs/architecture.md](../../../Docs/architecture.md)
- Phase 1 범위: [Docs/phases/phase-1-mvp.md](../../../Docs/phases/phase-1-mvp.md)
- 모듈 spec: [Docs/modules/](../../../Docs/modules/)
- 데이터 모델: [Docs/concepts/data-model.md](../../../Docs/concepts/data-model.md)
- DSL: [Docs/concepts/workflow-dsl.md](../../../Docs/concepts/workflow-dsl.md)
- 프롬프트 프로토콜: [Docs/concepts/prompt-file-protocol.md](../../../Docs/concepts/prompt-file-protocol.md)

## 의존 (런타임)

- Node.js ≥ 20
- TypeScript ≥ 5
- 주요 패키지 (예정): `better-sqlite3`, `drizzle-orm`, `discord.js`, `@octokit/rest`, `yaml`, `zod`, `pino`, `node-pty` (옵션)

## 진입 가이드

1. 작업할 영역의 모듈 spec 읽기 (`Docs/modules/<name>.md`)
2. 해당 폴더 진입 후 `context-map.md` → `CLAUDE.md`
3. 의존하는 인터페이스 확인 (`types.ts`)
4. 테스트 파일부터 보고 동작 파악
