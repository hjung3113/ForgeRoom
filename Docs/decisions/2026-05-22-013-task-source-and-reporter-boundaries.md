---
status: decided
date: 2026-05-22
---

# ADR-013: TaskSource와 Reporter 경계를 분리

## 배경

MVP의 사용자 경로는 Discord 명령과 GitHub Issue/PR이다. 사내 환경에서는 Discord가 불가하고, GitHub Enterprise 또는 git issue가 GitHub.com Issue와 동일하게 동작한다고 가정할 수 없다.

사내 환경 지원은 MVP 범위가 아니다. 하지만 Task 모델과 PipelineEngine이 Discord/GitHub 구현체에 직접 결합되면 Forge Phase 2에서 Local CLI, GitHub Enterprise, 사내 ticket source를 추가할 때 실행 코어를 변경해야 한다.

## 결정

MVP에 `TaskSource`와 `ReporterSink` 경계를 둔다.

MVP 구현체:

- `DiscordTaskSource`: Discord slash command를 `TaskRequest`로 변환
- `GitHubIssueTaskSource`: GitHub.com Issue label polling을 `TaskRequest`로 변환
- `DiscordReporterSink`: task/step 알림 전송
- `GitHubReporterSink`: PR comment/body/status surface 갱신만 (PR **생성**은 PipelineEngine external effect — [ADR-019](2026-05-23-019-pr-creation-external-effect.md) 참조)

MVP dirty baseline approval은 task source의 원 채널에서 받는다. Discord task는 원 slash command thread/channel, GitHub task는 원 Issue comment 또는 approval label을 사용한다. 승인 event는 TaskStore events에 기록한다.

DiscordReporterSink와 GitHubReporterSink는 task별 status surface 하나를 생성/갱신해 step별 진행 상황을 보고한다. Discord는 status message edit가 불가능하면 follow-up message로 fallback한다. GitHub는 Issue 기반 task에서 pinned status comment를 사용하고, PR 생성 후에는 PR body/comment에도 최종 summary를 반영한다.

Provider status surface ids는 이 ADR의 운영 세부사항이며 `tasks.external_ref`에 저장한다. `external_ref`를 정규화된 first-class reporting surface table로 분리할 때는 별도 data-model ADR을 작성한다.

Forge Phase 2 후보:

- `LocalCliTaskSource`
- `GitHubEnterpriseTaskSource`
- `GitIssueTaskSource`
- 사내 chat/ticket source
- local markdown 또는 사내 알림 reporter sink

## 이유

- MVP 경로는 Discord/GitHub로 유지한다.
- Task는 Issue 자체가 아니라 ForgeRoom runtime entity라는 기존 용어 결정을 지킨다.
- PipelineEngine은 task 실행만 알고, task가 어디서 왔는지와 결과가 어디로 보고되는지는 모르게 한다.
- 사내 환경은 Phase 2로 미루되 필요한 extension point는 MVP부터 안정화한다.

## 결과

- `tasks.source`는 provider-specific 문자열이 아니라 `TaskSourceKind`로 저장한다.
- 외부 작업 항목은 `issue_number` 단일 필드가 아니라 nullable `external_ref`로 확장 가능한 형태를 따른다.
- Reporter는 event를 생성하고, sink들이 destination별 delivery를 담당한다.
- `events`는 task history로 유지하고, external delivery retry/outbox 상태는 `event_deliveries`로 분리한다.
- Workflow의 `effects.external.report`는 `none | status | final`, `effects.external.pr`은 `none | draft | ready`로 선언한다.
- Status surface delivery 실패는 task를 실패시키지 않는다. PR 생성 실패는 workflow external effect 실패이므로 `failure_reason=pr_create_failed`로 task failed 처리한다.
- MVP status surface delivery destination은 TaskSource를 따른다. Discord command task는 Discord, GitHub Issue label task는 GitHub에 보고하며 cross-posting은 Forge Phase 2로 둔다.
- GitHub Enterprise compatibility 검증은 Forge Phase 2로 미룬다.
