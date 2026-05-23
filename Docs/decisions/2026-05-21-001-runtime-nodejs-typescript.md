---
status: decided
date: 2026-05-21
---

# ADR-001: Orchestrator 런타임으로 Node.js + TypeScript

## 배경

ForgeRoom orchestrator는 Discord WebSocket gateway, GitHub API polling, 다중 CLI agent 호출, SQLite I/O, 워크플로우 DSL 해석을 하나의 프로세스에서 수행해야 한다. 후보 런타임은 Node.js / Python / Go.

## 옵션

- **Node.js + TypeScript**: discord.js·Octokit 성숙, 비동기 I/O 자연스러움, OpenClaw가 Node 생태계 친화
- **Python**: discord.py·GitPython 사용 익숙, subprocess 친화
- **Go**: 단일 바이너리 배포, 동시성·프로세스 관리 강함

## 결정

**Node.js + TypeScript**.

## 이유

- Discord/GitHub 라이브러리 성숙도 최고 (discord.js, Octokit)
- TypeScript 타입 시스템으로 워크플로우 DSL·인터페이스 안전성 확보
- OpenClaw가 이미 Node 환경에 익숙
- npm 생태계로 yaml 파서, sqlite 바인딩, file watcher 등 즉시 활용
- 비동기 I/O가 다중 agent 병렬 호출에 자연스럽게 맞음

## 결과

- 모든 코어 코드는 TypeScript
- 빌드: `tsc` 또는 esbuild
- 런타임 의존성 관리: pnpm 또는 npm

## 후속 검토

- 단일 머신 한계 도달 시 Go re-evaluation
- 빌드 시간이 문제 되면 esbuild·swc 도입 검토

## 갱신

- Node 런타임 baseline은 `>=22.13.0` (ADR-018). Mastra(ADR-015) 채택이 동인.
