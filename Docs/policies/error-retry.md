---
status: decided
last_reviewed: 2026-05-21
---

# 에러·재시도 정책

## 전체 표

| 실패 지점 | 처리 |
|---|---|
| Agent 실행 실패 (timeout/exit≠0) | AgentRunner output-producing attempt budget 사용. 소진 시 step.status=failed, task.status=failed |
| Agent가 output 파일 미작성 | AgentRunner output-producing attempt budget 사용. 가능하면 resume, 불가능하면 신규 headless run fallback. 소진 시 failed |
| output selector 파싱 실패 (`## Slices`, `Review Result`) | AgentRunner output-producing attempt budget으로 재작성 요청. 소진 시 failed |
| Conductor scope 위반 | 변경 파일 revert, 텍스트 응답은 사용. step 계속 |
| Conductor 호출 실패 | 1회 재시도. 또 실패 시 graceful degradation (refine 생략, update 생략) |
| Check 실패 | 별도 check fix budget 1회: 실패 로그를 코드 작성 agent에 전달 → 수정 → 모든 check 재실행. 또 실패 시 task.status=failed, `failure_reason=check_failed_after_fix` |
| `review_loop` max_iterations 도달 | step.status=failed → task.status=failed, `failure_reason=review_loop_max_iterations` |
| Git 충돌 (rebase 실패) | task.status=failed, 사람 개입 알림 |
| PR 생성 실패 (GitHub API) | exponential backoff 3회. 다 실패 시 task.status=failed, `failure_reason=pr_create_failed`, branch 보존 |
| ReporterSink delivery 실패 (Discord/GitHub status surface) | exponential backoff 5회. 발송 큐(event_deliveries 테이블)에 유지. task 진행 영향 없음 |
| Orchestrator 크래시 | 재시작 시 미완료 task 회복 |

## 재시도 카운트

- `step.attempt`: 0부터 시작, output-producing attempt마다 +1
- 한도: 기본 `MAX_AGENT_ATTEMPTS=3`
- `MAX_AGENT_ATTEMPTS`에는 provider exit non-zero, timeout, output 파일 미작성/너무 작은 파일, output selector 실패(`## Slices`, `Review Result`)가 모두 포함된다.
- CheckRunner 자동 수정 1회는 별도 check fix budget이다. AgentRunner를 호출하더라도 원 execute step의 output-producing attempt budget을 소비하지 않는다.
- CheckRunner 자동 수정은 새 workflow step row가 아니라 원 execute step row의 `check_fix_attempt`/`check_status`로 기록한다.
- Forge Phase 2에서 설정화

## 멱등성

- **Events**: domain event row 생성 → destination별 event_delivery row 생성 → 발송 → delivery `delivered_at` 갱신. 재시작 시 due delivery 재발송
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
   - control step row: child rows의 마지막 상태와 iteration으로 group/review_loop 내부 재진입 지점 복원
3. worktree의 .forgeroom/ 존재 확인. 없으면 WorktreeManager.create로 부트스트랩 (재실행)
4. Conductor.init (이미 init된 task는 skip)
5. PipelineEngine.execute 재진입
```

## 사용자 알림

- agent/check 재시도 발생 시 Discord에 즉시 알림 (`step <id> retrying, attempt N`)
- task.status=failed로 전환 시 `failure_reason` + 진단 링크(`logs/`, `outputs/`, `diffs/`) 포함

## Forge Phase 2 강화

- 재시도 N회 설정화
- 실패 카테고리별 다른 재시도 곡선
- 자동 회복 큐 (failed → re-queue)
- 실행 중 agent 호출 중단 정책: MVP의 `/pause`는 checkpoint pause만 지원하며, 즉시 interrupt/abort는 Forge Phase 2+에서 별도 정의
- 장기 정체 감지 watchdog: 예상 작업 기간을 현저히 초과한 running/paused task를 감지하고 사용자 확인 플로우로 전환
- LLM judge 기반 output 품질 검증

## 관련 문서

- [modules/pipeline-engine.md](../modules/pipeline-engine.md)
- [modules/check-runner.md](../modules/check-runner.md)
- [modules/agent-runner.md](../modules/agent-runner.md)
