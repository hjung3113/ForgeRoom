---
status: decided
last_reviewed: 2026-05-23
---

# Toolchain

pnpm workspace 기반 빌드/테스트/린트 환경. orchestrator 패키지(`apps/orchestrator`)가 모든 코드의 단일 진입점이다.

## 요구 사항

- Node.js `>=22.13.0` (ADR-018; Mastra 1.x 요구)
- pnpm 11+

## 레이아웃

- 루트: `pnpm-workspace.yaml`, `package.json`(스크립트 위임), `eslint.config.js`(flat), `prettier.config.js`
- 패키지: `apps/orchestrator` — `tsconfig.json`(strict, ESM/NodeNext, ES2022; typecheck+lint이 src·tests 모두 포함), `tsconfig.build.json`(src 전용, `dist/` 산출), `vitest.config.ts`(unit + integration 두 project)
- `@mastra/*`는 minor 고정(예: `@mastra/core` `1.36.0`, `^`/`~` 금지). 그 외 의존성은 caret 허용.

## 명령

루트 또는 `pnpm -F orchestrator <script>`로 실행한다.

| 명령 | 동작 |
|---|---|
| `pnpm install` | 의존성 설치 (better-sqlite3·esbuild 네이티브 빌드 허용은 `pnpm-workspace.yaml`의 `allowBuilds`) |
| `pnpm -F orchestrator typecheck` | `tsc --noEmit` |
| `pnpm -F orchestrator lint` | `eslint .` |
| `pnpm -F orchestrator test` | vitest 전체 (unit + integration) |
| `pnpm -F orchestrator test:unit` | unit project만 (`src/**/*.test.ts`) |
| `pnpm -F orchestrator test:integration` | integration project만 (`tests/integration/**/*.test.ts`) |
| `pnpm -F orchestrator build` | `tsc` → `dist/` |
| `pnpm format` / `pnpm format:write` | prettier 검사 / 수정 |

## 테스트 배치

- unit: 소스 옆 `src/**/*.test.ts`
- integration: `apps/orchestrator/tests/integration/**/*.test.ts` (Stage 3 review-decision의 named integration target 유지)

## 관련

- ADR-001 Node.js + TypeScript 런타임
- ADR-015 Mastra workflow primitives
- ADR-018 Node baseline 22.13+
