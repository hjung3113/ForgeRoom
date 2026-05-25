---
status: decided
date: 2026-05-25
---

# ADR-023: ResolvedRuntimeTarget — provider-neutral 실행 타깃 (B1, scope A)

## 배경

ForgeRoom Runtime Abstraction 설계 노트(Phase 1.5)는 core가 특정 runtime(OpenClaw) 세부를 모르게 하라고 권한다. 현재 `AgentRuntimeProvider.run(req, agent: ResolvedAgent)`에서 provider가 `agent.runtime`/`agent.model`을 직접 읽고, OpenClaw 전용 transport 타입(`OpenClawExecutionRequest` 등)이 `core/agent-runtime/openclaw-provider.ts`에 산다. ADR-012가 `AgentRuntimeProvider` 경계는 잡았지만, model routing(Phase 2A)을 붙이려면 "어떤 runtime/model로 실행할지"를 표현하는 provider-neutral 타깃 타입이 필요하다.

## 결정 (scope A — minimal, codex grill 2026-05-25)

provider-neutral `ResolvedRuntimeTarget`를 도입하고 `AgentRunRequest`에 실어 보낸다. **OpenClawProvider를 core 밖으로 옮기지 않는다**(그건 deferred 후속 이슈 = scope B).

1. **타입** (core/agent-runtime):
   ```ts
   interface ResolvedRuntimeTarget {
     providerId: string;   // ResolvedAgent.provider에서 매핑 (예: 'openclaw')
     runtime: string;
     model: string;
     permissionProfile?: string; // forward-looking, optional
   }
   ```
   `providerType` 리터럴 union은 도입하지 않는다(지금 OpenClaw뿐 — ceremony). `agentId`도 넣지 않는다(ForgeRoom agent 이름과 혼동 금지; OpenClaw native agent id 'main'은 provider config로 유지).

2. **AgentRunRequest** += `runtimeTarget?: ResolvedRuntimeTarget` (optional).

3. **DefaultAgentRunner**가 resolve한 `ResolvedAgent`에서 `runtimeTarget`을 만들어 request에 실는다. provider 시그니처는 `run(req, agent)` 유지(option a) — churn 최소화, ResolvedAgent는 여전히 registry authority.

4. **OpenClawProvider**는 `req.runtimeTarget?.runtime/model`을 우선 쓰고, 없으면 `agent.runtime/model`로 fallback. 테스트가 이 preference를 검증한다.

5. **OpenClaw transport 타입은 core에 그대로 둔다.** OpenClawProvider가 core에 있고 core는 app을 import할 수 없으므로(그 타입들을 app/openclaw-ipc.ts가 down-layer로 import하는 현 구조가 맞다), 타입을 app으로 옮길 수 없다. core에서 OpenClaw 흔적을 완전히 지우는 것은 **provider relocation(scope B)** 후속 이슈로 미룬다.

## 이유

- model routing(ModelPolicyRegistry, #62)이 `ResolvedRuntimeTarget`을 산출해 request에 실으면 됨 — provider 경계 재작성 불필요.
- option (a)는 resume/retry 경로가 이미 `AgentRunRequest`를 thread하므로 추가 churn이 적다. dual path(target 우선 / agent fallback)는 마이그레이션 seam으로 허용.
- RuntimeCapabilities/capability matrix는 CUT(실 2nd provider 또는 실 호환 실패 전까지).

## 결과

- 행동보존: target 미지정 시 기존 agents.yaml 경로 그대로. 318+ unit/integration green이 canary.
- `ResolvedRuntimeTarget`가 provider-neutral 실행 타깃 계약이 된다. OpenClaw provider/transport 타입은 provider relocation 이슈까지 core에 잔존.
- 후속 이슈(deferred): (B) OpenClawProvider를 app/로 이전해 core/agent-runtime을 완전 중립화.

### 영향 파일
- `core/agent-runtime/agent-runner.ts` (타입 + DefaultAgentRunner)
- `core/agent-runtime/openclaw-provider.ts` (target 우선 사용)
- 관련 test (preference 검증)

## 비범위
- OpenClawProvider 이전(scope B)
- RuntimeCapabilities / capability matrix
- providerType union, per-target agentId/endpoint/token override
