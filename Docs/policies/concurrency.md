---
status: decided
last_reviewed: 2026-05-21
---

# 동시성 정책

## 규칙

- 같은 `project_id` 동시 실행 = 최대 1개 (대기는 큐로)
- 다른 `project_id` 간엔 병렬 실행 가능
- 한 task 내 step은 순차 (병렬 sub-task는 Phase 3)

## 강제 메커니즘

1. **SQLite UNIQUE 인덱스**: `(project_id) WHERE status IN ('running','paused')`
2. **in-process Lock Map**: `Map<projectId, Mutex>` — 같은 프로세스 내 충돌 방지

두 layer 모두 사용. DB 인덱스는 재시작 후 일관성, in-process Lock은 성능.

## 큐 정책

- project별 FIFO
- `status='queued'`인 task 중 가장 오래된 것부터 시작
- 새 task 진입 시 같은 project에 active 있으면 queued 상태로만 둠

## 자원 한계

- Node 단일 프로세스. CPU 코어 활용은 OpenClaw + child_process 병렬
- 디스크: worktree당 수십~수백 MB. Phase 2에서 cleanup 정책
- 네트워크: Discord + GitHub API rate limit 준수 (Reporter 백오프)

## 동시성 관련 결정

- 단일 프로세스 ([ADR-001](../decisions/2026-05-21-001-runtime-nodejs-typescript.md))
- SQLite 단일 writer ([ADR-002](../decisions/2026-05-21-002-storage-sqlite.md))

## Phase 3 확장

- 한 task 내 병렬 sub-step
- 다중 머신 orchestrator (cluster)
- Redis/BullMQ 분산 큐
