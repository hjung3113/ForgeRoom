---
status: decided
last_reviewed: 2026-05-21
---

# 승인 정책

## MVP

- PR 머지만 사람 수동 (GitHub UI)
- 그 외 위험 명령은 ApprovalGate가 시스템 레벨에서 거부 (승인 없이 자동 거부)

차단 대상은 [modules/approval-gate.md](../modules/approval-gate.md).

## 사람 개입 지점 (MVP)

1. **`pause_after: true` step**: 워크플로우 정의에서 명시한 경우 정지. `/resume`으로 재개
2. **`/pause <task>`**: 사용자가 임의로 정지
3. **Dirty baseline approval**: task requester 또는 project maintainer allowlist 권한이 있는 사용자만 승인. GitHub에서는 write/maintain/admin collaborator도 승인자로 인정
4. **Pending rebuild stale-context approval**: modification workflow는 기본 중단. Maintainer approval이 있을 때만 stale context 진행 허용. read-only ask/investigation workflow는 warning artifact를 남기고 진행 가능
5. **PR 머지**: GitHub UI

## 자동 거부 (승인 흐름 X)

- 위험 명령 패턴 (`rm -rf /`, `push --force`, ...)
- main 직접 수정
- 시크릿 접근
- 등록되지 않은 path/owner/repo

이 항목들은 MVP에서 승인 게이트 자체를 두지 않고 즉시 거부한다. 거부 사유는 Reporter로 알림.

## Phase 2 — Discord 승인 게이트

위험 작업을 1회 승인할 수 있는 흐름:

```
/approve <task> <step|action> [--ttl=10m]
```

- 사용자 allowlist 검증
- TTL 내 1회 허용
- audit 로그 영구 보존

## Phase 3 — 작업 분류별 차등 승인

- deploy/migration/main 변경 등 카테고리별 정책
- 다단 승인 (2명 이상)
