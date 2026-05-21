---
status: decided
last_reviewed: 2026-05-21
---

# 코딩 룰

핵심 원칙 + ForgeRoom 특화 최소 규칙. ESLint/Prettier가 자동 처리하는 항목은 여기서 다루지 않음.

## 핵심 원칙

1. **DRY·YAGNI**: 추측에 기반한 추상화 금지. 3번 반복되면 추출. 미래용 옵션·플래그 안 만듦.
2. **단일 책임**: 한 파일·한 함수·한 클래스는 한 가지 일.
3. **명시적 인터페이스**: 모듈 경계의 타입은 모두 export 가능한 interface로 선언.
4. **fail-fast**: 잘못된 상태는 빨리 던짐. silent fallback 금지.
5. **트러스트 경계만 검증**: 시스템 입구(외부 API, yaml, Discord 명령)만 sanitize. 내부 호출은 타입 신뢰.

## ForgeRoom 특화

### 파일 크기

- 1 파일 ≤ 400줄 권장, 500줄 이상이면 분할 검토
- 함수 ≤ 60줄 권장. 60줄 넘어가면 추출

### 주석

기본: **주석 없음**. 식별자 이름이 곧 설명.

주석 쓸 때만 쓰는 경우:
- 비자명한 WHY (제약, invariant, 우회 사유)
- 외부 API 동작 명세 링크
- 임시 우회 + 제거 조건 명시

쓰지 말 것:
- WHAT 설명 (코드를 다시 풀어쓰기)
- 작업·이슈·PR 참조 ("for #123", "added in PR 42")
- multi-paragraph docstring (1줄 max)

### 에러 처리

- 사용자/외부 호출 경로: 명시적 try/catch + Reporter 알림 또는 정의된 에러 타입 throw
- 내부 호출: throw 자유. 호출자가 처리 의무
- 절대 빈 catch 금지. 의도된 무시는 `catch (e) { /* reason */ }` 주석 필수
- 에러는 정의된 클래스 (`OrchestratorError`, `AgentError`, `WorkflowError`, `CheckFailedError` 등). string throw 금지

### 비동기

- async/await 일관 사용. Promise.then 체이닝 금지
- 다중 비동기는 `Promise.all` 또는 `Promise.allSettled`
- 무한 polling은 cancellation token 또는 AbortController 통해 종료 가능
- 타이머/setInterval은 unref 또는 명시적 cleanup

### 의존성 주입

- 모듈은 생성자에서 의존성을 받음. global·singleton 금지
- 테스트 가능성 우선

```typescript
// good
class PipelineEngine {
  constructor(
    private readonly taskStore: TaskStore,
    private readonly agentRunner: AgentRunner,
    private readonly conductor: Conductor,
  ) {}
}

// bad
class PipelineEngine {
  private taskStore = globalTaskStore        // 금지
}
```

### Import 순서

ESLint 자동 정렬. 수동 규칙:
1. Node builtin (`fs`, `path` 등)
2. 외부 패키지
3. 절대경로 alias (`@/core/...`)
4. 상대경로

### 로깅

- `console.log` 금지. 정의된 logger 사용
- JSON 한 줄 로그. 필드: `ts, level, module, task_id?, step_id?, message, extra`
- 시크릿 패턴 자동 마스킹 (logger 레이어에서)

## 도구 설정 (참고)

- ESLint: typescript-eslint + 핵심 룰 (no-unused-vars, no-floating-promises, no-misused-promises)
- Prettier: 기본값 + line width 100
- Husky: pre-commit lint + typecheck + 단위 테스트
- TypeScript: `strict: true`, `noUnusedLocals: true`, `noUnusedParameters: true`, `noImplicitOverride: true`

## 관련 룰

- [naming-rules.md](naming-rules.md)
- [testing-rules.md](testing-rules.md)
