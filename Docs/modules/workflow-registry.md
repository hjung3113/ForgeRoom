---
status: decided
last_reviewed: 2026-05-21
---

# WorkflowRegistry

## 책임

- `configs/workflows.yaml` 로드·파싱
- 워크플로우 이름으로 step 그래프 조회
- DSL 문법 정적 검증 (변수 참조, foreach/until 구조)

## 입력

- `configs/workflows.yaml`

## 출력

- `Map<workflowId, ParsedWorkflow>` (메모리)

## 인터페이스

```typescript
interface WorkflowRegistry {
  load(): Promise<void>
  get(workflowId: string): ParsedWorkflow | null
  list(): ParsedWorkflow[]
  validate(workflow: RawWorkflow): ValidationResult
}

interface ParsedWorkflow {
  id: string
  description: string
  steps: ParsedStep[]
}

interface ParsedStep {
  id: string
  agent: string                       // agents.yaml의 key
  prompt_template: string | null
  prompt: string | null
  input_refs: Record<string, string>  // 변수 참조 매핑
  vars: Record<string, string>
  foreach: ForeachSpec | null
  until: string | null                // bool-expr
  max_iterations: number | null
  pause_after: boolean
}
```

## 의존

- yaml 파서
- [Workflow DSL 스펙](../concepts/workflow-dsl.md)

## 검증 항목 (load 시)

1. 모든 step에 `id` 존재, 중복 없음
2. 참조된 agent가 `agents.yaml`에 등록
3. `${...}` 표현식이 알려진 step id/필드만 참조
4. `foreach`는 `as` + `steps`와 함께
5. `until` 있는 step은 `max_iterations` 필수
6. `prompt_template`/`prompt` 중 하나만 존재

## 에러

- 파싱 실패 → fatal
- 검증 실패 → 사용자에게 라인/필드 명시한 에러 메시지

## 관련 결정

- [ADR-006](../decisions/2026-05-21-006-workflow-library-model.md)
