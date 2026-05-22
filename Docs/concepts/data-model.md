---
status: decided
last_reviewed: 2026-05-21
---

# 데이터 모델 (SQLite)

저장소: `data/forgeroom.sqlite` (better-sqlite3 + Drizzle ORM).

## 테이블

### tasks

```typescript
tasks {
  id: string                       // uuid (primary)
  project_id: string               // projects.yaml key
  workflow_id: string              // workflows.yaml key
  title: string
  description: string
  status: 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'canceled'
  failure_reason: string | null
  source: 'discord-command' | 'github-issue-label'
  external_ref: json | null            // { provider, id, url, title?, status_comment_id?, status_message_id? }
  issue_number: number | null          // GitHub.com MVP compatibility field
  branch_name: string
  worktree_path: string            // absolute
  pr_number: number | null
  vars: json                       // 호출 시 vars
  created_at: timestamp
  updated_at: timestamp
}
```

### steps

```typescript
steps {
  id: string                       // uuid (primary)
  task_id: string                  // fk(tasks.id)
  step_id: string                  // workflow DSL의 id (자유 문자열)
  parent_step_id: string | null    // group/review_loop 같은 control step의 부모 row
  iteration: number                // review_loop/foreach 반복 번호 (기본 0)
  agent_id: string                 // 실제 사용된 agents.yaml 키
  status: 'pending' | 'running' | 'paused' | 'done' | 'failed'
  failure_reason: string | null
  attempt: number                  // 재시도 카운터
  check_fix_attempt: number        // CheckRunner 자동 수정 카운터, MVP max 1
  check_status: 'not_run' | 'passed' | 'failed' | 'fixed'
  prompt_path: string              // absolute
  output_path: string              // absolute
  diff_path: string | null
  exit_code: number | null
  started_at: timestamp
  finished_at: timestamp | null
}
```

`review_loop`는 control step parent row를 하나 만들고, loop 내부의 `review`/`refine` 실행은 child step row로 저장한다. 최초 review의 `iteration`은 `0`이고, 첫 refine 뒤 재실행되는 review의 `iteration`은 `1`이다. `foreach` 내부 step도 같은 방식으로 group parent row를 참조한다.

`attempt`는 AgentRunner output-producing attempt 수를 기록한다. `check_fix_attempt`와 `check_status`는 `kind: execute` step 뒤의 CheckRunner gate 상태를 기록한다. CheckRunner 자동 수정은 새 step row를 만들지 않고 원 execute step row의 check fix 상태와 `diff_path`를 갱신한다.

`check_status` 값의 의미:

- `not_run`: `kind: execute`가 아니거나 아직 CheckRunner가 실행되지 않음
- `passed`: 첫 CheckRunner 실행에서 모든 command 통과
- `fixed`: 첫 CheckRunner 실행은 실패했지만 자동 수정 1회 후 모든 command 통과
- `failed`: 자동 수정 없이 실패했거나 자동 수정 후에도 command 실패

`failure_reason`은 failed 상태의 canonical reason string이다. Step 실패 원인은 `steps.failure_reason`에 기록하고, task가 최종 failed로 전환되면 대표 원인을 `tasks.failure_reason`에 복사한다. MVP 대표 값은 `runtime_unavailable`, `auth_failed`, `timeout`, `agent_error`, `output_contract_failed`, `check_failed_after_fix`, `review_loop_max_iterations`, `git_conflict`, `pr_create_failed`다.

### checks

```typescript
checks {
  id: string                       // uuid
  step_row_id: string              // fk(steps.id), 어떤 step row 직후 실행됐는지
  check_fix_attempt: number        // 0 = 최초 check run, 1 = 자동 수정 후 재실행
  command_name: string             // 'test', 'lint', ...
  command: text                    // 실제 실행 명령
  exit_code: number
  stdout_path: string
  stderr_path: string
  duration_ms: number
  created_at: timestamp
}
```

`checks`는 command별 실행 결과를 append-only로 기록한다. `checks.step_row_id`는 DSL step id가 아니라 `steps.id`를 참조한다. Check fix가 발생하면 최초 실패 결과는 `check_fix_attempt=0`으로 보존하고, 자동 수정 후 재실행 결과는 `check_fix_attempt=1`로 새 row를 추가한다. Step-level 최종 상태는 `steps.check_status`가 요약한다.

### events

```typescript
events {
  id: string                       // uuid
  task_id: string
  type: string                     // 'task_started', 'step_done', 'check_result', 'user_feedback', 'feedback_integrated', 'feedback_integration_failed', 'pr_created', 'task_failed', 'task_canceled', 'ask_response'
  payload: json
  created_at: timestamp
}
```

### event_deliveries

```typescript
event_deliveries {
  id: string                       // uuid
  event_id: string                 // fk(events.id)
  destination: 'discord' | 'github'
  delivery_attempts: number
  next_delivery_at: timestamp | null
  last_delivery_error: string | null
  delivered_at: timestamp | null
  created_at: timestamp
}
```

`events`는 task history이고, `event_deliveries`는 external ReporterSink outbox다. 하나의 domain event는 Discord/GitHub 등 여러 delivery row를 가질 수 있다. `user_feedback`처럼 외부 발송이 필요 없는 event는 delivery row를 만들지 않는다.

ReporterSink delivery는 task 진행과 분리된 at-least-once event delivery다. 실패 시 `event_deliveries.delivery_attempts`를 증가시키고 exponential backoff 결과를 `next_delivery_at`에 저장한다. 5회 실패 후에도 delivery row는 삭제하지 않고 `delivered_at=null`과 `last_delivery_error`를 유지해 수동 재발송과 진단이 가능하게 한다.

### conductor_state

```typescript
conductor_state {
  task_id: string                  // primary
  summary: text                    // 마크다운, 길이 상한 4000 토큰
  last_step_id: string | null
  summary_path: string             // .forgeroom/context/summary.md absolute
  last_updated: timestamp
}
```

## 핵심 불변식

- **1 task = 1 worktree = 1 branch = 1 PR**
- 동일 `project_id`에 `status IN ('running','paused')` 인 task는 최대 1개
  - 강제: UNIQUE 인덱스 `(project_id) WHERE status IN ('running','paused')`
  - 보조: in-process `Map<projectId, Lock>`
- step 재시도 = 같은 row의 `attempt` 증가. 새 row 생성 X
  - 이력 보존은 `logs/` + `diffs/` 파일 디렉토리에 의존
- cancel은 `tasks.status='canceled'` 전환과 `events.type='task_canceled'` 기록을 같은 트랜잭션으로 처리
- canceled task는 자동 resume 대상이 아니며, worktree/branch/PR은 분석 또는 수동 이어받기를 위해 보존
- step 사이 사용자 피드백은 `events.type='user_feedback'`로 기록하고, 다음 step 직전 Conductor.integrateFeedback이 `.forgeroom/context/feedback.md`로 통합
- 반영된 user_feedback event는 payload에 `applied_at` marker를 남겨 중복 반영을 방지
- prompt/output 본문은 파일 primary. DB는 경로만 저장
- `source`와 `external_ref`는 TaskSource 경계 뒤의 외부 출처를 기록한다. MVP에서는 Discord command와 GitHub.com Issue label만 생성하지만, Forge Phase 2에서 GitHub Enterprise, git issue, Local CLI 같은 source를 추가할 수 있도록 Task 자체는 Issue에 종속하지 않는다.
- GitHub Issue task의 `external_ref.status_comment_id`는 pinned status comment 갱신용 cache다. 값이 없거나 stale하면 GitHubReporterSink가 `<!-- forgeroom:status task_id=<task_id> -->` marker로 Issue comments를 검색해 복구한다.
- Discord task의 `external_ref.status_message_id`는 task status message 갱신용 cache다. edit가 실패하거나 메시지가 만료되면 DiscordReporterSink가 새 follow-up message를 만들고 `status_message_id`를 갱신한다.

## 인덱스

```sql
CREATE INDEX idx_tasks_project_status ON tasks(project_id, status);
CREATE INDEX idx_steps_task ON steps(task_id, started_at);
CREATE INDEX idx_event_deliveries_due
ON event_deliveries(delivered_at, next_delivery_at)
WHERE delivered_at IS NULL;
CREATE UNIQUE INDEX idx_tasks_one_active_per_project
  ON tasks(project_id) WHERE status IN ('running','paused');
```

## 마이그레이션

- Drizzle migration 파일은 `apps/orchestrator/src/db/migrations/`
- 부팅 시 자동 적용
- 다운 마이그레이션은 MVP 미지원

## 백업

- MVP: 파일 복사 (`cp data/forgeroom.sqlite ...`)
- Forge Phase 2: 자동 일일 스냅샷

## 관련 결정

- [ADR-002: SQLite 선택](../decisions/2026-05-21-002-storage-sqlite.md)
