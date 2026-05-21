---
status: decided
last_reviewed: 2026-05-21
---

# GitHubGateway

## 책임

- 등록된 프로젝트 레포에서 Issue 라벨 polling
- 라벨 매치(예: `agent`) 시 PipelineEngine 트리거
- PR 생성·업데이트
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

## PR 생성 흐름

1. CheckRunner 통과 시 PipelineEngine이 호출
2. `git push origin <branch>`
3. Octokit `pulls.create({ title, body, head, base })`
4. body는 `templates/pr_template.md` 렌더링 결과
5. PR 번호를 task.pr_number에 저장
6. Reporter.notify('pr_created')

## 의존

- Octokit (`@octokit/rest`)
- ProjectRegistry
- TaskStore

## 에러

- API rate limit → exponential backoff, 5회 실패 시 task failed
- 권한 부족 → fatal 알림 (토큰 점검 필요)
- 네트워크 단절 → 다음 polling 주기 재시도

## 보안

- GitHub token은 `.env`로
- 토큰 스코프: `repo` (private repo 접근 가능 최소)
- 등록되지 않은 owner/repo에 대한 API 호출 차단
