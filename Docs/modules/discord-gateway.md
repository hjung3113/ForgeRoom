---
status: decided
last_reviewed: 2026-05-21
---

# DiscordGateway

## 책임

- MVP Discord slash command TaskSource
- Discord 슬래시 명령 수신·파싱
- allowlist(사용자 ID 화이트리스트) 검증
- TaskRequest 생성
- 결과는 Reporter가 발송 (Gateway 자체는 명령 수신·라우팅만)

## 지원 명령 (MVP)

```
/run <project> "<title>" [--workflow=<id>]
/pause <task-id>
/resume <task-id>
/cancel <task-id>
/status [project|task-id]
/ask <task-id> "<question>"
/feedback <task-id> "<message>"
```

`/cancel`은 task 이력을 닫고 같은 project의 active slot을 해제한다. canceled task는 `/resume` 대상이 아니며, 보존된 worktree/branch/log를 근거로 새 task를 시작하거나 사람이 수동으로 이어간다.

특정 step을 건너뛰어야 하는 경우 런타임 `/skip` 명령을 쓰지 않고, 해당 step이 없는 별도 workflow를 정의한다.
리뷰만 실행하고 싶은 경우에도 `/review` 명령을 두지 않고, review-only workflow를 정의한 뒤 `/run <project> "<title>" --workflow=review-only` 형태로 실행한다.
특정 step의 agent/harness/kind를 바꾸고 싶으면 `/run` override 옵션을 쓰지 않고, 새 Intent와 custom workflow를 등록한 뒤 `--workflow`로 선택한다.
`/ask`는 현재 task 컨텍스트에 대한 질의응답이고, `/feedback`은 다음 step의 Conductor.refine 입력에 반영되는 사용자 지시다.
`/feedback`은 running/paused task에만 허용한다. running 중 받은 피드백은 현재 agent 호출에는 영향 없고 다음 step부터 반영하며, done/failed/canceled task에는 거부한다.

## 인터페이스

```typescript
interface DiscordGateway {
  start(): Promise<void>
  stop(): Promise<void>
}
```

내부적으로 discord.js 클라이언트 + 명령 핸들러 매핑. 명령 핸들러는 PipelineEngine을 직접 실행하지 않고 `TaskRequest`를 생성해 TaskStore/PipelineEngine 진입점에 전달한다.

## allowlist 검증

```yaml
# configs/discord.yaml
guilds:
  - id: '...'
allowed_user_ids:
  - '111111111111111111'
  - '222222222222222222'
```

Dirty baseline approval은 slash command requester 또는 project maintainer allowlist 사용자만 할 수 있다. 권한 없는 approval은 거부하고 Reporter가 같은 채널에 알린다.

명령 수신 시 user.id가 allowed_user_ids 에 없으면 즉시 거부 + 로그.

## 명령 파싱

- discord.js slash command framework 사용
- 옵션 파싱은 discord.js builder로 타입 안전
- MVP에서 step-level agent override 옵션은 지원하지 않는다. 실행 preset 변경은 Intent Catalog와 custom workflow로 표현한다.

## 응답

- 즉시 ack (3초 내) — "Task <id> queued"
- 후속 진행은 Reporter가 같은 채널의 task status message를 갱신해 보고
- status message edit가 불가능하면 follow-up message로 fallback
- task status message id는 `task.external_ref.status_message_id`에 저장한다. fallback으로 새 follow-up message를 만들면 id를 갱신한다.
- dirty baseline approval은 원 slash command thread/channel에서 받는다. 승인 event는 TaskStore events에 기록하고 Reporter가 같은 채널에 결과를 알린다.

## 의존

- discord.js
- PipelineEngine
- Conductor
- TaskStore (status 조회)

## 에러

- 명령 파싱 실패 → ephemeral 메시지로 사용자에게 안내
- 인증 실패 → 거부 + audit 로그
- 내부 예외 → Reporter로 task_failed 보고
