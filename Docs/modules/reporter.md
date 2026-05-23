---
status: decided
last_reviewed: 2026-05-21
---

# Reporter

## 책임

- ReporterEvent 생성과 delivery 멱등성 보장
- ReporterSink를 통한 단계별 Discord 알림 발송 (plan_done, code_done, check_result, pr_created, failure)
- ReporterSink를 통한 GitHub PR 본문/코멘트 생성
- 멱등성 보장 (`events` 테이블)

## 인터페이스

```typescript
interface Reporter {
  notify(event: ReporterEvent): Promise<void>
  flushUndelivered(): Promise<void>     // 재시작 시 호출
}

// PipelineEngine은 Reporter facade(notify)만 소비한다. 과거 pipeline-engine.ts에
// 있던 별도 `ReporterSink {notify}` seam은 제거되고 이 Reporter로 통합되었다 (#25).

interface ReporterSink {
  destination: 'discord' | 'github'
  // 한 번의 delivery 시도. surface는 현재 task의 status surface id (최초엔 null);
  // 있으면 edit, 없으면 새로 만들고 새 id를 outcome.surface로 돌려준다 (멱등성).
  deliver(request: { event: ReporterEvent; surface: StatusSurfaceRef | null }):
    Promise<{ surface: StatusSurfaceRef | null }>
}

interface StatusSurfaceRef { id: string }   // Discord message id 또는 GitHub comment id

type ReporterEvent =
  | { type: 'task_started', task: Task }
  | { type: 'step_done', task: Task, step: Step }
  | { type: 'check_result', task: Task, results: CheckResult[] }
  | { type: 'user_feedback', task: Task, message: string }
  | { type: 'feedback_integrated', task: Task, feedbackPath: string }
  | { type: 'feedback_integration_failed', task: Task, failure_reason: string }
  | { type: 'context_stale_blocked', task: Task, dirtyFiles: string[] }
  | { type: 'dirty_baseline_approved', task: Task, approvedBy: string }
  | { type: 'pr_created', task: Task, pr_number: number, pr_url: string }
  | { type: 'task_failed', task: Task, failure_reason: string }
  | { type: 'ask_response', task: Task, question: string, answer: string }
```

## 멱등성 알고리즘

1. `TaskStore.enqueueEvent(payload)` → domain event row 생성
2. `effects.external.report`와 TaskSource destination 규칙에 따라 필요한 `event_deliveries` outbox row 생성
3. Discord/GitHub API 호출
4. 성공 → `TaskStore.markDeliveryDelivered(deliveryId)`
5. 실패 → delivery row의 `delivery_attempts++`, `last_delivery_error` 기록, exponential backoff (1s, 2s, 4s, 8s, 최대 5회)로 `next_delivery_at` 갱신
6. 재시작 시 `flushUndelivered()` 호출, `event_deliveries.delivered_at IS NULL`이고 `next_delivery_at <= now`인 delivery 재발송

## 알림 수준 (MVP)

주요 단계만:
- task 시작
- 각 step 완료 (output_path 링크 포함)
- 사용자 피드백 접수
- 피드백 통합 완료 또는 실패
- dirty baseline block/approval
- check 결과 요약
- PR 생성 (URL 포함)
- 실패 (원인 + 진단 링크)

raw stdout 스트리밍은 Forge Phase 2.

DiscordReporterSink도 task status message 하나를 갱신하는 방식을 기본으로 한다. `external_ref.status_message_id`로 message를 edit하고, edit가 불가능하거나 메시지가 만료되면 follow-up message로 fallback한 뒤 id를 갱신한다.

GitHubReporterSink는 Issue 기반 task에서 pinned status comment 하나를 생성/갱신해 step별 진행 상황을 보고한다. PR 생성 후에는 PR body/comment에도 최종 summary를 반영한다. Status comment는 HTML marker와 `external_ref.status_comment_id`를 함께 사용해 식별하며, id가 없거나 stale하면 marker search로 복구한다.

Reporter는 workflow의 `effects.external.report`를 따른다:

- `none`: external status surface를 만들거나 갱신하지 않는다. 로컬 events/logs는 계속 기록한다.
- `status`: task 시작부터 종료까지 Discord status message 또는 GitHub status comment를 갱신한다.
- `final`: task 종료 시 최종 summary만 external status surface에 반영한다.

PR 생성은 `effects.external.pr`을 따른다. `none`이면 PR을 만들지 않고, `draft`면 draft PR, `ready`면 ready PR을 생성한다. `pr`은 `report`를 대체하지 않으므로, PR을 만들면서 status surface를 갱신하려면 `report: status` 또는 `report: final`도 선언해야 한다.

`effects.external.report`는 task status surface 정책만 제어한다. Command acknowledgement, 권한 없는 approval 거부, dirty baseline block처럼 사용자의 즉시 액션에 대한 응답은 status surface 갱신이 아니므로 `report: none`이어도 원 채널에 직접 응답할 수 있다.

Delivery destination은 TaskSource를 기준으로 선택한다. Discord command task는 Discord delivery row를 만들고, GitHub Issue label task는 GitHub delivery row를 만든다. MVP에서는 하나의 task가 여러 TaskSource에서 동시에 생성되지 않으므로 기본 status surface delivery는 하나다. Cross-posting은 Forge Phase 2에서 별도 ReporterSink policy로 추가한다.

## 메시지 포맷 (Discord)

```
[task: <id>] <project> "<title>"
✓ design (claude, 12s) → outputs/01_design.md
✓ design_review (codex, 8s) → outputs/02_design_review.md
✗ check failed: test (exit 1) → logs/check_test.stderr
```

## PR 본문 템플릿

`~/forgeroom/templates/pr_template.md`:

```markdown
## Summary
{{conductor_summary}}

## Steps
{{step_table}}

## Checks
{{check_results}}

## Task
- ID: {{task_id}}
- Workflow: {{workflow_id}}
- Issue: {{issue_link}}
```

## 의존

- DiscordReporterSink (discord.js)
- GitHubReporterSink (Octokit)
- TaskStore (events)

## 에러

- ReporterSink delivery 오류 → backoff 재시도. 5회 실패 시 delivery row는 undelivered 상태로 남기고 로컬 로그에 기록한다. Status message/comment delivery 실패는 task 진행을 실패시키지 않는다.
- PR 생성은 Reporter delivery가 아니라 **PipelineEngine이 소유하는 workflow external effect**다 ([ADR-019](../decisions/2026-05-23-019-pr-creation-external-effect.md)). Reporter/ReporterSink는 PR을 생성하지 않고 `pr_created` event를 소비해 comment/body/status만 갱신한다. `effects.external.pr != none`인 workflow에서 PR 생성이 3회 실패하면 `failure_reason=pr_create_failed`로 task failed 처리한다.
- 토큰 만료 → fatal 알림 (콘솔 + 로컬 알림 디렉토리)
