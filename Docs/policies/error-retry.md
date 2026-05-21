---
status: decided
last_reviewed: 2026-05-21
---

# 에러·재시도 정책

## 전체 표

| 실패 지점 | 처리 |
|---|---|
| Agent 실행 실패 (timeout/exit≠0) | `step.attempt++`, 즉시 1회 재시도. 또 실패 → step.status=failed, task.status=failed |
| Agent가 output 파일 미작성 | `step.attempt++`. attempt<2: resume으로 파일 작성 재요청. 초과 시 failed |
| Conductor scope 위반 | 변경 파일 revert, 텍스트 응답은 사용. step 계속 |
| Conductor 호출 실패 | 1회 재시도. 또 실패 시 graceful degradation (refine 생략, update 생략) |
| Check 실패 | 1회 자동 수정: 실패 로그를 코드 작성 agent에 전달 → 수정 → 재실행. 또 실패 시 task.status=failed |
| `until` max_iterations 도달 | step.status=failed → task.status=failed |
| Git 충돌 (rebase 실패) | task.status=failed, 사람 개입 알림 |
| PR 생성 실패 (GitHub API) | exponential backoff 3회. 다 실패 시 task.status=failed, branch 보존 |
| Discord 발송 실패 | exponential backoff 5회. 발송 큐 (events 테이블)에 유지. task 진행 영향 없음 |
| Orchestrator 크래시 | 재시작 시 미완료 task 회복 |

## 재시도 카운트

- `step.attempt`: 0부터 시작, 재시도마다 +1
- 한도: 기본 `MAX_RETRY=2` (agent 호출 1차 + resume 2회 = 총 3회 시도)
- Phase 2에서 설정화

## 멱등성

- **Events**: row 생성 → 발송 → `delivered_at` 갱신. 재시작 시 미발송 재발송
- **Worktree**: 이미 존재하면 재사용
- **PR**: branch에 이미 PR 있으면 update, 없으면 create
- **Step**: 같은 step_id에 대해 prompt/output 파일 덮어쓰기

## 재시작 회복 (PipelineEngine.recoverPending)

```
1. SQLite: status IN ('running','paused') task 조회
2. 각 task의 마지막 step row 검사:
   - done: 다음 step부터
   - running: 해당 step 재시작 (멱등)
   - paused: status=paused 유지, /resume 명령 대기
3. worktree의 .forgeroom/ 존재 확인. 없으면 WorktreeManager.create로 부트스트랩 (재실행)
4. Conductor.init (이미 init된 task는 skip)
5. PipelineEngine.execute 재진입
```

## 사용자 알림

- agent/check 재시도 발생 시 Discord에 즉시 알림 (`step <id> retrying, attempt N`)
- task.status=failed로 전환 시 reason + 진단 링크(`logs/`, `outputs/`, `diffs/`) 포함

## Phase 2 강화

- 재시도 N회 설정화
- 실패 카테고리별 다른 재시도 곡선
- 자동 회복 큐 (failed → re-queue)
- LLM judge 기반 output 품질 검증

## 관련 문서

- [modules/pipeline-engine.md](../modules/pipeline-engine.md)
- [modules/check-runner.md](../modules/check-runner.md)
- [modules/agent-runner.md](../modules/agent-runner.md)
