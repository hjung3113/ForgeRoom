---
status: decided
date: 2026-05-23
---

# ADR-019: PR 생성은 PipelineEngine 소유 workflow external effect

## 배경

PR 자동 생성의 소유권이 문서 간 충돌했다 (codex grill 2026-05-23, confidence 93):

- ADR-013은 `GitHubReporterSink`가 "PR 생성과 PR comment/body 갱신"을 담당한다고 기술 ([013:23](2026-05-22-013-task-source-and-reporter-boundaries.md)).
- `Docs/modules/github-gateway.md`는 `GitHubGateway.createPR(...)`를 인터페이스로 노출.
- `Docs/modules/reporter.md`는 PR 생성을 Reporter delivery가 **아니라** workflow external effect로 규정하고, 실패 시 `failure_reason=pr_create_failed`로 task를 실패시킨다고 명시 ([reporter.md:118-119](../modules/reporter.md)).

이 충돌의 본질: **delivery(Reporter)는 best-effort·멱등·non-task-failing이지만, PR 생성은 task-critical external effect로 실패가 task를 실패시켜야 한다.** 두 책임은 retry·실패 의미가 정반대라 같은 컴포넌트가 가질 수 없다.

## 결정

PR 생성은 **PipelineEngine이 소유하는 workflow external effect**다. 작은 어댑터 `PullRequestCreator`(내부적으로 GitHub API primitive `GitHubPullRequestClient` 사용)를 통해 실행한다.

- Reporter / ReporterSink는 PR을 **생성하지 않는다**. PR comment/body/status surface 갱신만 담당하고 `pr_created` event를 소비해 보고한다.
- GitHubGateway는 polling TaskSource(`GitHubIssueTaskSource`)와 GitHub API primitive(`GitHubPullRequestClient`)를 제공하지만, PR 생성의 orchestration·retry·실패 의미는 engine/effect 계층이 소유한다.
- 본 ADR은 ADR-013의 TaskSource/Reporter 분리를 **명확화(refine)**하며 supersede하지 않는다.

## External effect 실행 계약

- **트리거**: workflow/check 성공 완료 후, task done 전. `effects.external.pr != none`일 때만.
- **retry**: 최대 3회 exponential backoff (github-gateway.md 정책과 일치).
- **멱등키**: `task.id + branch_name`.
- **discovery-before-create**: 생성 전 `task.pr_number`가 있으면 갱신/반환. 없으면 `head=<branch>` + body marker(`<!-- forgeroom:task_id=<task_id> -->`)로 열린 PR을 검색해 있으면 `pr_number`를 영속하고 반환. push/create timeout 후 응답이 모호하면 재시도는 blind create가 아니라 discovery로 시작한다.
- **성공**: `task.pr_number` 영속 → `pr_created` event emit → Reporter가 best-effort로 status/PR comment 갱신.
- **최종 실패**: `task.status=failed`, `failure_reason=pr_create_failed`. Reporter 알림은 그래도 best-effort.

## 결과 (영향 문서)

- ADR-013: `GitHubReporterSink` 책임을 "PR comment/body/status 갱신만"으로 수정 (PR 생성 제거).
- `Docs/modules/reporter.md`: PR 생성이 Reporter 책임이 아님을 유지·명시 (이미 118-119에 규정).
- `Docs/modules/github-gateway.md`: 책임 분리 — `GitHubIssueTaskSource`(polling) vs `GitHubPullRequestClient`(API primitive). `createPR`의 orchestration 소유자는 PipelineEngine.
- `Docs/modules/pipeline-engine.md`: workflow/check 성공 후 task done 전 단계로 external-effect phase 추가. PR effect 실패는 task 실패.

## 관련

- ADR-013 TaskSource/Reporter 경계 (명확화 대상, supersede 아님)
- ADR-015 PipelineEngine = Mastra runner (effect는 run lifecycle 내)
- ADR-016 step body 시퀀스 (external effect는 workflow 종료 후 phase)
