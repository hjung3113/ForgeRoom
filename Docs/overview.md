---
status: decided
last_reviewed: 2026-05-21
---

# ForgeRoom 개요

ForgeRoom = 로컬 단일 머신에서 동작하는 중앙 멀티에이전트 오케스트레이터. Discord/GitHub를 인터페이스로, OpenClaw가 제공하는 CLI 에이전트(Claude Code, Codex, Gemini CLI 등)를 활용해 프로젝트별 worktree에서 코드 작업을 자동화한다.

## 비전

원격(모바일)에서 작업을 지시하면, 로컬 머신에서 다중 CLI 에이전트가 워크플로우대로 협업해 PR을 생성한다. 사람은 머지만 한다.

## 핵심 원칙

1. 오케스트레이터는 중앙에 1개 (`~/forgeroom/`)
2. 실제 프로젝트에는 거의 아무것도 심지 않음 (`AGENTS.md` 정도만)
3. 프로젝트는 설정(`projects.yaml`)으로 등록
4. 1 task = 1 Issue = 1 Branch = 1 Worktree = 1 PR
5. 에이전트는 같은 worktree를 turn-taking
6. 프롬프트는 파일 기반 전달 (CLI 직접 주입 X)
7. 소통은 Discord / GitHub
8. 실행은 로컬
9. 품질은 Git / 테스트 / 리뷰로 강제
10. 워크플로우는 yaml로 자유 정의·재사용

## 시스템 구성

- [아키텍처 다이어그램·모듈 목록](architecture.md)
- [모듈별 상세](modules/)
- [핵심 개념: 워크플로우 DSL, 데이터 모델, 프롬프트 프로토콜, Conductor](concepts/)
- [운영 정책: 보안, 에러·재시도, 동시성, 승인](policies/)
- [Phase 1 MVP 범위와 완료 정의](phases/phase-1-mvp.md)

## 규칙

- [코딩 룰](rules/coding-rules.md)
- [네이밍 룰](rules/naming-rules.md)
- [테스트 룰](rules/testing-rules.md)
- [문서 룰](rules/doc-rules.md)
- [Git 룰](rules/git-rules.md)
- [Context Map 룰](rules/context-map-rules.md)

## 결정 기록

- [ADR 인덱스](decisions/README.md)

## 진행 상태

- [Open Questions](open-questions.md)
- [Glossary](glossary.md)

## 비범위 (MVP 명시 제외)

- 데스크탑 앱 GUI → Phase 3
- Tailscale / inbound 접근 → Phase 3
- 다중 머신 / 분산 큐
- 한 task 안 병렬 sub-task
- 사용자별 권한 분리 (Discord allowlist만)
- LLM judge 기반 자동 품질 평가
- 동적 워크플로우 변형
