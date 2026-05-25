---
status: decided
last_reviewed: 2026-05-21
---

# 프롬프트 파일 프로토콜

CLI 직접 주입 대신 worktree 내부 파일에 프롬프트·출력을 적고 agent가 읽고 쓰는 방식. 장문 프롬프트의 응답 품질 저하 회피 + 디버깅·재시작 용이성 확보.

## 폴더 컨벤션

```
<worktree>/.forgeroom/
├── context/
│   ├── task.md              # 작업 메타: 제목, 설명, issue 링크, workflow 이름
│   ├── selected-forgemap.md # 현재 task에 필요한 selected ForgeMap manifest
│   ├── target-profile.md    # selected ForgeMap에서 추출한 상위 project profile snapshot
│   ├── docs/                # selected source docs snapshot copies
│   ├── summary.md           # Conductor 누적 요약
│   ├── feedback.md          # Conductor가 통합한 사용자 피드백
│   └── workflow.md          # 사용된 워크플로우 스냅샷
├── prompts/
│   ├── 01_design.md
│   ├── 02_design_review.md
│   └── ...
├── outputs/
│   ├── 01_design.md
│   ├── 02_design_review.md
│   └── ...
├── diffs/
│   ├── 03_design_refine.diff
│   └── ...
├── routing/
│   ├── 01_design.json        # 모델 라우팅 결정 기록 (ADR-024): selected target + policyId + reason
│   └── ...
└── logs/
    ├── 01_design.stdout
    ├── 01_design.stderr
    └── check_test.stderr
```

파일명 규칙: `NN_<step_id>.md` 또는 `NN_<step_id>.<iteration>.md`. NN은 zero-pad 2자리 step 인덱스. `review_loop` 내부 child step은 child `step_id`와 `iteration`을 파일명에 사용한다. 예: `07_slice_review.0.md`, `08_slice_refine.0.md`, `09_slice_review.1.md`.

## Step 실행 흐름

```
1. WorktreeManager가 worktree + .forgeroom/ 초기화 (task 시작 1회)
2. PipelineEngine task start 단계에서 ForgeMap stale check 수행. target repo가 dirty면 기본 중단하고 ReporterSink가 dirty files 요약을 알림
3. stale하지 않거나 refresh가 완료되면 ContextSelector 호출. dirty baseline과 pending rebuild modification workflow는 maintainer 명시 승인 후에만 허용
4. ContextSelector가 initial ForgeMap subset을 context/selected-forgemap.md와 context/target-profile.md로 staging. selected source docs는 context/docs/ 아래 snapshot copy로 staging하고, selected-forgemap.md에는 readable staged path, short summary, selection log를 기록
5. Conductor가 staged context sanity check. 명확한 누락 또는 scope mismatch가 있으면 ContextSelector가 1회 expand/reselect
6. PipelineEngine: 다음 step 선택
7. Intent resolve: step의 `intent`를 `configs/intents.yaml`에서 찾아 Resolved Step 생성
8. Resolved Step의 harness prompt/output contract + step의 prompt template 로드 (`<bundled_template_root>/<prompt_template>`)
9. 변수 보간 (${...} 치환)
10. 미반영 user_feedback event가 있으면 Conductor.integrateFeedback(task_id) → context/feedback.md 갱신
11. Conductor.refine(task_id, step_id, base_prompt) → selected-forgemap.md + summary.md + feedback.md + 직전 결과 기반 보강 프롬프트
12. .forgeroom/prompts/NN_<step_id>.md 에 저장
13. AgentRunner.run({
     agentId, promptPath, outputPath,
     cwd: worktree, mode: 'headless'
   })
   OpenClaw 메시지:
     "Read .forgeroom/prompts/NN_<step_id>.md and follow it.
      Write your response to .forgeroom/outputs/NN_<step_id>.md."
14. 종료 검증:
   - exists(outputPath) && size >= MIN_BYTES?
   - 실패 시 attempt++. attempt < MAX_AGENT_ATTEMPTS (기본 3):
       resume 호출로 출력 파일 작성 재요청
   - MAX_AGENT_ATTEMPTS 초과: step.status=failed
15. Resolved Step의 `kind`가 `execute`이면 CheckRunner 실행
   - 실패 시 마지막 코드 작성 agent에 1회 자동 수정 요청
   - 수정 후 모든 check 재실행
   - 재실패 시 step.status=failed
16. git diff → diffs/NN_<step_id>.diff 저장
17. step.status=done
18. Conductor.update(task_id, stepResult) — 동기 호출
19. Reporter.notify(step_done) — 비동기 (events 테이블 우선 기록)
```

## 검증 규칙

- `prompt_template`은 bundled template root 기준 상대 경로만 허용한다.
- 절대경로, `..`, root 밖으로 나가는 symlink는 validation 실패다.
- 참조한 template 파일이 없으면 WorkflowRegistry validation 실패다.
- MVP에서는 executable step의 inline `prompt`를 허용하지 않는다. `type: run`, `review_loop.review`, `review_loop.refine`은 `prompt_template`을 필수로 가지며, `prompt` 필드가 있으면 WorkflowRegistry validation 실패다.
- MVP에서는 프로젝트별 `template_dir` override를 실제 사용하지 않는다. Custom workflow도 bundled templates만 참조한다.
- output 파일 미존재 → output-producing attempt 실패로 간주, resume 또는 신규 headless run fallback
- 파일 크기 < 50 bytes → output-producing attempt 실패로 간주, resume 또는 신규 headless run fallback
- 내용에 명백한 거부 응답("Sorry I cannot...", "에러:") 만 있으면 step.status=failed (MVP는 정규식 휴리스틱)
- MVP의 `implementation_plan.md`와 `refine_plan.md`는 output 마지막에 `## Slices` 섹션을 포함해야 한다.
- `## Slices` 아래의 top-level `- ` bullet만 `${<step_id>.output.slices}`의 문자열 항목으로 파싱한다. nested bullet은 무시한다.
- slice가 0개면 PipelineEngine의 output selector 해석 단계에서 검증 실패로 간주하고, 같은 session에 유효한 `## Slices` 섹션으로 다시 작성하라고 resume 요청한다. 이 재시도는 AgentRunner의 output-producing attempt budget(`MAX_AGENT_ATTEMPTS`, 기본 3)을 사용한다.
- `kind: review` step은 output의 첫 non-empty line에 `Review Result: pass` 또는 `Review Result: fail`을 써야 한다.
- review result 헤더가 없거나 다른 값이면 PipelineEngine의 output selector 해석 단계에서 검증 실패로 간주하고, 같은 session에 올바른 헤더로 다시 작성하라고 resume 요청한다. 이 재시도는 AgentRunner의 output-producing attempt budget을 사용한다.
- `context/docs/` snapshot은 task worktree가 보존되는 동안 함께 보존하고, worktree cleanup 시에만 삭제한다.

`## Slices` 형식:

```markdown
## Slices

- First implementation slice as one line
- Second implementation slice as one line
```

Review output 형식:

```markdown
Review Result: fail

## Findings

- ...
```

## Conductor와의 연계

- Conductor는 같은 `.forgeroom/` 디렉토리 읽기. `context/selected-forgemap.md`는 ForgeRoom이 staging한 selected ForgeMap manifest이고, `context/target-profile.md`는 selected ForgeMap에서 추출한 project profile snapshot이며, Conductor가 갱신하지 않는다. summary 갱신 시 `context/summary.md`, 피드백 통합 시 `context/feedback.md` write 만 허용
- Conductor 호출 전후 git status diff로 scope 검증
- `feedback.md`는 step output을 덮어쓰지 않는 별도 컨텍스트 문서이며, 다음 step prompt에 함께 포함
- `feedback.md`는 누적 문서다. prompt에는 `Pending for Next Step`과 최근 applied 항목만 포함해 길이를 제한한다.

`feedback.md` 권장 구조:

```markdown
# User Feedback

## Pending for Next Step
- ...

## Applied
- [step: 03_impl] ...
- [step: 04_review] ...
```

Pending 항목은 다음 step 직전 `integrateFeedback`에서 정리되고, 해당 step이 성공적으로 완료된 뒤 `Conductor.update`가 끝나면 `Applied`로 이동한다. step이 실패하면 pending 상태를 유지해 재시도 또는 사용자 판단에 남긴다.

## 큰 입력 전달 (input_refs)

큰 본문을 인라인으로 치환하면 프롬프트가 비대해진다. `input_refs`로 파일 경로만 전달하고, 프롬프트 내부에서 "read <path>" 지시:

```yaml
- id: slice_review
  intent: review_with_claude
  prompt_template: review_slice_diff.md
  input_refs:
    diff: ${slice_impl.diff_path}
```

`review_slice_diff.md` 템플릿:
```markdown
Review the implementation diff at {{diff}}.
Focus on correctness, edge cases, and adherence to AGENTS.md.
Write your review to .forgeroom/outputs/{{step_index}}_{{step_id}}.md.
```

`input_refs` 이름은 workflow 전체에서 같은 의미로 유지한다. review 대상은 `target`, 문서 refine의 기준 원본은 `original`, review output 전체 파일은 `review`, 단일 변경 diff는 `diff`, Task 전체 누적 diff는 `full_diff`를 사용한다.

MVP에서 `input_refs.review`는 review 파일 전체를 가리킨다. PipelineEngine은 `Review Result` 헤더만 구조화 파싱하고, findings/body는 refine agent가 파일을 직접 읽어 해석한다. findings schema와 부분 추출은 Forge Phase 2의 output contract 확장 후보로 둔다.

## 보안

- agent의 file write는 worktree 내부로 제한 (cwd 강제 + post-run path 검사)
- worktree 외부 변경 발견 시 WorktreeManager.revertOutside로 복원

## 관련 결정

- [ADR-004: 파일 기반 프롬프트 전달](../decisions/2026-05-21-004-file-based-prompt-passing.md)
- [ADR-014: ForgeMap을 MVP Project Context 기반으로 채택](../decisions/2026-05-22-014-forgemap-mvp-project-context.md)
