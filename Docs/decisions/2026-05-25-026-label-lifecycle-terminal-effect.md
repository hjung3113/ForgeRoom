---
status: decided
date: 2026-05-25
issue: "#64"
---

# ADR-026: GitHub 이슈 라벨-라이프사이클을 terminal side-effect로 연결

## 배경

ForgeRoom은 `GitHubIssueTaskSource`의 `ready-for-agent` 라벨 폴링으로 이슈를 잡아
`source = 'github-issue-label'` task를 만들고 triggering `issue_number`를 기록한다.
task가 terminal 상태(`done` / `failed`)에 도달해도 원본 이슈 라벨은 계속
`ready-for-agent`로 남아 — 이슈 트래커가 task 결과를 잘못 표시한다.

라벨을 바꾸는 `GitHubIssueLabelClient` seam은 `gateway/github/`에 이미 있지만
연결돼 있지 않았다. 이 ADR은 라벨 전환을 terminal side-effect로 연결하는 방법을 결정한다.

## 결정

`core/effects/`에 `IssueLabelLifecycleEffect`를 추가한다. task의 terminal 상태가
저장된 **직후** 다음 triage 라벨 전환을 적용한다:

| terminal 상태 | remove          | add              |
|--------------|-----------------|------------------|
| `done`       | `ready-for-agent` | `ready-for-human` |
| `failed`     | `ready-for-agent` | `needs-info`      |

`PipelineEngine.settle()`에서 `done`/`failed` 각 종료 지점의 `updateTaskStatus(...)`
직후에 호출한다. `paused`/`canceled`는 비종료 상태라 라벨 전환을 트리거하지 않는다.

**가정 (flagged):** in-flight agent task는 `ready-for-agent` 라벨을 보유한다고 가정한다
(`GitHubIssueTaskSource`가 이슈를 집을 때 설정). effect는 이 라벨을 무조건 remove한다.
이미 없으면(예: 수동 제거) GitHub가 404를 반환하며, 실패 격리 wrapper가 조용히 삼킨다.

### side-effect 전용 — task 상태를 절대 소유하지 않음

라벨 전환은 best-effort 외부 주석이다. 다음을 해서는 안 된다:
- 이미 settle된 task 상태를 뒤집기
- 자신의 에러를 `settle()` 호출부로 전파

`IssueLabelLifecycleEffect.apply()`는 모든 port 에러를 내부에서 catch + log하고
항상 resolve한다. 라벨 실패에는 failure code를 부여하지 않는다 — non-fatal로 로깅한다.
ADR-013의 "status surface 전달 실패가 task를 실패시키지 않는다" 원칙과 일관된다.

### 이슈-트리거가 아니면 no-op

`task.source !== 'github-issue-label'`이거나 `task.issue_number === null`인 경우
(Discord-command task, 또는 번호가 기록되지 않은 이슈-트리거 task) `apply()`는 no-op이다.

### 주입형 `IssueLabelPort` seam — core는 gateway-free 유지

`core/effects/issue-label-lifecycle.ts`는 좁은 `IssueLabelPort` 인터페이스에 의존한다:

```ts
interface IssueLabelPort {
  addLabel(args: AddLabelArgs): Promise<void>;
  removeLabel(args: RemoveLabelArgs): Promise<void>;
}
```

`gateway/github/issue-label-client.ts`의 `GitHubIssueLabelClient`가 이 인터페이스를
구조적으로 만족한다. 구체 adapter는 `app/composition-root.ts`의 `buildLabelEffect()`에서
연결하며, 기존 `buildPullRequestEffect()` 패턴을 따른다. core는 `GitHubIssueLabelClient`를
직접 import하지 않는다.

### triage 라벨 상수

`apps/orchestrator/src/gateway/github/triage-labels.ts`가 `docs/agents/triage-labels.md`에
정의된 5개 canonical triage 라벨 문자열의 단일 출처(single source of truth)다.
effect 자체는 core→gateway import를 피하려고 상수와 일치하는 string literal을 사용하며,
상수는 composition-root 경계에서 사용 가능하다.

### composition-root 연결

`composition-root.ts`의 `buildLabelEffect()`:
1. GitHub 자격증명이 없으면 skip (`null` effect 반환).
2. `GitHubIssueLabelClient(octokit)`를 `IssueLabelPort` 구현으로 생성.
3. `IssueLabelLifecycleEffect({ port, log })` 생성.
4. `labelTargetFor` resolver 반환 (`prTargetFor`와 동일 패턴).
5. `labelEffect`/`labelTargetFor`를 `PipelineEngineDeps`에 주입 (둘 다 optional — GitHub
   미설정 시 부재).

## 결과

- `PipelineEngineDeps`에 optional 필드 2개 추가: `labelEffect`, `labelTargetFor`.
  기존 테스트는 변경 불필요.
- 라벨 port 실패가 task terminal 결과에 영향을 주지 않음 (ADR-013의 "status surface 전달
  실패가 task를 실패시키지 않는다" 원칙과 일관).
- composition-root는 GitHub 설정 시 PR effect와 라벨 effect가 공유하는
  `GitHubIssueLabelClient` 하나를 생성.
- 향후: 라벨 전환에 retry/idempotency가 필요하면 `GitHubIssueLabelClient`가 아니라
  `IssueLabelLifecycleEffect` 내부에 추가 (`GitHubIssueLabelClient`의 no-retry-in-client
  규칙과 일관).

## 관련

- ADR-013: TaskSource / Reporter 경계 (task 상태 소유권)
- ADR-019: PR 생성 terminal external effect (여기서 패턴 mirror)
- `docs/agents/triage-labels.md`: canonical triage 라벨 문자열
- Issue #64
