---
status: decided
last_reviewed: 2026-05-21
---

# AgentRunner + OpenClawAgentRegistry

## 책임

- OpenClaw에 에이전트 호출 위임 (직접 child_process X)
- 파일 기반 IO: 입력 = `prompts/NN.md`, 출력 = `outputs/NN.md`
- headless 기본, PTY는 옵션(Forge Phase 1에서 PTY 사용 케이스는 Conductor 정도)
- output 파일 검증 + resume 재시도

## 경계

ForgeRoom은 CLI agent process를 직접 실행하지 않는다. Claude Code, Codex, Gemini CLI 같은 runtime별 실행 방식, 모델명, 인증, session/resume, PTY/headless 차이는 OpenClaw가 책임진다.

AgentRunner는 ForgeRoom의 task/step 실행 문맥을 OpenClaw 요청으로 변환하고, 반환된 실행 결과와 파일 검증 결과를 PipelineEngine에 돌려주는 adapter다.

MVP의 runtime provider는 OpenClaw 하나로 고정한다. Forge Phase 2 이후에는 OpenClaw와 Hermes 같은 다른 agent runtime gateway를 같은 interface 뒤에 붙일 수 있도록 `AgentRuntimeProvider` 추상화를 검토한다. 구현체 이름은 `OpenClawProvider`, `HermesProvider` 형태를 따른다.

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
    runtime_harness: claude
```

MVP validation은 `provider: openclaw`만 허용한다. 다른 provider 값은 Forge Phase 2의 `AgentRuntimeProvider` 도입 전까지 설정 오류로 처리한다.

`runtime_harness`는 OpenClaw/Hermes 같은 provider에 전달하는 provider-level 실행 harness다.

Step Harness는 hooks, skills, plugins, AGENTS.md/CLAUDE.md 계열 지침, prompt/output contract를 하나하나 Intent에 쓰지 않기 위한 이름붙은 preset이다. AgentRunner는 Resolved Step의 agent와 Step Harness를 합쳐 provider 요청을 구성한다.

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

MVP에서는 target project 안의 기존 harness/provider-local 설정을 자동으로 읽거나 병합하거나 덮어쓰지 않는다. ForgeRoom Step Harness는 task worktree 내부의 ForgeRoom 전용 runtime context에 배치한다. 기존 project-local harness와의 충돌·우선순위·merge 정책은 Forge Phase 2에서 정의한다.

## OpenClawAgentRegistry

```typescript
interface OpenClawAgentRegistry {
  load(): Promise<void>
  has(agentId: string): boolean         // agents.yaml의 키 → OpenClaw runtime 매핑 가능?
  resolve(agentId: string): ResolvedAgent
}

interface ResolvedAgent {
  agentId: string                       // agents.yaml의 키 (예: 'claude')
  openclaw_runtime: string              // 예: 'claude-cli', 'openai-codex'
  model: string
}
```

## AgentRunner

```typescript
interface AgentRunner {
  run(req: AgentRunRequest): Promise<AgentRunResult>
  resume(sessionId: string, addendumPromptPath: string): Promise<AgentRunResult>
}

interface AgentRunRequest {
  agentId: string                       // agents.yaml 키
  promptPath: string                    // 절대경로 (worktree 내)
  outputPath: string                    // 절대경로 (worktree 내)
  cwd: string                           // worktree
  mode: 'headless' | 'pty'
  timeoutMs?: number
}

interface AgentRunResult {
  exitCode: number
  outputExists: boolean
  outputBytes: number
  durationMs: number
  sessionId: string | null              // PTY 모드 시 후속 resume용
  stdoutPath: string
  stderrPath: string
}
```

## OpenClaw 호출 방식

- HTTP/IPC (OpenClaw 로컬 게이트웨이) 사용. 인증 토큰은 `.env`에 보관
- 호출 시 전달:
  - runtime (예: `claude-cli`)
  - model
  - cwd (worktree)
  - 메시지: "Read .forgeroom/prompts/NN_<step_id>.md. Follow the instructions inside. Write your response to .forgeroom/outputs/NN_<step_id>.md."
- OpenClaw가 해당 CLI를 실행하고 결과 반환
- runtime은 cwd를 worktree로 받아 실행한다. 따라서 agent CLI가 cwd 기준 설정(예: repo의 AGENTS.md, 로컬 config, 프로젝트 파일)을 읽는 방식이면 해당 project 환경이 적용된다.
- CLI 실행 파일, 로그인 세션, API key, global profile 같은 runtime-level 환경은 OpenClaw provider가 관리한다. ForgeRoom은 이 세부사항에 직접 의존하지 않는다.

## 파일 검증

run 종료 후:
1. `outputPath` 존재 여부 확인
2. 파일 크기 ≥ `MIN_BYTES` (기본 50)
3. 미충족 시 attempt++ 후 resume 호출 (`mode='pty'` 또는 신규 headless)
   - resume 메시지: "Your previous response was not saved to <outputPath>. Save the response to that file now."
4. `MAX_RETRY` (기본 2) 초과 시 step.status=failed

## 재시도 정책

- agent exit ≠ 0: 1회 즉시 재시도
- output 파일 미작성: 2회까지 resume
- 이상 실패 시 step failed

## 의존

- OpenClaw IPC 클라이언트
- OpenClawAgentRegistry
- 파일 시스템

## 보안

- OpenClaw 인증 토큰은 `.env`로
- agent가 worktree 외부 경로 write 시도 → WorktreeManager.revertOutside로 복원

## 관련 결정

- [ADR-003](../decisions/2026-05-21-003-agent-runner-openclaw-delegation.md)
- [ADR-004](../decisions/2026-05-21-004-file-based-prompt-passing.md)
