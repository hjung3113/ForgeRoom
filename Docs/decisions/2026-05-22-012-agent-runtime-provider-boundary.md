---
status: decided
date: 2026-05-22
supersedes: 2026-05-21-003-agent-runner-openclaw-delegation.md
---

# ADR-012: AgentRuntimeProvider 경계를 MVP에 도입

## 배경

ADR-003은 MVP의 AgentRunner를 OpenClaw에 직접 위임하기로 결정했다. 이 결정은 구현을 단순하게 만들지만, 사내 환경처럼 OpenClaw 대신 특정 CLI runtime gateway 또는 CLI agent를 사용해야 하는 경우 AgentRunner와 설정 schema를 다시 뜯어고치게 만든다.

사내 환경 지원 자체는 MVP 범위가 아니다. 하지만 MVP 구현 시 AgentRunner가 OpenClaw에 과도하게 결합되면 Forge Phase 2에서 OpenCode 같은 provider를 추가할 때 핵심 실행 경계를 재작성해야 한다.

## 결정

MVP에 `AgentRuntimeProvider` interface를 도입한다.

MVP에서 구현하고 검증하는 provider는 `OpenClawProvider` 하나로 제한한다. `OpenCodeProvider`, `HermesProvider`, 직접 CLI provider는 Forge Phase 2 후보로 둔다.

## 이유

- MVP의 실제 실행 경로는 기존처럼 OpenClaw 중심으로 유지한다.
- AgentRunner가 provider-neutral 요청/응답 contract에만 의존하게 해 Phase 2의 사내 provider 추가 비용을 낮춘다.
- `configs/agents.yaml`의 `provider` 필드를 처음부터 일반화해 Intent에서 실제 실행까지 추적 가능한 경로를 유지한다.
- 사내 환경 구현을 MVP에 끌어오지 않으면서도 later refactor를 줄인다.

## 결과

- `OpenClawAgentRegistry`는 `AgentRegistry`로 일반화한다.
- `AgentRunner`는 `AgentRuntimeProvider`를 선택해 호출한다.
- MVP validation은 `provider: openclaw`만 허용한다.
- OpenCode provider 구현, OpenCode CLI 옵션 mapping, provider별 permission profile은 Forge Phase 2로 미룬다.
- Provider request는 ForgeRoom의 파일 기반 실행 계약(`promptPath`, `outputPath`, `cwd`)을 전달한다. Provider는 agent runtime에 실행을 지시하지만 output 파일 검증은 하지 않는다.
- stdout/stderr log path는 AgentRunner가 task artifact로 할당하고, Provider는 주어진 경로에 runtime output과 raw diagnostics를 기록한다.
- Timeout budget은 ForgeRoom workflow/step policy이며 AgentRunner가 request에 전달한다. Provider는 가능한 경우 runtime 호출에 적용하고 공통 `failureKind: 'timeout'`으로 반환한다.
- MVP 기본 실행 mode는 `headless`다. `pty`는 pseudo-terminal 기반 interactive/session 실행을 뜻하며 optional provider capability로 둔다.
- Provider `resume`은 session continuation primitive다. Retry budget, resume prompt, headless fallback 판단은 AgentRunner 책임이다.
- Provider `health`는 endpoint/IPC, token/env, configured runtime 이름을 확인하는 얕은 readiness check로 제한한다.
- `AgentRunResult`는 ForgeRoom 공통 `failureKind`만 노출하고 provider-specific raw code는 stdout/stderr/log에 남긴다.
- MVP 설정은 ForgeRoom Step Harness registry key인 `harness`를 사용한다. Provider-native `runtime_harness`와 provider-specific permission profile은 Forge Phase 2로 미룬다.
- CLI runtime이 cwd 기준 `AGENTS.md`/`CLAUDE.md`를 자동으로 읽는 동작은 provider/runtime behavior로 허용하되, ForgeRoom MVP는 project-local 규칙과 Step Harness의 merge precedence를 보장하지 않는다.

## 비범위

- 임의 custom CLI 등록
- provider hot reload
- provider별 stdout streaming
- provider별 permission sandbox 통합
