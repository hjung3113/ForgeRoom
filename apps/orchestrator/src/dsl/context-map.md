---
status: living
last_reviewed: 2026-05-21
---

# dsl/ Context Map

## 책임

워크플로우 yaml DSL 처리. 파싱, 검증, 변수 보간, foreach/until 평가.

## 주요 파일 (예정)

| 파일 | 역할 |
|---|---|
| `workflow-parser.ts` | yaml → ParsedWorkflow + 정적 검증 |
| `variable-interpolator.ts` | `${task.*}`, `${<step>.*}`, `${vars.*}` 치환 |
| `foreach.ts` | foreach 평가 + list 추출 (마크다운 목록 등) |
| `until.ts` | until 조건 평가 (bool-expr) |
| `dsl-errors.ts` | WorkflowParseError, InterpolationError 등 |
| `types.ts` | ParsedWorkflow, ParsedStep, ForeachSpec 등 |

## 같이 읽을 문서

- [Workflow DSL 개념](../../../../Docs/concepts/workflow-dsl.md) ← **필수**
- [WorkflowRegistry 모듈](../../../../Docs/modules/workflow-registry.md)
- [PipelineEngine 모듈](../../../../Docs/modules/pipeline-engine.md) (dsl의 소비자)

## 의존

- 외부: `yaml` (eemeli/yaml)
- 내부: 없음 (가능한 한 독립)

## 진입 가이드

1. [Docs/concepts/workflow-dsl.md](../../../../Docs/concepts/workflow-dsl.md) 정독
2. `types.ts` 작성으로 시작 (ParsedWorkflow / ParsedStep)
3. parser 단위 테스트 다수 작성 (예시 yaml → 기대 객체)
4. interpolator는 변수 종류별 케이스 모두 테스트
