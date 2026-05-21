---
status: decided
last_reviewed: 2026-05-21
---

# DiscordGateway

## 책임

- Discord 슬래시 명령 수신·파싱
- allowlist(사용자 ID 화이트리스트) 검증
- PipelineEngine, Conductor 호출
- 결과는 Reporter가 발송 (Gateway 자체는 명령 수신·라우팅만)

## 지원 명령 (MVP)

```
/run <project> "<title>" [--workflow=<id>] [--override <step>=<agent>]
/plan <project> "<title>"
/code <task-id> [--override=<agent>]
/review <task-id>
/pause <task-id>
/resume <task-id>
/skip <task-id> <step-id>
/cancel <task-id>
/status [project|task-id]
/ask <task-id> "<question>"
```

## 인터페이스

```typescript
interface DiscordGateway {
  start(): Promise<void>
  stop(): Promise<void>
}
```

내부적으로 discord.js 클라이언트 + 명령 핸들러 매핑.

## allowlist 검증

```yaml
# configs/discord.yaml
guilds:
  - id: '...'
allowed_user_ids:
  - '111111111111111111'
  - '222222222222222222'
```

명령 수신 시 user.id가 allowed_user_ids 에 없으면 즉시 거부 + 로그.

## 명령 파싱

- discord.js slash command framework 사용
- 옵션 파싱은 discord.js builder로 타입 안전
- override 옵션: 콤마 구분 문자열 `design=gemini,review=claude`

## 응답

- 즉시 ack (3초 내) — "Task <id> queued"
- 후속 진행은 Reporter가 같은 채널에 follow-up 메시지로 발송

## 의존

- discord.js
- PipelineEngine
- Conductor
- TaskStore (status 조회)

## 에러

- 명령 파싱 실패 → ephemeral 메시지로 사용자에게 안내
- 인증 실패 → 거부 + audit 로그
- 내부 예외 → Reporter로 task_failed 보고
