---
status: decided
last_reviewed: 2026-05-21
---

# AgentRunner + AgentRuntimeProvider

## 책임

- AgentRuntimeProvider에 에이전트 호출 위임
- 파일 기반 IO: 입력 = `prompts/NN.md`, 출력 = `outputs/NN.md`
- headless 기본, PTY는 옵션(Forge Phase 1에서 PTY 사용 케이스는 Conductor 정도)
- output 파일 검증 + resume 재시도

## 경계

ForgeRoom은 CLI agent process 실행 세부사항을 AgentRuntimeProvider 뒤에 둔다. Claude Code, Codex, Gemini CLI 같은 runtime별 실행 방식, 모델명, 인증, session/resume, PTY/headless 차이는 provider가 책임진다.

AgentRunner는 ForgeRoom의 task/step 실행 문맥을 provider-neutral 요청으로 변환하고, 반환된 실행 결과와 파일 검증 결과를 PipelineEngine에 돌려주는 adapter다.

MVP는 `AgentRuntimeProvider` interface를 도입하되 구현체는 `OpenClawProvider` 하나로 고정한다. `OpenCodeProvider`, `HermesProvider`, 직접 CLI provider는 Forge Phase 2 후보로 둔다.

Provider 설정은 `configs/agents.yaml`에 둔다. agent id, provider, runtime, model이 한 파일에 있어야 Intent의 `agent: <id>`가 실제 실행으로 resolve되는 경로를 추적하기 쉽다.

```yaml
runtime_provider:
  type: openclaw
  endpoint: http://127.0.0.1:...
  token_env: OPENCLAW_TOKEN

agents:
  claude:
    provider: openclaw
    runtime: claude-cli
    model: anthropic/claude-opus-4-7
    harness: implementation
```

MVP validation은 `provider: openclaw`만 허용한다. 다른 provider 값은 Forge Phase 2의 provider 구현체가 추가되기 전까지 설정 오류로 처리한다.

`harness`는 ForgeRoom Step Harness registry key다. Step Harness는 hooks, skills, plugins, AGENTS.md/CLAUDE.md 계열 지침, prompt/output contract를 하나하나 Intent에 쓰지 않기 위한 이름붙은 preset이다. AgentRunner는 Resolved Step의 agent와 Step Harness를 합쳐 provider 요청을 구성한다.

MVP에는 provider-native `runtime_harness` 필드를 두지 않는다. Provider-specific harness나 execution profile은 Forge Phase 2에서 provider capability로 재검토한다.

MVP에서 Step Harness의 canonical source는 ForgeRoom이 관리하는 dot-folder preset이다. `configs/harnesses.yaml`은 harness 이름과 source 경로를 매핑하는 registry 역할만 한다.

```text
.forgeroom/
  harnesses/
    implementation/
      harness.yaml
      AGENTS.md
      CLAUDE.md
      skills/
      hooks/
      plugins.yaml
      prompt-contract.md
      output-contract.md
```

```yaml
harnesses:
  implementation:
    source: .forgeroom/harnesses/implementation
```

실행 시 ForgeRoom은 harness source를 task worktree의 runtime context로 fetch/copy/link 하고 validate한다. 실행 중 외부 plugin/skill을 매번 설치하는 방식은 MVP에서 피한다.

MVP에서는 target project 안의 기존 harness/provider-local 설정을 ForgeRoom이 자동으로 읽거나 병합하거나 덮어쓰지 않는다. ForgeRoom Step Harness는 task worktree 내부의 ForgeRoom 전용 runtime context에 배치한다.

Provider는 `cwd`를 task worktree로 받아 실행한다. 따라서 Claude Code, Codex 같은 CLI runtime이 cwd 기준 `AGENTS.md`/`CLAUDE.md`를 자동으로 읽는 동작은 provider/runtime behavior로 허용한다. ForgeRoom MVP는 project-local 규칙 파일과 Step Harness의 merge precedence를 보장하지 않는다. Launch isolation, provider-specific precedence, project-local harness merge 정책은 Forge Phase 2에서 정의한다.

## AgentRegistry

```typescript
interface AgentRegistry {
  load(): Promise<void>
  has(agentId: string): boolean         // agents.yaml의 키 → provider runtime 매핑 가능?
  resolve(agentId: string): ResolvedAgent
}

interface ResolvedAgent {
  agentId: string                       // agents.yaml의 키 (예: 'claude')
  provider: 'openclaw'                  // MVP에서는 openclaw만 허용
  runtime: string                       // 예: 'claude-cli', 'openai-codex'
  model: string
  harness: string
}
```

AgentRegistry는 ForgeRoom schema와 정책을 검증한다. MVP에서는 `agentId` 존재 여부, `provider: openclaw` 제한, `runtime`/`model`/`harness` 필수 필드, harness registry 참조 존재 여부를 확인한다.

Provider capability 검증은 AgentRegistry 책임이 아니다. OpenClaw가 특정 `runtime`을 실제로 인식하는지, endpoint/token/env가 실행 가능한지, model 문자열을 provider가 받아들이는지는 `health()` 또는 첫 `run()`에서 드러난다.

## AgentRunner

```typescript
interface AgentRunner {
  run(req: AgentRunRequest): Promise<AgentRunResult>
  resume(req: AgentRunnerResumeRequest): Promise<AgentRunResult>
}

interface AgentRunRequest {
  agentId: string                       // agents.yaml 키
  promptPath: string                    // 절대경로 (worktree 내)
  outputPath: string                    // 절대경로 (worktree 내)
  stdoutPath: string                    // 절대경로 (worktree 내)
  stderrPath: string                    // 절대경로 (worktree 내)
  cwd: string                           // worktree
  mode: 'headless' | 'pty'
  timeoutMs?: number
}

interface AgentResumeRequest {
  sessionId: string
  addendumPromptPath: string
  outputPath: string
  stdoutPath: string
  stderrPath: string
  cwd: string
  mode: 'headless' | 'pty'
  timeoutMs?: number
}

interface AgentRunnerResumeRequest extends AgentResumeRequest {
  agentId: string
  promptPath: string                    // 최초 prompt path, retry prompt naming 기준
  sessionId: string | null              // null이면 addendum prompt로 신규 run fallback
  attempt: number                       // 이번 continuation이 소비하는 output-producing attempt 번호
}

interface AgentRunResult {
  exitCode: number
  failureKind?: 'runtime_unavailable' | 'auth_failed' | 'timeout' | 'agent_error' | 'output_contract_failed'
  outputExists: boolean
  outputBytes: number
  durationMs: number
  sessionId: string | null              // PTY 모드 시 후속 resume용
  stdoutPath: string
  stderrPath: string
}

interface DefaultAgentRunnerOptions {
  agentRegistry: AgentRegistry
  provider: AgentRuntimeProvider
  minOutputBytes?: number
  maxAttempts?: number
  defaultTimeoutMs?: number             // 기본값: 300_000
  createRetryPrompt?: (context: RetryPromptContext) => Promise<string>
}
```

`failureKind`는 ForgeRoom 공통 실패 분류다. Provider-specific raw code(예: gateway HTTP status, provider-local auth reason)는 `AgentRunResult` contract에 노출하지 않고 stdout/stderr/log에 남긴다. Reporter와 task 상태는 공통 `failureKind`만 사용한다.

`output_contract_failed`는 agent가 valid step output을 만들지 못했다는 공통 분류다. AgentRunner는 파일 존재/크기/명백한 거부 응답 같은 generic contract만 검사한다. `## Slices`, `Review Result` 같은 workflow DSL selector 검증은 PipelineEngine이 수행하되, budget과 failure reason은 같은 output-producing attempt 흐름을 사용한다.

PipelineEngine이 output selector 실패를 감지하면 `AgentRunner.resume`에 `AgentRunnerResumeRequest`를 전달해 같은 output-producing attempt budget을 이어 쓴다. AgentRunner는 selector 의미를 해석하지 않고, 전달받은 addendum prompt를 provider `resume` 또는 신규 `run` fallback으로 실행한다.

`promptPath`, `outputPath`, `cwd`는 provider-specific 세부사항이 아니라 ForgeRoom의 파일 기반 실행 계약이다. AgentRunner는 이 경로들을 provider-neutral request로 전달하고, provider는 agent runtime이 해당 cwd에서 prompt 파일을 읽고 output 파일을 쓰도록 지시한다.

Provider는 `outputPath`를 검증하지 않는다. Output 파일 존재 여부, 최소 byte 수, retry/resume 판단은 AgentRunner가 수행한다.

`stdoutPath`와 `stderrPath`도 AgentRunner가 할당하는 task artifact 경로다. Provider는 runtime stdout/stderr와 provider-specific raw diagnostics를 주어진 경로에 기록한다. Log path layout과 cleanup 정책은 ForgeRoom이 소유한다.

`timeoutMs`는 ForgeRoom의 workflow/step execution policy다. AgentRunner가 timeout budget을 결정해 request에 넣고, provider는 가능한 경우 runtime 호출에 적용한다. Caller가 `timeoutMs`를 명시하면 그 값을 보존하고, 생략하면 `DefaultAgentRunnerOptions.defaultTimeoutMs`를 사용한다. 기본 agent run timeout은 `DEFAULT_AGENT_TIMEOUT_MS = 300_000`(5분)이다. Timeout 발생 시 provider는 공통 `failureKind: 'timeout'`으로 반환하고, retry/failed 판단은 AgentRunner가 수행한다.

`mode`는 ForgeRoom이 요청하는 실행 형태다. MVP 기본값은 `headless`다. `pty`는 pseudo-terminal 기반 interactive/session 실행을 뜻하며 optional provider capability로 둔다. Provider가 `pty`를 지원하지 않으면 실행 전 validation error 또는 `failureKind: 'runtime_unavailable'`로 반환한다.

AgentRunner는 `sessionId === null`이면 provider `resume`을 호출하지 않고 신규 `headless` run fallback을 선택할 수 있다. Provider capability discovery와 pty lifecycle 정교화는 Forge Phase 2에서 다룬다.

MVP `AgentRunRequest`에는 provider별 `permissionProfile`을 넣지 않는다. 위험 명령 차단은 ApprovalGate, worktree 외부 write 복원은 WorktreeManager, 품질 검증은 CheckRunner가 맡는다. Provider capability 기반 permission profile은 Forge Phase 2에서 provider별 의미가 정리된 뒤 추가한다.

## AgentRuntimeProvider

`AgentRuntimeProvider.resume`는 provider-level session continuation primitive다. Provider는 기존 session에 추가 prompt를 전달하고 runtime 결과를 반환하는 일만 책임진다.

Output 검증, retry budget, resume prompt 문구, headless fallback 판단은 AgentRunner의 실행 계약이다. Provider별 구현체가 자체 retry 정책을 갖지 않게 해 OpenClawProvider와 Forge Phase 2 provider가 같은 ForgeRoom retry semantics를 따른다.

```typescript
interface AgentRuntimeProvider {
  run(req: AgentRunRequest, agent: ResolvedAgent): Promise<AgentRunResult>
  resume(req: AgentResumeRequest, agent: ResolvedAgent): Promise<AgentRunResult>
  health(): Promise<ProviderHealth>
}

interface ProviderHealth {
  ok: boolean
  message: string
}
```

`health()`는 얕은 readiness check다. MVP에서는 provider endpoint/IPC 응답, 필수 token/env 존재, configured runtime 이름 인식 여부만 빠르게 확인한다.

`health()`는 synthetic prompt 실행, 모델별 auth/session 보장, permission sandbox 검증, output 파일 write end-to-end 검증을 하지 않는다. 실제 실행 실패는 `run`/`resume`의 `AgentRunResult`와 Reporter event로 노출한다.

## OpenClaw 호출 방식

- HTTP/IPC (OpenClaw 로컬 게이트웨이) 사용. 인증 토큰은 `.env`에 보관
- 호출 시 전달:
  - runtime (예: `claude-cli`)
  - model
  - cwd (worktree)
  - 메시지: "Read .forgeroom/prompts/NN_<step_id>.md. Follow the instructions inside. Write your response to .forgeroom/outputs/NN_<step_id>.md."
- OpenClawProvider가 OpenClaw에 요청하고, OpenClaw가 해당 CLI를 실행해 결과 반환
- runtime은 cwd를 worktree로 받아 실행한다. 따라서 agent CLI가 cwd 기준 설정(예: repo의 AGENTS.md, 로컬 config, 프로젝트 파일)을 읽는 방식이면 해당 project 환경이 적용된다.
- CLI 실행 파일, 로그인 세션, API key, global profile 같은 runtime-level 환경은 provider가 관리한다. ForgeRoom은 이 세부사항에 직접 의존하지 않는다.

## 파일 검증

run 종료 후:
1. `outputPath` 존재 여부 확인
2. 파일 크기 ≥ `MIN_BYTES` (기본 50)
3. 미충족 시 AgentRunner가 attempt++ 후 resume continuation 또는 신규 headless run fallback을 선택
   - resume 메시지(#114, ADR-029 output-channel 보강): agent **응답**이 출력이다 — "파일 저장"이 아니라 계약-모양(plan은 `## Slices`)을 갖춘 **완전한 응답 재전송**을 요청한다. agent는 `.forgeroom/outputs/*`를 직접 쓰지 않는다(`defaultRetryPromptBody`).
4. `MAX_AGENT_ATTEMPTS` (기본 3) 초과 시 step.status=failed

## 재시도 정책

- AgentRunner는 valid step output을 만들기 위한 output-producing attempt budget 하나를 가진다. 기본값은 `MAX_AGENT_ATTEMPTS = 3`이다.
- 이 budget에는 retryable provider failure(`timeout`, `agent_error`), output 파일 미작성/너무 작은 파일, output selector 실패(`## Slices`, `Review Result`)가 모두 포함된다. Provider readiness failure(`runtime_unavailable`, `auth_failed`)는 같은 요청을 반복해도 output 생성 가능성이 없으므로 즉시 반환한다.
- provider resume은 retry 결정을 하지 않는다. AgentRunner가 sessionId 유무와 mode에 따라 provider `resume` 또는 새 `run` fallback을 호출한다.
- AgentRunner는 최초 `run`, internal retry `resume`, selector retry `resume`, session 없는 selector fallback `run` 모두에 effective `timeoutMs`를 포함해 provider로 전달한다.
- Budget 소진 시 step.status=failed로 기록하고 공통 `failureKind`를 남긴다.
- CheckRunner 자동 수정은 별도 budget이다. AgentRunner retry는 valid step output 생성까지, CheckRunner retry는 생성된 코드 변경의 품질 게이트 통과까지를 책임진다.

## Worktree 바인딩 — 태스크별 ephemeral agent (ADR-030)

OpenClaw `agent` CLI에는 `--cwd`/`--workspace`가 없어, gateway mode의 모든 run은 전역 `agents.defaults.workspace`($HOME)에서 실행된다. ForgeRoom은 태스크마다 worktree를 만들고 plan은 `.forgeroom/context/*`를 **읽고** implement는 소스를 **써야** 하므로, $HOME 기준 실행은 둘 다 실패한다(issue #111).

해결: 태스크마다 worktree에 바인딩된 ephemeral OpenClaw agent를 둔다.

- 이름은 task id에서 **결정적으로** 도출한다(`ephemeralAgentIdForTask` → `fr-<taskid>`). 재시도/resume이 전역 `main`으로 새지 않는다.
- PipelineEngine이 run 시작 전 `TaskAgentLifecycle.ensure`(idempotent create)로 agent를 worktree에 바인딩하고, terminal settle(done/failed/canceled)에서 `remove`로 삭제한다(best-effort — 삭제 실패가 task 결과를 바꾸지 않는다).
- step 실행은 **모두** 이 agent로 한다(`runtimeSession.providerAgentId = ephemeralAgentIdForTask(task.id)`). 한 agent가 `--model`로 plan(claude-cli)·implement(openai) 두 runtime을 모두 실행한다(생성 시 `--model` 불필요 — `defaults.models` 상속, 실측 확인).
- `child_process`는 `app/openclaw-ipc.ts`의 `agents add/delete` IPC에만 둔다. core는 provider-neutral `TaskAgentLifecycle` seam(`core/agent-runtime/task-agent-lifecycle.ts`)만 의존한다.
- 후속(ADR-030 deferred): boot-time orphan GC(`fr-*` ↔ nonterminal TaskStore 대조), per-role agent.

## 의존

- AgentRegistry
- AgentRuntimeProvider
- OpenClawProvider / OpenClaw IPC 클라이언트
- TaskAgentLifecycle (ADR-030, ephemeral 태스크 agent)
- 파일 시스템

## 보안

- OpenClaw 인증 토큰은 `.env`로
- agent가 worktree 외부 경로 write 시도 → WorktreeManager.revertOutside로 복원

## 관련 결정

- [ADR-003](../decisions/2026-05-21-003-agent-runner-openclaw-delegation.md)
- [ADR-012](../decisions/2026-05-22-012-agent-runtime-provider-boundary.md)
- [ADR-004](../decisions/2026-05-21-004-file-based-prompt-passing.md)
- [ADR-030](../decisions/2026-06-20-030-ephemeral-per-task-agent-workspace.md)
- [Stage 5 Agent Timeout Policy](../review-decisions/2026-05-23-stage-5-agent-timeout-policy.md)
