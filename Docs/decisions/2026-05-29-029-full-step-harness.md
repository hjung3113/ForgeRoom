---
status: decided
date: 2026-05-29
---

# ADR-029: 풀 Step Harness (HarnessInstaller / harness.yaml / OutputContractValidator / RuntimeProfileCompiler)

## 배경

ForgeRoom의 원래 핵심 목표 중 하나는 "각 역할에 맞는 환경·도구·지침·계약을 부여하고 agent가 역할에 충실하게 만드는 것"이다. 이를 담는 모듈이 **Step Harness**다 (glossary: prompt contract + permissions + tools + skills + hooks + AGENTS.md + output rules).

현재 구현은 그 **씨앗만** 있다.

- ADR-027/#69: harness = `harnesses/<id>` **단일 markdown 파일** (prompt + output contract 텍스트). `configs/harnesses.yaml`이 id→worktree-relative source(`.forgeroom/harnesses/<id>`)를 매핑하고, WorktreeManager가 bootstrap 시 stage, `renderPrompt`가 harness 계약 + step template을 합성한다.
- output 검증은 `output-selectors.ts`에 **하드코딩**돼 있다 (`## Slices` 파싱, `Review Result: pass/fail` 파싱).
- 권한 모델은 ApprovalGate(in-step shell-command gate, ADR-013)뿐. harness가 권한/도구를 선언하는 구조는 없다.

이 ADR은 minimal harness → **full Step Harness**로의 확장 경계를 결정한다. codex grill로 검증했다 (2026-05-29, 신뢰도 표기).

## 결정

### 1. 구조화 harness, ADR-027 위에 additive (codex 91)

Harness는 `harnesses/<id>/` **디렉터리**가 된다. `harness.yaml`이 매니페스트이고, **기존 markdown 계약을 교체하지 않고 참조**한다.

```yaml
# harnesses/review/harness.yaml
id: review
description: Read-only diff review harness.
applies_to:
  kinds: [review]
prompt_contract: ./prompt-contract.md      # ADR-027 markdown이 그대로 여기로
output:
  first_line_regex: "^Review Result: (pass|fail)$"
  required_sections: [Findings]
permissions:
  filesystem: read_only
  shell: disabled
  network: disabled
tools:
  allow: [read_file, grep, git_diff, read_logs]
  deny: [write_file, shell_write]
```

- 기존 `harnesses/planning|implementation|review` 텍스트 파일은 **기계적으로** `harnesses/<id>/prompt-contract.md`로 이동한다 (의미 재작성 없음).
- `skills/`, `hooks/`, `AGENTS.md` 등은 선택 필드/파일이며 후속에서 채운다. 이 ADR은 자리(스키마)만 확정한다.

### 2. Staging: `.forgeroom/harnesses/<id>` 유지 (codex 87)

- ADR-027의 per-harness staging(`.forgeroom/harnesses/<id>`)을 **canonical로 유지**한다. step별로 동일 harness 내용을 복제하지 않는다.
- `.forgeroom/runtime/<step_id>/`는 **compiled/ephemeral view 전용**으로만 예약한다 (생성된 AGENTS 스냅샷, 권한 정책 스냅샷, 로그). 필요해질 때 채운다. harness source의 canonical 위치가 아니다.

### 3. OutputContractValidator: 하드코딩 selector를 계약 구동으로 (E2)

- `output-selectors.ts`의 `## Slices`/`Review Result` 규칙을 harness.yaml의 `output` 계약(`required_sections`, `first_line_regex`, `min_bytes`)으로 **일반화**한다.
- 검증 실패는 기존 `output_contract_failed` failure code + AgentRunner resume/retry budget을 그대로 사용한다 (ADR 신규 코드 없음).
- `## Slices`의 **콘텐츠 추출**(`parseSlicesOutput`이 slice 목록을 뽑는 것)은 검증과 분리해 유지한다 — validator는 계약 충족 여부만, selector는 값 추출만.

### 4. RuntimeProfileCompiler: OpenClaw는 권한을 강제하지 않는다 (codex 94)

OpenClaw CLI(`agent --json --agent <id> [--session-id] --message --model --timeout`)에는 **per-call permission/tool 플래그가 없다**. 따라서 "OpenClaw가 harness 권한을 런타임 강제한다"고 주장하는 컴파일러는 거짓이다. 컴파일러는 harness 권한/도구를 다음 셋으로만 컴파일한다.

- **(a) soft advisory** — prompt/AGENTS.md 텍스트에 권한·도구 제약을 명시 (모델에 대한 지침, 강제 아님).
- **(b) hard enforcement = ForgeRoom 소유** — ApprovalGate(ADR-013), command/path gate, worktree diff 검증. **실제 강제는 전적으로 ForgeRoom 쪽**이다. 예: `permissions.filesystem: read_only` harness는 write를 만들면 diff 검증/gate에서 막힌다.
- **(c) optional `--agent` 선택** — #85 `runtimeSession.providerAgentId`로 미리 구성된 OpenClaw agent를 고르는 정도(있을 때만).

컴파일러 출력은 "이 step에서 ForgeRoom이 무엇을 hard-gate할지" + "prompt에 무엇을 advisory로 넣을지"이지, OpenClaw에 넘기는 권한 프로파일이 아니다.

**Boundary invariant**: `HarnessManifest` 스키마는 provider-specific identity(예: `provider_agent_id`, `openclaw_agent`)를 직접 담지 않는다. agent 선택은 ProjectRoom OpenClaw config × intent role을 통한 `runtimeSession.providerAgentId`로만 흐른다(F2/F8 review 결정). harness 는 "실행 계약" 이고 ProjectRoom 가 "provider inventory" — 둘을 한 파일에 묶으면 harness 가 특정 프로젝트에 결박된다.

### 5. Phasing/순서 (codex 84)

1. **E1 HarnessInstaller + harness.yaml schema** — 스키마 + installer 호환성 먼저. ADR-027 staging 확장 (디렉터리 stage, harness.yaml + 참조 파일 validate, 누락 시 fail-fast). prompt-contract 합성은 기존대로.
2. **E2 OutputContractValidator** — selector 하드코딩을 계약 구동으로 이전. default harness metadata를 바꾸기 **전에** validator를 먼저 둔다.
3. **E3 default harnesses** — planning/implementation/review(+docs/research) harness.yaml에 permissions/tools/output 계약 채움.
4. **E4 RuntimeProfileCompiler + dry-run/debug** — 검증된 스키마 위에서 컴파일 (soft+hard+agent). dry-run validator + Discord/Mastra(2C tools)/Canvas(2D)에 harness metadata 노출. 컴파일러가 vague한 permissions/tools 필드의 첫 소비자가 되지 않도록 마지막.

### 6. 기존 ADR과의 관계

- **ADR-027 확장(supersede 아님)**: prompt-contract 합성·staging 메커니즘 유지, 그 위에 구조 추가.
- **ADR-013 ApprovalGate = hard enforcement substrate**: harness 권한의 실제 강제 지점.
- **ADR-023/024(ResolvedRuntimeTarget) + ADR-028 #85(runtimeSession)**: 컴파일러의 `--agent` 선택은 runtimeSession을 통해서만. ResolvedRuntimeTarget(runtime/model/permissionProfile)과 harness profile은 직교 — harness는 "환경/계약", target은 "런타임/모델".

## 결과

- `harnesses/<id>/harness.yaml` + `prompt-contract.md` 구조 도입. 기존 3개 harness 기계적 이전.
- `HarnessRegistry` resolve가 harness.yaml을 읽도록 확장 (현재는 source 경로만).
- `OutputContractValidator` 신규 (core); `output-selectors`의 검증 책임 흡수, 추출 책임은 분리 유지.
- `RuntimeProfileCompiler` 신규: harness → {advisory prompt 조각, ForgeRoom gate 설정, optional providerAgentId}. **OpenClaw 권한 강제 주장 금지.**
- E1-E4 별도 이슈/PR로 분해, 위 순서대로.
- 미해결로 남김: skills/hooks 실제 실행 (자리만), `.forgeroom/runtime/<step_id>/` compiled view, harness pack 공유(Phase 3C).

## 관련

- [ADR-027: Harness 계약 staging + rendered prompt 합성](2026-05-25-027-harness-contract-staging.md) — 확장 대상
- [ADR-013: TaskSource/Reporter boundaries](2026-05-22-013-task-source-and-reporter-boundaries.md) — ApprovalGate = hard enforcement
- [ADR-023: ResolvedRuntimeTarget](2026-05-25-023-resolved-runtime-target.md)
- [ADR-028: Project Room + runtimeSession](2026-05-26-028-project-room-domain-and-seam.md) — `--agent` 선택 경로
- `Docs/phases/project-rooms-roadmap-v3.md` — Harness & Runtime Profile Roadmap (출처)
