---
status: living
last_reviewed: 2026-05-21
---

# core/ Rules

작업 시작 전 [context-map.md](context-map.md)부터.

## 핵심 규칙

1. **외부 패키지 직접 호출 금지**. `discord.js`, `Octokit`, `child_process`, `fs.promises`, OpenClaw IPC 등은 `gateway/` 또는 `db/` 또는 `utils/` 어댑터를 거쳐 호출
2. **순수 비즈니스 로직 유지**. core는 외부 폴더 import 금지
3. **인터페이스로 의존 받기**. `TaskStore` 같은 영속성은 인터페이스 타입으로 의존. 구현체는 `db/`
4. **상태 변화는 TaskStore 통해서만**. 메모리 상태 직접 보유 금지 (예외: `Map<projectId, Lock>` 같은 in-process lock은 명시적으로 관리)
5. **에러 클래스 정의 + throw**. 빈 catch 금지

## 모듈 단위 분할

각 모듈은 자체 파일:
- `pipeline-engine.ts`
- `conductor.ts`
- `agent-runner.ts`
- `worktree-manager.ts`
- `check-runner.ts`
- `reporter.ts`
- `approval-gate.ts`
- `project-registry.ts`
- `workflow-registry.ts`
- `openclaw-agent-registry.ts`
- `task-store.ts` (인터페이스만)

테스트는 `<name>.test.ts` 옆에.

공개 타입은 `types.ts`.

## 체크리스트

- [ ] 외부 의존을 인터페이스로 추상화했나
- [ ] gateway/db/dsl 폴더를 직접 import하지 않나
- [ ] 단위 테스트가 mock 사용해 외부 의존 격리됐나
- [ ] [Docs/modules/<name>.md](../../../../Docs/modules/) 인터페이스와 일치하나

## 상위 규칙

- [src/CLAUDE.md](../CLAUDE.md)
- [coding-rules](../../../../Docs/rules/coding-rules.md)
