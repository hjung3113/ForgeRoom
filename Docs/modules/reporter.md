---
status: decided
last_reviewed: 2026-05-21
---

# Reporter

## 책임

- 단계별 Discord 알림 발송 (plan_done, code_done, check_result, pr_created, failure)
- GitHub PR 본문/코멘트 생성
- 멱등성 보장 (`events` 테이블)

## 인터페이스

```typescript
interface Reporter {
  notify(event: ReporterEvent): Promise<void>
  flushUndelivered(): Promise<void>     // 재시작 시 호출
}

type ReporterEvent =
  | { type: 'task_started', task: Task }
  | { type: 'step_done', task: Task, step: Step }
  | { type: 'check_result', task: Task, results: CheckResult[] }
  | { type: 'user_feedback', task: Task, message: string }
  | { type: 'feedback_integrated', task: Task, feedbackPath: string }
  | { type: 'feedback_integration_failed', task: Task, reason: string }
  | { type: 'pr_created', task: Task, pr_number: number, pr_url: string }
  | { type: 'task_failed', task: Task, reason: string }
  | { type: 'ask_response', task: Task, question: string, answer: string }
```

## 멱등성 알고리즘

1. `TaskStore.enqueueEvent(payload)` → row 생성, `delivered_at=null`
2. Discord/GitHub API 호출
3. 성공 → `TaskStore.markEventDelivered(id)`
4. 실패 → 재시도 큐, exponential backoff (1s, 2s, 4s, 8s, 최대 5회)
5. 재시작 시 `flushUndelivered()` 호출, `delivered_at IS NULL` 모두 재발송

## 알림 수준 (MVP)

주요 단계만:
- task 시작
- 각 step 완료 (output_path 링크 포함)
- 사용자 피드백 접수
- 피드백 통합 완료 또는 실패
- check 결과 요약
- PR 생성 (URL 포함)
- 실패 (원인 + 진단 링크)

raw stdout 스트리밍은 Forge Phase 2.

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

- DiscordClient (discord.js)
- Octokit
- TaskStore (events)

## 에러

- Discord/GitHub API 오류 → backoff 재시도. 5회 실패 시 로컬 로그만, task는 계속 진행
- 토큰 만료 → fatal 알림 (콘솔 + 로컬 알림 디렉토리)
