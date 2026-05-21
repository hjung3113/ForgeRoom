---
status: decided
last_reviewed: 2026-05-21
---

# ApprovalGate

## 책임

- 위험 명령·경로·작업을 시스템 레벨에서 거부
- MVP: 거부만 (Discord 승인 흐름은 Phase 2)

## 차단 대상 (MVP 카탈로그)

| 카테고리 | 예시 |
|---|---|
| 파괴적 git | `git push --force`, `git reset --hard origin/...`, branch 삭제 |
| main 직접 수정 | `main` 또는 `default_branch`로 직접 commit/worktree |
| 파일시스템 위험 | `rm -rf /`, 홈 디렉토리 외부 절대경로 write |
| 시크릿 접근 | `.env`, `id_rsa`, `*.pem` 읽기/쓰기 |
| 마이그레이션 | `*migrate*`, `db reset` 패턴 명령 |
| 임의 다운로드·실행 | `curl ... | sh`, `wget ... | bash` |
| 외부 송출 | 등록 안된 도메인으로 sensitive 데이터 전송 |

## 인터페이스

```typescript
interface ApprovalGate {
  checkCommand(cmd: string, cwd: string): GateDecision
  checkFileWrite(path: string, worktreePath: string): GateDecision
  checkWorkflow(workflow: ParsedWorkflow, project: ProjectMeta): GateDecision
}

interface GateDecision {
  allowed: boolean
  reason?: string
  category?: string
}
```

## 적용 지점

- CheckRunner: 명령 실행 직전 `checkCommand`
- AgentRunner: post-run diff 검사 시 `checkFileWrite` 위반 파일 revert
- PipelineEngine: 작업 시작 시 `checkWorkflow` 로 워크플로우 무결성 검증

## 차단 규칙 정의

`configs/approval.yaml` (선택, 없으면 기본값):

```yaml
deny_commands:
  - pattern: "^git push.*--force"
  - pattern: "rm -rf /"
  - pattern: "curl .* \\| (sh|bash)"
deny_paths:
  - "**/.env"
  - "**/id_rsa"
  - "**/*.pem"
allowed_write_roots:
  - "${worktree_path}"
```

## 로깅

차단 시 `logs/approval_<date>.log`에 기록:
- 시각
- task_id
- 명령/경로
- 카테고리
- 차단 사유

## 의존

- 정규식 라이브러리 (Node 내장)
- 파일 시스템

## 에러

- 정규식 컴파일 실패 → fatal (부팅 거부)
- 평가 실패 → 안전 우선 (`allowed=false`)

## Phase 2 확장

- Discord 명령으로 차단된 작업 1회 승인 (`/approve <task>`)
- merge 외 위험 작업도 Discord 승인 게이트
- 카탈로그 핫리로드
