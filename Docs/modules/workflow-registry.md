---
status: decided
last_reviewed: 2026-05-21
---

# WorkflowRegistry

## 책임

- `configs/workflows.yaml` 로드·파싱
- 워크플로우 이름으로 step 그래프 조회
- DSL 문법 정적 검증 (변수 참조, foreach/review_loop 구조)
- step의 intent 참조 검증
- custom workflow가 registry에 등록된 Intent만 참조하도록 검증

## 입력

- `configs/workflows.yaml`
- `configs/intents.yaml` (참조 검증)

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
  effects: WorkflowEffects
  steps: ParsedStep[]
}

interface WorkflowEffects {
  worktree: 'read_only' | 'modifies'
  external: WorkflowExternalEffects
}

interface WorkflowExternalEffects {
  report: 'none' | 'status' | 'final'
  pr: 'none' | 'draft' | 'ready'
}

interface ParsedStep {
  type: 'run' | 'group' | 'review_loop'
  id: string
  intent: string | null               // executable step만 intents.yaml의 key
  prompt_template: string | null
  input_refs: Record<string, string>  // 변수 참조 매핑
  vars: Record<string, string>
  foreach: ForeachSpec | null
  review: ParsedExecutableStep | null
  refine: ParsedExecutableStep | null
  until: string | null                // review_loop 전용 bool-expr
  max_iterations: number | null
  pause_after: boolean
}

interface ParsedExecutableStep {
  id: string
  intent: string
  prompt_template: string
  input_refs: Record<string, string>
  vars: Record<string, string>
}

interface ResolvedStep extends ParsedStep {
  intent: string
  prompt_template: string
  kind: string
  agent: string                       // agents.yaml의 key
  harness: string                     // harnesses.yaml의 key
}
```

## 의존

- yaml 파서
- [Workflow DSL 스펙](../concepts/workflow-dsl.md)

## 검증 항목 (load 시)

- workflow는 `effects.worktree`, `effects.external.report`, `effects.external.pr`을 반드시 선언해야 한다.
- `effects.external.report`는 `none | status | final`, `effects.external.pr`은 `none | draft | ready` 값만 허용한다.
- pending rebuild 정책은 `effects.worktree`가 `modifies`인 workflow에 적용한다. `read_only` workflow만 warning artifact를 남기고 stale context에서 진행할 수 있다.

1. 모든 step에 `id` 존재, 중복 없음
2. executable step의 intent가 `intents.yaml`에 등록
3. `${...}` 표현식이 알려진 step id/필드만 참조
4. `type`은 `run`, `group`, `review_loop`
5. `type: group`은 `foreach` + `as` + `steps`와 함께 쓰고 `intent`, `prompt_template`, `prompt` 금지
6. `type: run`, `review_loop.review`, `review_loop.refine`은 `prompt_template` 필수
7. `type: review_loop`은 `review`, `refine`, `until`, `max_iterations` 필수
8. `type: review_loop`의 `until`은 `${<review.id>.passed}` 형식만 허용
9. `type: review_loop`의 `review`가 참조하는 Intent는 `kind: review`여야 함
10. `type: review_loop`의 `refine`이 참조하는 Intent는 registry에 등록되어야 함
11. 모든 executable step은 `intent`를 통해서만 `kind`, `agent`, `harness`를 얻음
12. workflow step에 `kind`, `agent`, `harness` 직접 지정 금지 (Forge Phase 2 override 후보)
13. executable step에 inline `prompt` 직접 지정 금지 (Forge Phase 2 후보)
14. `prompt_template`은 bundled template root 아래 상대 경로만 허용. 절대경로, `..`, root 밖 symlink escape 금지
15. 참조한 `prompt_template` 파일이 없으면 validation 실패
16. slice 구현 Step Group의 `foreach`는 MVP에서 `${task.final_slices}` 형식만 허용

## 에러

- `configs/workflows.yaml` 파싱 실패 → fatal
- 프로젝트의 `default_workflow` 또는 `allowed_workflows`가 참조하는 workflow가 없거나 validation 실패 → orchestrator startup 실패
- 참조되지 않은 workflow library 항목의 validation 실패 → 해당 workflow를 disabled로 표시하고 startup은 계속 진행
- 검증 실패 메시지는 workflow id, 라인, 필드를 포함해야 함

## 관련 결정

- [ADR-006](../decisions/2026-05-21-006-workflow-library-model.md)
