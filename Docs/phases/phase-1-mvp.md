---
status: decided
last_reviewed: 2026-05-21
---

# Phase 1 — MVP

## 범위 (확장 자동화)

Issue/Discord 트리거 → worktree → Agent 실행 → check → PR 자동 생성까지. 사람은 PR 머지만.

## 구현 항목

| 영역 | 항목 |
|---|---|
| 런타임 | Node.js + TypeScript 단일 프로세스 |
| 저장소 | SQLite + Drizzle ORM, 마이그레이션 |
| 설정 | `projects.yaml`, `workflows.yaml`, `agents.yaml`, `discord.yaml` |
| DSL | 자유 step id + 변수 보간 + `foreach` + `until` + `max_iterations` + `pause_after` |
| AgentRunner | OpenClaw 위임, headless 기본, PTY 옵션 |
| Conductor | 옵션 B (headless + 롤링 요약), update/refine/answer |
| WorktreeManager | 1 task = 1 worktree, `.forgeroom/` 부트스트랩 |
| 프롬프트 IO | 파일 기반, 검증 + resume 재시도(최대 2회) |
| Conductor scope 방어 | git diff revert (fallback) |
| CheckRunner | `projects.yaml` 명령 실행, 실패 시 1회 자동 수정 재시도 |
| DiscordGateway | `/run`, `/plan`, `/code`, `/review`, `/pause`, `/resume`, `/skip`, `/cancel`, `/status`, `/ask` |
| GitHubGateway | Issue label polling, PR 자동 생성 |
| Reporter | 단계별 알림, PR 코멘트, 멱등성 |
| ApprovalGate | 위험 명령 거부 (승인 흐름 X) |
| 검증 시나리오 | 프로젝트 1개 + workflow 3개 + agent override |

## 예시 워크플로우

`configs/workflows.yaml`:

```yaml
workflows:
  full:
    description: "설계 → 리뷰 → 보강 → 계획 → phase 반복 구현 → 최종 리뷰"
    steps:
      - id: design
        agent: claude
        prompt_template: design.md

      - id: design_review
        agent: codex
        prompt_template: review.md
        input_refs:
          target: ${design.output_path}

      - id: design_refine
        agent: claude
        prompt_template: refine.md
        input_refs:
          original: ${design.output_path}
          review: ${design_review.output_path}

      - id: impl_plan
        agent: claude

      - id: impl_plan_review
        agent: codex

      - id: impl_plan_refine
        agent: claude

      - id: phases
        foreach: ${impl_plan_refine.output.phases}
        as: phase
        steps:
          - id: phase_impl
            agent: codex
            prompt_template: phase_impl.md
            vars:
              phase: ${phase}
          - id: phase_review
            agent: claude
            input_refs:
              diff: ${phase_impl.diff_path}
          - id: phase_refine
            agent: codex
            until: ${phase_review.passed}
            max_iterations: 3

      - id: final_review
        agent: claude
        input_refs:
          full_diff: ${task.full_diff_path}

      - id: final_refine
        agent: codex

      - id: final_rereview
        agent: claude

  quick:
    description: "간단 작업"
    steps:
      - id: plan
        agent: claude
      - id: implement
        agent: codex
      - id: review
        agent: claude
      - id: fix
        agent: codex
        until: ${review.passed}
        max_iterations: 2

  hotfix:
    description: "긴급 수정"
    steps:
      - id: fix
        agent: codex
      - id: review
        agent: claude
```

## 완료 정의 (Acceptance)

1. 프로젝트 1개 등록 후 Discord `/run` 호출로 풀 파이프라인 자동 실행
2. workflow별(`full`/`quick`/`hotfix`) 호출 정상 작동
3. agent override CLI 옵션 동작 (`--override design=gemini`)
4. 단계별 Discord 알림 도착
5. `/ask <task>` 로 task 컨텍스트 질문 응답
6. PR 자동 생성, GitHub UI에서 머지 가능
7. orchestrator 재시작 후 진행 중 task 이력 복구 + 다음 step부터 resume
8. 위험 명령 거부 검증
9. step output 파일 미작성 시 자동 재시도 동작
10. Conductor scope 위반 시 git revert 동작

## 비범위

- 데스크탑 GUI → Phase 3
- Tailscale → Phase 3
- 한 task 안 병렬 sub-task → Phase 3
- 동적 워크플로우 변형 → Phase 3
- 워크플로우 dry-run validator → Phase 2
- Discord 승인 게이트 (merge 외) → Phase 2
- raw stdout 스트리밍 → Phase 2

## 마일스톤 슬라이스 (제안)

implementation plan에서 세분화하기 전 후보 슬라이스:

1. **Slice 1 — Core skeleton**: TaskStore + WorktreeManager + 단순 PipelineEngine (linear steps)
2. **Slice 2 — Agent integration**: OpenClawAgentRegistry + AgentRunner + 파일 IO 프로토콜
3. **Slice 3 — DSL 확장**: 변수 보간 + foreach + until + max_iterations
4. **Slice 4 — Conductor**: update/refine/answer + scope 방어
5. **Slice 5 — Gateways**: DiscordGateway + GitHubGateway + Reporter
6. **Slice 6 — CheckRunner + PR 생성**: end-to-end
7. **Slice 7 — Safety & recovery**: ApprovalGate + recoverPending + 멱등성 검증

writing-plans 스킬은 이 분할을 출발점으로 구현 계획 수립 가능.
