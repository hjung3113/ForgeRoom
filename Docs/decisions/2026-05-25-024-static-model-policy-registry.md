---
status: decided
date: 2026-05-25
---

# ADR-024: 정적 ModelPolicyRegistry (B2, Phase 2A)

## 배경

현재 step의 model은 intent→agent→agents.yaml의 고정 `model`로 결정된다. 설계 노트(Phase 2A)는 workflow가 model을 직접 고정하지 말고 **policy를 참조**해 runtime/model을 고르게 하자고 한다. ADR-023이 provider-neutral `ResolvedRuntimeTarget` + `AgentRunRequest.runtimeTarget`(명시 target이 우선)를 도입해 둔 상태라, policy가 target을 산출해 request에 실으면 된다.

## 결정 (strictly static — codex grill 2026-05-25)

`intent.model_policy`(optional) + `configs/model-policies.yaml` + `ModelPolicyRegistry`를 도입한다. **PRIMARY target만** 해석한다. fallback/escalation/telemetry는 구현하지 않으며(#66로 미룸), 관련 키는 **조용히 무시하지 않고 거부**한다.

1. **Intent**: `ResolvedIntent`에 `model_policy?: string` 추가. intents.yaml에서 optional.
2. **ModelPolicyRegistry** (core/registries/model-policy-registry.ts): `configs/model-policies.yaml` 로드. 정책 shape:
   ```yaml
   <policy-id>:
     description?: string
     primary: { provider, runtime, model, permissionProfile? }
   ```
   `primary`만 사용. `fallback`/`escalate_if`/`budgetMode` 등 미지원 키가 있으면 **fail-fast**(“not supported in Phase 2A”) — silent ignore 금지(config fraud 방지). `resolve(id)` → `ResolvedRuntimeTarget`.
3. **검증(fail-fast at loadRegistries)**: model-policies.yaml 먼저 빌드 → `IntentRegistry.fromConfig`에 `policyExists` 주입해 존재하지 않는 `intent.model_policy` 참조를 boot 시점에 거부(intent→agent, workflow→intent 검증과 동일 계열). 런타임 lazy 실패 금지.
4. **주입 지점**: `StepCollaborators.runAgent`가 `resolved.intentId`로 intent 조회 → `model_policy` 있으면 `ModelPolicyRegistry.resolve` → `runtimeTarget`을 AgentRunRequest에 설정(ADR-023의 "target wins" 경로 사용). 없으면 기존대로 agent-derived. `IntentRegistry` + `ModelPolicyRegistry`를 pipeline-engine deps 통해 StepCollaborators에 주입.
5. **Routing-decision artifact**: `<worktree>/.forgeroom/routing/NN_<stepId>.json`을 **항상** 기록(policy 없으면 `policyId: null`, agent-derived). shape:
   ```json
   { "stepId","intentId","policyId":string|null,
     "selected":{"providerId","runtime","model"},
     "fallbackChain":[], "reason":[ ... ] }
   ```
   `reason[]`는 정적이고 정직하게(예: `["kind=execute","policy=<id>","static=true"]` 또는 `["policy=none","source=agent"]`).

## 이유

- ADR-023 target seam 덕에 policy는 runtimeTarget 산출만 하면 됨 — provider 경계 변경 0.
- 항상 기록하는 routing artifact는 "왜 이 model을 썼나"를 코드 탐색 없이 설명(설계 노트 원칙 4).
- 미지원 키 거부는 나중에 fallback 붙일 때 형식 호환을 유지하면서도 거짓 신뢰를 막는다.

## 결과

- 행동보존: 프로덕션 intents.yaml은 `model_policy` 미설정으로 두어 기존 model 그대로(agent-derived). policy 경로는 테스트로 커버.
- `.forgeroom/routing/` artifact가 매 execute step마다 생김(관측용, 무해).
- 후속(#66): fallback chain, escalation rules, telemetry(SQLite), capability matrix.

### 영향 파일
- `core/registries/intent-registry.ts` (model_policy + policyExists 검증)
- `core/registries/model-policy-registry.ts` (신규)
- `app/config.ts` (model-policies.yaml 로드 + cross-validation + LoadedRegistries)
- `core/engine/step-collaborators.ts` (policy→runtimeTarget + routing artifact)
- `core/engine/pipeline-engine.ts` (deps: modelPolicies)
- `app/composition-root.ts` (주입)
- `configs/model-policies.yaml` (신규)

## 비범위 (CUT)
- fallback/escalation/telemetry/capability matrix (#66)
- dynamic/adaptive routing
- intent.model_policy를 프로덕션 intents.yaml에 강제 적용
