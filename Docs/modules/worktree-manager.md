---
status: decided
last_reviewed: 2026-05-21
---

# WorktreeManager

## 책임

- task별 git worktree + branch 생성
- `.forgeroom/` 디렉토리 부트스트랩 (context, prompts, outputs, diffs, logs)
- task 완료/취소 시 worktree 정리 정책 적용
- 동일 task 재실행 시 기존 worktree 재사용 (idempotent)

## 인터페이스

```typescript
interface WorktreeManager {
  create(task: Task): Promise<WorktreeHandle>
  ensureForgeroomDir(worktreePath: string): Promise<void>
  snapshot(worktreePath: string): Promise<GitSnapshot>
  diff(worktreePath: string, since: GitSnapshot): Promise<string>
  revertOutside(worktreePath: string, allowedPaths: string[]): Promise<RevertReport>
  cleanup(task: Task, policy: 'keep' | 'remove'): Promise<void>
}

interface WorktreeHandle {
  path: string
  branch: string
}
```

## branch 명명 규칙

- `agent/<project>-<task-id-short>`
- 예: `agent/my-app-a3f912`

## 디렉토리 부트스트랩

`create()` 호출 시 worktree 내부에 다음 생성:

```
<worktree>/.forgeroom/
├── context/
│   ├── task.md          # task 메타
│   ├── summary.md       # 빈 파일 (Conductor가 채움)
│   └── workflow.md      # 워크플로우 스냅샷
├── prompts/
├── outputs/
├── diffs/
└── logs/
```

## 위험 명령 차단

`create()`는 다음 케이스에서 거부:
- 기존 branch `main` 또는 `default_branch`로 직접 worktree 생성 시도
- worktree path가 프로젝트 path 내부 (격리 깨짐)

## 의존

- git CLI
- ProjectRegistry (path/branch 조회)

## 에러

| 케이스 | 처리 |
|---|---|
| 이미 존재하는 worktree | 재사용 (idempotent) |
| branch 중복 | UUID 짧은 해시로 재시도 |
| disk full | fatal, Reporter 알림 |
| 권한 부족 | fatal |

## 관련 결정

- [ADR-004](../decisions/2026-05-21-004-file-based-prompt-passing.md)
