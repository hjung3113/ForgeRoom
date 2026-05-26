---
status: decided
date: 2026-05-25
---

# ADR-027: Harness 계약 staging + rendered prompt 합성

## 배경

[prompt-file-protocol step 8](../concepts/prompt-file-protocol.md)은 rendered prompt가 **harness prompt/output contract + step prompt template** 두 부분이어야 한다고 규정한다. #68에서 step prompt template 로딩·치환만 구현하고, harness 부분은 후속 이슈(#69)로 미뤘다.

[agent-runner.md](../modules/agent-runner.md)는 MVP에서 Step Harness의 canonical source를 ForgeRoom이 관리하는 dot-folder preset으로 두고, 실행 시 harness source를 task worktree의 runtime context로 fetch/copy 한다고 명시한다. `configs/harnesses.yaml`은 harness 이름 → worktree-relative source 경로(`.forgeroom/harnesses/<id>`)를 매핑하는 registry다.

## 결정

**Hybrid staging 모델**을 채택한다 (codex grill 2026-05-25, confidence 88).

- **Bundled harness root** = `<repo>/harnesses` (distribution source). 각 파일은 harness id를 파일명으로 갖고(확장자 없음), 내용은 그 harness의 prompt/output contract다. `FORGEROOM_HARNESS_ROOT` env로 override하며 기본값은 `<repo>/harnesses`로, `FORGEROOM_TEMPLATE_ROOT`/`templateRoot`와 동일한 방식으로 composition root가 주입한다.
- **WorktreeManager bootstrap**이 configured harness마다 bundled `<harnessRoot>/<id>`를 worktree의 `.forgeroom/harnesses/<id>`로 복사한다. WorktreeManager는 fs를 직접 읽지 않는다(core/ 규칙): composition root가 bundled 파일을 읽어 `harnessContracts: {id, content}[]`로 주입하고, WorktreeManager는 주입받은 내용을 `writeFileIfMissing`로 stage만 한다.
- **렌더 시점**에 `StepCollaborators.renderPrompt`가 `configs/harnesses.yaml`의 worktree-relative `source` 경로를 worktree 기준(`<worktree>/<source>`)으로 읽는다. harness 계약 파일이 없으면 fail-fast(`agent_error`)다.

**합성 형식** (codex 82): harness FIRST, step template SECOND. 둘 다 동일한 `{{}}` 치환 규칙(기존 renderTemplate 재사용)으로 보간하고, unknown placeholder는 fail-fast.

```
# Harness Contract

<interpolated harness contract>

---

# Step Prompt

<interpolated step template>
```

**Refine-on-composed** (codex 95): renderPrompt가 harness + template을 각각 보간·합성한 뒤, 그 합성 결과(composed base)를 `conductor.refine(task_id, step_id, composedBase)`에 넘긴다. (이전에는 template-only base로 refine했다.)

**Harness optional**: run step의 resolved harness는 harness id(string)다. group/review_loop 등 비-run step은 `harness: null`이며, null/absent면 harness 계약을 건너뛰고 template-only로 렌더한다(#68 동작 유지). `ResolvedStep.harness` 타입을 `string | null`로 확장한다.

**최소 계약 내용**: bundled 3개 harness 파일은 prompt-file-protocol.md에 이미 결정된 output contract만 인코딩한다(제품 철학/페르소나 없음).

- `planning`: planning/refine 출력은 `## Slices` 섹션을 포함해야 하며(`${task.final_slices}` source), 응답을 output 파일에 쓴다.
- `implementation`: output-file discipline(전체 응답을 output 파일에 기록) + 할당된 slice의 코드 변경 생성.
- `review`: review 출력의 첫 non-empty line이 `Review Result: pass`/`fail`이어야 하고(파싱되는 gate), 이어서 findings.

## 결과

- step 8이 명세대로 구현됨: harness 계약이 렌더 시 로드·치환·합성되어 refine 전에 prompt에 포함된다.
- `harnesses.yaml`는 그대로(worktree-relative source). distribution은 `<repo>/harnesses`, 실행 컨텍스트는 worktree `.forgeroom/harnesses/`로 분리되어 ForgeRoom 전용 runtime context 원칙(agent-runner.md)을 지킨다.
- 새 seam: `WorktreeManagerDependencies.harnessContracts`, `StepCollaboratorDeps.harnessRegistry`, `PipelineEngineDeps.harnessRegistry`, `OrchestratorEnv.harnessRoot`, `loadHarnessContracts()`.
- config에 참조됐는데 bundled 파일이 없으면 boot 실패(`ConfigError`) — shippable하지 않은 harness 참조를 조기에 드러낸다.

## 관련

- [ADR-004: 파일 기반 프롬프트 전달](2026-05-21-004-file-based-prompt-passing.md)
- [prompt-file-protocol step 8](../concepts/prompt-file-protocol.md)
- [agent-runner.md — Step Harness](../modules/agent-runner.md)
- #68 (template 로딩), #69 (이 ADR)
