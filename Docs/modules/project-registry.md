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
  getRoom(projectId: string): ProjectRoom | null   // ADR-028 Phase 1.5 seam
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

// ADR-028 Phase 1.5 seam — reserved, optional, zero-migration.
interface ProjectRoom {
  project: ProjectMeta
  discord?: { channel_id?: string }
  openclaw?: { room?: string; agents?: Record<string, string> }  // role → agent id
  mastra?: { expose_operator_tools?: boolean }
}
```

### ProjectRoom view (ADR-028)

`getRoom(projectId)`는 `ProjectMeta` + 예약된 `discord`/`openclaw`/`mastra` 섹션을 묶은 read-only view를 돌려준다. 설계 경계:

- **별도 view.** room 섹션은 `ProjectMeta`에 붙이지 않는다. `get()`/`list()`는 변경 없이 순수 `ProjectMeta`만 반환한다(Discord/OpenClaw/Mastra 의존이 기존 consumer로 새지 않게).
- **예약만, 구현 아님.** 현재 파싱하는 키는 `discord.channel_id`, `openclaw.room`, `openclaw.agents`, `mastra.expose_operator_tools` 뿐이다. 섹션 안의 그 외 키(`thread_mode`, `session_strategy`, `permission_profiles`, `studio_project`, `commands.allow` 등)는 **무시**한다 — 해당 phase 전까지 계약이 되지 않도록.
- **알려진 키는 strict.** 섹션/필드는 optional이지만, 존재하면 타입이 맞아야 한다(틀리면 부팅 시 fail-fast). unknown 키는 조용히 무시.
- 기존 config는 migration 없이 동작한다(세 섹션 모두 없으면 view는 `{ project }`만).

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
- [ADR-028](../decisions/2026-05-26-028-project-room-domain-and-seam.md) — ProjectRoom 도메인 + Phase 1.5 seam (`getRoom` view)
