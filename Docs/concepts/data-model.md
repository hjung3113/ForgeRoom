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
  source: 'discord' | 'github-label'
  issue_number: number | null
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
  attempt: number                  // 재시도 카운터
  prompt_path: string              // absolute
  output_path: string              // absolute
  diff_path: string | null
  exit_code: number | null
  started_at: timestamp
  finished_at: timestamp | null
}
```

`review_loop`는 control step parent row를 하나 만들고, loop 내부의 `review`/`refine` 실행은 child step row로 저장한다. 최초 review의 `iteration`은 `0`이고, 첫 refine 뒤 재실행되는 review의 `iteration`은 `1`이다. `foreach` 내부 step도 같은 방식으로 group parent row를 참조한다.

### checks

```typescript
checks {
  id: string                       // uuid
  step_id: string                  // 어떤 단계 직후 실행됐는지
  command_name: string             // 'test', 'lint', ...
  command: text                    // 실제 실행 명령
  exit_code: number
  stdout_path: string
  stderr_path: string
  duration_ms: number
  created_at: timestamp
}
```

### events

```typescript
events {
  id: string                       // uuid
  task_id: string
  type: string                     // 'task_started', 'step_done', 'check_result', 'user_feedback', 'feedback_integrated', 'feedback_integration_failed', 'pr_created', 'task_failed', 'task_canceled', 'ask_response'
  payload: json
  destination: 'discord' | 'github'
  delivered_at: timestamp | null
  created_at: timestamp
}
```

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

## 인덱스

```sql
CREATE INDEX idx_tasks_project_status ON tasks(project_id, status);
CREATE INDEX idx_steps_task ON steps(task_id, started_at);
CREATE INDEX idx_events_undelivered ON events(delivered_at) WHERE delivered_at IS NULL;
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
