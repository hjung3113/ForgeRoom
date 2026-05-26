---
status: decided
date: 2026-05-26
---

# ADR-028: Project Room 도메인 + Phase 1.5 seam

## 배경

MVP가 main에 머지됐다 (Discord/GitHub Issue → worktree → agent → check → PR, claude+codex 실멀티런타임 라이브). 다음 단계 방향으로 "Project Rooms 로드맵 v3"(`Docs/phases/project-rooms-roadmap-v3.md`)가 제안됐다. 핵심은 ForgeRoom을 단순 PR 생산기에서 **프로젝트별 작업방(Project Room)** 단위 운영 시스템으로 확장하는 것이다.

이 ADR은 (1) `Project Room`을 공식 도메인 용어로 채택하고, (2) Forge Phase 2의 첫 슬라이스인 "Phase 1.5 seam"의 설계 경계를 결정한다. codex grill로 검증했다(아래 신뢰도 표기).

## 결정

### 1. Project Room을 좁게 정의해 채택 (codex 84)

`Project Room` = 한 **Target Project**에 묶인 협업·관제 공간. 묶는 것: Discord 채널/thread 정책, default workflow/model policy, OpenClaw room/session·role agent, Canvas/reporting 설정.

- **소스 repo(Target Project)도, 실행 단위(Task)도 아니다.**
- 문서/스키마에서 항상 풀 용어로 쓰고 "Project"로 축약하지 않는다 (`Project`/`Target Project`와의 과부하 방지).
- glossary + CONTEXT.md에 등재.

### 2. Phase 1.5 seam = 4파트 (codex 87)

보이는 UX(Discord Project Channels 등) 전에 까는 최소 기반:

1. **ProjectRoom config schema** — `projects.yaml`에 `discord`/`openclaw`/`mastra` 섹션 예약. 기존 config는 migration 없이 동작.
2. **Discord channel → project 역해석** — DiscordGateway가 channel id로 project를 역추론(아직 thread/UX는 Phase 2A).
3. **per-run OpenClaw session/agent override** — 전역 `FORGEROOM_OPENCLAW_AGENT` fallback 유지 + project/role override.
4. **TaskStore session-handle 컬럼** — nullable.

### 3. runtimeSession을 ResolvedRuntimeTarget과 분리 (codex 87)

- `ResolvedRuntimeTarget`은 **"어떤 런타임/모델/정책"** 책임 유지 — `permissionProfile`도 여기(ADR-023/024가 이미 target policy로 둠).
- OpenClaw native **"이 task/run의 구체 세션·신원"**(`agentId`/`sessionId`/`sessionKey`/`role`)은 **새 per-run 구조 `AgentRunRequest.runtimeSession`**(또는 `providerOverrides`)에 둔다.
- 이유: "무엇을 실행할지"와 "어느 provider 세션으로 실행할지"를 한 타입에 섞지 않는다.

### 4. TaskStore session 컬럼 = 권위 아님 (codex 90)

`openclaw_session_id` / `openclaw_agent_key` / `openclaw_role` 컬럼은 **nullable provider resume hint/handle**이다.

- TaskStore step row = task/step 상태 권위, `.forgeroom/` = prompt/output/diff 권위 (ADR-017 유지).
- OpenClaw session 상태는 recoverable/discardable. session id가 next step/성패/출력 진실을 결정하기 시작하면 ADR-017 위반.

### 5. ADR-013은 additive (codex 82)

프로젝트별 Discord 채널 + task-thread 라우팅은 **task당 canonical status surface가 여전히 1개**인 한 ADR-013에 additive(개정 불필요). TaskSource/Project Room route가 그 1개 surface를 선택한다. Canvas는 non-authoritative mirror/read-model일 때만 별도 sink로 허용.

### 6. 순서: Project Room seam 먼저, 풀 Step Harness 다음 (codex 78 — 사용자 확정)

- Project Room = "이 task가 어디서 왔고, 어떤 project 기본값/런타임 세션·agent를 쓰나".
- Step Harness = "각 step이 어떤 실행 환경/계약을 받나" (glossary의 Step Harness 정의 = prompt contract+hooks+skills+plugins+AGENTS.md+output rules; #69/ADR-027은 그 prompt-contract 조각만 구현).
- 방 라우팅 때문에 HarnessInstaller/RuntimeProfileCompiler를 먼저 짓지 않는다. 둘은 직교적이며, 미래 접점은 "Project Room이 default harness/model policy를 고를 수 있다"는 것뿐.

## 결과

- glossary.md + CONTEXT.md: `Project Room` 등재.
- `Docs/phases/project-rooms-roadmap-v3.md`: 출처 로드맵 보존(status draft).
- Phase 1.5 seam은 별도 이슈로 분해(ProjectRoom config / Discord channel bind / runtimeSession + per-run override / TaskStore session 컬럼).
- 미해결로 남긴 것: 풀 Step Harness(HarnessInstaller/harness.yaml/OutputContractValidator/RuntimeProfileCompiler)는 seam 다음 별도 ADR.

## 관련

- ADR-013: TaskSource/Reporter 경계 (additive)
- ADR-017: TaskStore/.forgeroom 권위 (session 컬럼은 hint)
- ADR-023: ResolvedRuntimeTarget (runtimeSession과 분리)
- ADR-024: 정적 ModelPolicyRegistry
- ADR-027: harness 계약 prompt 합성 (Step Harness의 첫 조각)
- `Docs/phases/project-rooms-roadmap-v3.md`: 출처 로드맵
