---
status: decided
last_reviewed: 2026-05-21
---

# GitHubGateway

## 책임

- MVP GitHub.com Issue label TaskSource (`GitHubIssueTaskSource`)
- 등록된 프로젝트 레포에서 Issue 라벨 polling
- 라벨 매치(예: `agent`) 시 TaskRequest 생성
- GitHub API primitive 제공 (`GitHubPullRequestClient`: `createPR`/`updatePR`). **PR 생성의 orchestration·retry·실패 의미는 PipelineEngine external effect가 소유**한다 ([ADR-019](../decisions/2026-05-23-019-pr-creation-external-effect.md)). 이 모듈은 API 호출 primitive만 노출.
- inbound webhook 없음 (outbound only)

## 인터페이스

```typescript
interface GitHubGateway {
  start(): Promise<void>
  stop(): Promise<void>
  createPR(task: Task, branch: string, body: string): Promise<PRRef>
  updatePR(prNumber: number, body: string): Promise<void>
}

interface PRRef {
  number: number
  url: string
}
```

## Polling 정책

- 주기: 60초 (설정 가능)
- 프로젝트별로 마지막 처리한 issue 번호 캐시 (`data/github_state.json`)
- 새 issue 또는 라벨 추가 이벤트 감지 시 트리거

## 트리거 라벨

- 기본 매칭 라벨: `agent`
- `projects.yaml`에 프로젝트별 라벨 오버라이드 가능

## Approval events

- dirty baseline approval은 원 GitHub Issue에서 comment 또는 approval label로 받는다.
- 승인 event는 TaskStore events에 기록하고 Reporter가 같은 Issue/PR thread에 결과를 알린다.
- 승인자는 issue author가 project maintainer allowlist에 있거나, repo write/maintain/admin collaborator여야 한다. 권한 없는 approval은 거부하고 Reporter가 같은 thread에 알린다.

## PR 생성 흐름

1. CheckRunner 통과 시 PipelineEngine이 호출
2. `git push origin <branch>`
3. Octokit `pulls.create({ title, body, head, base })`
4. body는 `templates/pr_template.md` 렌더링 결과
5. PR 번호를 task.pr_number에 저장
6. Reporter.notify('pr_created')

## Status reporting

- GitHub Issue task는 `task_started` 때 원 Issue에 status comment 하나를 생성한다.
- `step_done`, `check_result`, `task_failed`, `pr_created`는 같은 status comment body를 갱신한다.
- PR 생성 후에는 PR body/comment에도 최종 summary를 반영한다.
- step마다 새 comment를 만들지 않는다.
- Status comment body에는 HTML marker를 넣는다: `<!-- forgeroom:status task_id=<task_id> -->`
- 생성한 comment id는 `task.external_ref.status_comment_id`에 저장한다.
- 갱신 시 comment id가 있으면 직접 update한다. comment id가 없거나 404이면 marker로 Issue comments를 검색해 복구하고, 그래도 없으면 새 status comment를 생성한다.

## 의존

- Octokit (`@octokit/rest`)
- ProjectRegistry
- TaskStore

## 에러

- PR 생성 API 오류 → exponential backoff 3회, 모두 실패 시 `failure_reason=pr_create_failed`로 task failed
- Status comment update API 오류 → ReporterSink delivery 실패로 취급한다. event_delivery row는 undelivered 상태로 남기고 task 진행은 계속한다.
- 권한 부족 → fatal 알림 (토큰 점검 필요)
- 네트워크 단절 → 다음 polling 주기 재시도

## 보안

- GitHub token은 `.env`로
- 토큰 스코프: `repo` (private repo 접근 가능 최소)
- 등록되지 않은 owner/repo에 대한 API 호출 차단

## Phase 2 확장

GitHub Enterprise compatibility, git issue, 사내 ticket 연동은 별도 TaskSource 구현체로 추가한다. MVP GitHubGateway는 GitHub.com API 동작만 검증한다.
