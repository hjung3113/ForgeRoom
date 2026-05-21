---
status: decided
last_reviewed: 2026-05-21
---

# AgentRunner + OpenClawAgentRegistry

## 책임

- OpenClaw에 에이전트 호출 위임 (직접 child_process X)
- 파일 기반 IO: 입력 = `prompts/NN.md`, 출력 = `outputs/NN.md`
- headless 기본, PTY는 옵션(Phase 1에서 PTY 사용 케이스는 Conductor 정도)
- output 파일 검증 + resume 재시도

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
