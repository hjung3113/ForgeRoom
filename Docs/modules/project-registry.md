---
status: decided
last_reviewed: 2026-05-21
---

# ProjectRegistry

## 책임

- `configs/projects.yaml` 로드·검증
- 프로젝트 메타데이터(경로, 명령, 기본 워크플로우) 조회 API 제공
- 시작 시 등록된 프로젝트 path 존재 여부 검증
- 프로젝트별 사용 가능한 custom workflow 목록과 default workflow 검증

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
  template_dir: string | null       // MVP에서는 보존만 하고 prompt_template 해석에 사용하지 않음
  commands: Record<string, string>  // { test, lint, typecheck, ... }
  maintainers: ProjectMaintainers
}

interface ProjectMaintainers {
  discord_user_ids: string[]
  github_logins: string[]
}
```

`maintainers`는 project-scoped allowlist다. Discord/GitHub Gateway는 dirty baseline approval 같은 project 상태 전환 승인 시 source identity를 `ProjectMeta.maintainers`와 대조한다.

`maintainers`가 비어 있으면 Discord dirty baseline approval은 불가하다. GitHub는 repo write/maintain/admin collaborator 권한 확인이 가능할 때만 approval fallback을 허용한다.

## 의존

- yaml 파서
- 파일 시스템

## 에러

- 파일 없음 → fatal, 부팅 실패
- 프로젝트 path 미존재 → 경고 + 해당 프로젝트 비활성화
- workflow 미등록 참조 → fatal, 사용자에게 명시적 에러
- default_workflow가 allowed_workflows에 없으면 fatal

`default_workflow`는 자동 선택용 기본값일 뿐이다. ForgeRoom의 기본 제공 workflow는 체험용 기준선이며, 프로젝트 운영은 `allowed_workflows`에 등록한 custom workflow 선택을 전제로 한다. Custom workflow도 WorkflowRegistry 검증을 통과해야 하며, 실행 환경은 등록된 Intent/Agent/Step Harness만 참조할 수 있다.

MVP에서 `template_dir`은 설정 필드로만 보존하고 prompt template lookup에는 사용하지 않는다. `prompt_template`은 bundled template root 아래 파일만 참조할 수 있으며, 프로젝트별 template root override는 Forge Phase 2에서 실제 활용한다.

## 변경 감지 (MVP)

- 시작 시 1회 로드. 핫리로드 X. 변경 후 orchestrator 재시작 필요.

## 관련 결정

- [ADR-006](../decisions/2026-05-21-006-workflow-library-model.md)
