---
status: decided
last_reviewed: 2026-05-21
---

# ProjectRegistry

## 책임

- `configs/projects.yaml` 로드·검증
- 프로젝트 메타데이터(경로, 명령, 기본 워크플로우) 조회 API 제공
- 시작 시 등록된 프로젝트 path 존재 여부 검증

## 입력

- `configs/projects.yaml`

## 출력

- 프로그램 메모리상 `Map<projectId, ProjectMeta>`

## 인터페이스 (요지)

```typescript
interface ProjectRegistry {
  load(): Promise<void>
  get(projectId: string): ProjectMeta | null
  list(): ProjectMeta[]
  validate(meta: ProjectMeta): ValidationResult
}

interface ProjectMeta {
  id: string
  path: string                      // absolute path to repo
  default_branch: string
  package_manager: string
  default_workflow: string
  allowed_workflows: string[]
  template_dir: string | null       // null → 기본 ~/forgeroom/templates
  commands: Record<string, string>  // { test, lint, typecheck, ... }
}
```

## 의존

- yaml 파서
- 파일 시스템

## 에러

- 파일 없음 → fatal, 부팅 실패
- 프로젝트 path 미존재 → 경고 + 해당 프로젝트 비활성화
- workflow 미등록 참조 → fatal, 사용자에게 명시적 에러

## 변경 감지 (MVP)

- 시작 시 1회 로드. 핫리로드 X. 변경 후 orchestrator 재시작 필요.

## 관련 결정

- [ADR-006](../decisions/2026-05-21-006-workflow-library-model.md)
