---
status: decided
last_reviewed: 2026-05-21
---

# 테스트 룰

## 원칙

프래그매틱. 단위 테스트는 필수, 통합 테스트는 주요 흐름만, e2e는 MVP 검증용.

## 단위 테스트 (필수)

- 모든 모듈의 핵심 함수·메서드는 단위 테스트 보유
- 외부 의존성(파일 시스템, git, OpenClaw, Discord, GitHub)은 mock
- 한 테스트 = 한 동작 검증
- 빠르게 (1 파일 ≤ 1초 권장)

### Mock 정책

- TaskStore: in-memory SQLite (`:memory:`)
- 파일 시스템: 임시 디렉토리 (`os.tmpdir()`)
- OpenClaw IPC: 인터페이스 기반 fake 구현
- Discord/Octokit: nock 또는 인터페이스 mock
- Conductor: 인터페이스 fake (실제 LLM 호출 X)

### 도구

- 러너: vitest
- assert: vitest 내장 (`expect(...).toBe`)
- snapshot: 워크플로우 파싱 결과 같은 구조 검증에 한해 사용

## 통합 테스트 (주요 흐름)

- 여러 모듈 조합 검증 (예: PipelineEngine + TaskStore + WorktreeManager 실제 git)
- 외부 API는 mock 유지
- 실제 SQLite 파일 사용 가능 (임시 경로)
- 한 테스트당 ≤ 5초

대상 흐름:
- 워크플로우 끝까지 실행 (mock agent로)
- pause/resume
- 재시작 후 회복
- check 실패 → 재시도 → 성공
- check 실패 → 재시도 → 실패 → task failed

## E2E 테스트 (MVP 검증)

- 실제 OpenClaw + 실제 git + 실제 Discord(테스트 채널)/GitHub(테스트 레포)
- 수동 또는 별도 `npm run test:e2e`
- CI에 포함하지 않음 (비용·플레이크)
- MVP 완료 정의 ([phase-1-mvp.md](../phases/phase-1-mvp.md#완료-정의)) 항목과 1:1 매핑

## TDD 운영

엄격한 red-green-refactor 강제는 아니지만 권장:

1. 인터페이스·시그니처 결정 후
2. 핵심 동작 1-2개 테스트 작성
3. 구현
4. 테스트 통과 확인
5. 리팩터링

복잡한 모듈(PipelineEngine, Conductor, WorkflowRegistry)은 테스트 먼저 권장.

## 테스트 파일 배치

- 단위 테스트: 소스 옆 (`src/core/pipeline-engine.ts` ↔ `src/core/pipeline-engine.test.ts`)
- 통합 테스트: `tests/integration/`
- E2E: `tests/e2e/`

## 커버리지

- MVP: 목표치 강제 X
- 핵심 모듈(TaskStore, PipelineEngine, AgentRunner, Conductor, WorkflowRegistry)은 자체 단위 테스트로 핵심 분기 커버
- Phase 2: 측정 도입

## Husky pre-commit

다음 통과 필수:
1. `eslint`
2. `tsc --noEmit`
3. `vitest run --reporter=dot` (단위 + 빠른 통합)

E2E는 pre-commit 제외.

## 테스트 명명

```typescript
describe('PipelineEngine', () => {
  describe('runFull', () => {
    it('creates task with workflow id', async () => { ... })
    it('throws if project not registered', async () => { ... })
    it('respects agent overrides', async () => { ... })
  })
})
```

- `describe`: 모듈명 / 메서드명
- `it`: "<무엇을 한다>" 또는 "<상황에서 어떻게 동작>"
- 부정 케이스: "throws if ...", "fails when ..."
