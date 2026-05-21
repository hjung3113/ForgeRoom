---
status: decided
last_reviewed: 2026-05-21
---

# TaskStore

## 책임

- SQLite 영속 저장소: task / step / check / event / conductor_state
- 작업 큐 역할 (project별 FIFO)
- 동시성 제약 강제 (project별 1개 active task)
- 재시작 시 미완료 task 회복용 인덱스 제공

## 입력

- PipelineEngine, Gateway, Reporter의 CRUD 호출

## 출력

- `data/forgeroom.sqlite`

## 스키마

상세는 [data-model.md](../concepts/data-model.md). 핵심 테이블:

- `tasks`
- `steps`
- `checks`
- `events`
- `conductor_state`

## 인터페이스 (요지)

```typescript
interface TaskStore {
  createTask(input: CreateTaskInput): Promise<Task>
  updateTaskStatus(id: TaskId, status: TaskStatus): Promise<void>
  getTask(id: TaskId): Promise<Task | null>
  listActiveTasks(projectId?: string): Promise<Task[]>
  acquireProjectLock(projectId: string, taskId: TaskId): Promise<boolean>
  releaseProjectLock(projectId: string, taskId: TaskId): Promise<void>

  createStep(input: CreateStepInput): Promise<Step>
  updateStep(id: StepId, patch: Partial<Step>): Promise<void>
  listSteps(taskId: TaskId): Promise<Step[]>

  recordCheck(input: CreateCheckInput): Promise<Check>

  enqueueEvent(input: CreateEventInput): Promise<Event>
  markEventDelivered(id: EventId): Promise<void>
  listUndeliveredEvents(): Promise<Event[]>

  upsertConductorState(taskId: TaskId, summary: string, summaryPath: string): Promise<void>
}
```

## 의존

- better-sqlite3
- Drizzle ORM
- 마이그레이션 파일 (`db/migrations/`)

## 트랜잭션 정책

- 작업 시작 시 `tasks.insert` + `acquireProjectLock` 한 트랜잭션
- step 단계 종료 시 `updateStep` + `events.insert` 한 트랜잭션
- 멱등성 핵심: event 발송 전 row 생성, 발송 후 `delivered_at` 갱신

## 인덱스

- `tasks(project_id, status)`: 락 검사, 진행 중 task 조회
- `steps(task_id, started_at)`: 시퀀스 조회
- `events(delivered_at) WHERE delivered_at IS NULL`: 미발송 이벤트

## 관련 결정

- [ADR-002](../decisions/2026-05-21-002-storage-sqlite.md)
