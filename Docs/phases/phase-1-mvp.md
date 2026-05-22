---
status: decided
last_reviewed: 2026-05-21
---

# Forge Phase 1 — MVP

## 범위 (확장 자동화)

Discord/GitHub Issue 트리거 → ForgeMap context staging → worktree → Agent 실행 → check → PR 자동 생성까지. 사람은 PR 머지만.

## 구현 항목

| 영역 | 항목 |
|---|---|
| 런타임 | Node.js + TypeScript 단일 프로세스 |
| 저장소 | SQLite + Drizzle ORM, 마이그레이션 |
| 설정 | `projects.yaml`, `workflows.yaml`, `agents.yaml`, `discord.yaml` |
| DSL | 자유 step id + 변수 보간 + `foreach` + `review_loop` + `max_iterations` + `pause_after`, 모든 workflow의 `effects` metadata 선언 |
| AgentRunner | AgentRuntimeProvider 경유, MVP 구현체는 OpenClawProvider, headless 기본, PTY 옵션 |
| ForgeMap | Target Project context 생성·선택·staging, 한 장 요약이 아닌 목적별 map 문서 |
| Conductor | 옵션 B (headless + 롤링 요약), update/refine/answer |
| WorktreeManager | 1 task = 1 worktree, `.forgeroom/` 부트스트랩 |
| 프롬프트 IO | 파일 기반, bundled template root 제한, 검증 + resume 재시도(최대 2회), `## Slices`와 `Review Result: pass/fail` 출력 계약 |
| Conductor scope 방어 | git diff revert (fallback) |
| CheckRunner | `kind: execute` step 직후 `projects.yaml` 명령 실행, 실패 시 1회 자동 수정 재시도 |
| TaskSource | MVP 구현체는 Discord slash command와 GitHub Issue label polling |
| DiscordGateway | `/run`, `/pause`, `/resume`, `/cancel`, `/status`, `/ask`, `/feedback` |
| GitHubGateway | GitHub.com Issue label polling, PR 자동 생성 |
| Reporter | ReporterSink 경유 단계별 Discord 알림, GitHub PR 코멘트, 멱등성 |
| ApprovalGate | 위험 명령 거부 (승인 흐름 X) |
| 검증 시나리오 | 프로젝트 1개 + workflow 3개 + custom workflow 선택 |

## 예시 워크플로우

기본 제공 workflow는 온보딩용 sane default다. 실제 프로젝트 운영에서는 `allowed_workflows` 안에서 custom workflow를 선택해 쓰는 것을 전제로 하며, 아래 예시는 처음 사용하는 사람이 전체 흐름을 체험할 수 있는 기준선이다.

MVP workflow는 모두 `Docs/concepts/workflow-dsl.md`의 `effects` metadata를 선언해야 한다. PipelineEngine과 WorkflowRegistry는 이 metadata로 read-only workflow와 modification workflow를 구분하고, Reporter/Gateway 외부 반영 정책을 판단한다.

`configs/intents.yaml`:

```yaml
claude_write_plan:
  kind: write_plan
  agent: claude
  harness: planning

codex_review:
  kind: review
  agent: codex
  harness: review

claude_refine:
  kind: refine
  agent: claude
  harness: planning

codex_execute:
  kind: execute
  agent: codex
  harness: implementation

claude_review:
  kind: review
  agent: claude
  harness: review
```

`configs/workflows.yaml`:

```yaml
full:
  description: "설계 → 리뷰 → 보강 → 계획 → slice 반복 구현 → 최종 리뷰"
  effects:
    worktree: modifies
    external:
      report: status
      pr: ready
  steps:
    - type: run
      id: design
      intent: claude_write_plan
      prompt_template: design.md

    - type: run
      id: design_review
      intent: codex_review
      prompt_template: review_design.md
      input_refs:
        target: ${design.output_path}

    - type: run
      id: design_refine
      intent: claude_refine
      prompt_template: refine_design.md
      input_refs:
        original: ${design.output_path}
        review: ${design_review.output_path}

    - type: run
      id: impl_plan
      intent: claude_write_plan
      prompt_template: implementation_plan.md

    - type: run
      id: impl_plan_review
      intent: codex_review
      prompt_template: review_plan.md
      input_refs:
        target: ${impl_plan.output_path}

    - type: run
      id: impl_plan_refine
      intent: claude_refine
      prompt_template: refine_plan.md
      input_refs:
        original: ${impl_plan.output_path}
        review: ${impl_plan_review.output_path}

    # Design/plan review는 pass/fail gate가 아니라 refine 입력이다.
    # Code diff 품질 관문만 review_loop로 반복한다.
    - type: group
      id: slices
      foreach: ${task.final_slices}
      as: slice
      steps:
        - type: run
          id: slice_impl
          intent: codex_execute
          prompt_template: slice_impl.md
          vars:
            slice: ${slice}
        - type: review_loop
          id: slice_quality
          max_iterations: 3
          until: ${slice_review.passed}
          review:
            id: slice_review
            intent: claude_review
            prompt_template: review_slice_diff.md
            input_refs:
              diff: ${slice_impl.diff_path}
          refine:
            id: slice_refine
            intent: codex_execute
            prompt_template: refine_slice_from_review.md
            input_refs:
              review: ${slice_review.output_path}
              diff: ${slice_impl.diff_path}

    - type: review_loop
      id: final_quality
      max_iterations: 2
      until: ${final_review.passed}
      review:
        id: final_review
        intent: claude_review
        prompt_template: final_review.md
        input_refs:
          full_diff: ${task.full_diff_path}
      refine:
        id: final_refine
        intent: codex_execute
        prompt_template: final_refine.md
        input_refs:
          review: ${final_review.output_path}
          full_diff: ${task.full_diff_path}

quick:
  description: "간단 작업"
  effects:
    worktree: modifies
    external:
      report: status
      pr: ready
  steps:
    - type: run
      id: plan
      intent: claude_write_plan
      prompt_template: implementation_plan.md
    - type: run
      id: implement
      intent: codex_execute
      prompt_template: execute.md
      input_refs:
        plan: ${plan.output_path}
    - type: review_loop
      id: quality
      max_iterations: 2
      until: ${review.passed}
      review:
        id: review
        intent: claude_review
        prompt_template: review_diff.md
        input_refs:
          diff: ${implement.diff_path}
      refine:
        id: refine
        intent: codex_execute
        prompt_template: refine_from_review.md
        input_refs:
          review: ${review.output_path}
          diff: ${implement.diff_path}

hotfix:
  description: "긴급 수정"
  effects:
    worktree: modifies
    external:
      report: status
      pr: ready
  steps:
    - type: run
      id: fix
      intent: codex_execute
      prompt_template: hotfix.md
    - type: run
      id: review
      intent: claude_review
      prompt_template: review_hotfix.md
```

## 완료 정의 (Acceptance)

1. 프로젝트 1개 등록 후 Discord `/run` 호출로 풀 파이프라인 자동 실행
2. workflow별(`full`/`quick`/`hotfix`) 호출 정상 작동
3. 단계별 Discord 알림 도착
4. `/ask <task>` 로 task 컨텍스트 질문 응답
5. `/feedback <task>` 로 사용자 피드백을 다음 step 프롬프트 보강에 반영
6. ForgeMap 최초 생성 후 task 시작 시 관련 context가 `.forgeroom/context/`에 staging됨
7. PR 자동 생성, GitHub UI에서 머지 가능
8. orchestrator 재시작 후 진행 중 task 이력 복구 + 다음 step부터 resume
9. 위험 명령 거부 검증
10. step output 파일 미작성 시 자동 재시도 동작
11. Conductor scope 위반 시 git revert 동작
12. `/cancel <task>` 로 paused/running task를 canceled로 전환해 같은 project의 queue 진행 가능

## 비범위

- 워크플로우 dry-run validator → Forge Phase 2
- Discord 승인 게이트 (merge 외) → Forge Phase 2
- raw stdout 스트리밍 → Forge Phase 2
- 단독 inspection review workflow (`review_only`) → Forge Phase 2 후보
- 사내 환경 TaskSource/Reporter 구현체 (Local CLI, GitHub Enterprise, git issue, 사내 chat/ticket) → Forge Phase 2
- OpenCodeProvider, HermesProvider, 직접 CLI provider 구현체 → Forge Phase 2
- ForgeMap 외부 ingestion (issue/PR history, 공식 문서, 사내 wiki/ticket) → Forge Phase 2
- 처리 단위 확장: Task 아래 workflow hierarchy로 Project Phase / Slice 같은 큰 작업 구조를 표현하는 방법 검토 → Forge Phase 3
- 한 task 안 병렬 sub-task → Forge Phase 3
- 동적 워크플로우 변형 → Forge Phase 3
- 데스크탑 GUI → Forge Phase 4
- Tailscale → Forge Phase 4

## 마일스톤 슬라이스 (제안)

implementation plan에서 세분화하기 전 후보 슬라이스:

1. **Slice 1 — Core skeleton**: TaskStore + WorktreeManager + 단순 PipelineEngine (linear steps)
2. **Slice 2 — Agent integration**: AgentRegistry + OpenClawProvider + AgentRunner + 파일 IO 프로토콜
3. **Slice 3 — DSL 확장**: 변수 보간 + foreach + review_loop + max_iterations
4. **Slice 4 — ForgeMap + Conductor**: ForgeMap build/select/stage + update/refine/answer + scope 방어
5. **Slice 5 — TaskSource + Reporter**: DiscordGateway + GitHubGateway + Reporter sinks
6. **Slice 6 — CheckRunner + PR 생성**: end-to-end
7. **Slice 7 — Safety & recovery**: ApprovalGate + recoverPending + 멱등성 검증

writing-plans 스킬은 이 분할을 출발점으로 구현 계획 수립 가능.
