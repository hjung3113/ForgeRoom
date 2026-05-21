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
│   ├── summary.md           # Conductor 누적 요약
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
└── logs/
    ├── 01_design.stdout
    ├── 01_design.stderr
    └── check_test.stderr
```

파일명 규칙: `NN_<step_id>.md` 또는 `NN_<step_id>.<iteration>.md`. NN은 zero-pad 2자리 step 인덱스.

## Step 실행 흐름

```
1. WorktreeManager가 worktree + .forgeroom/ 초기화 (task 시작 1회)
2. PipelineEngine: 다음 step 선택
3. 템플릿 로드 (templates/<prompt_template>)
4. 변수 보간 (${...} 치환)
5. Conductor.refine(task_id, step_id, base_prompt) → 보강 프롬프트
6. .forgeroom/prompts/NN_<step_id>.md 에 저장
7. AgentRunner.run({
     agentId, promptPath, outputPath,
     cwd: worktree, mode: 'headless'
   })
   OpenClaw 메시지:
     "Read .forgeroom/prompts/NN_<step_id>.md and follow it.
      Write your response to .forgeroom/outputs/NN_<step_id>.md."
8. 종료 검증:
   - exists(outputPath) && size >= MIN_BYTES?
   - 실패 시 attempt++. attempt < MAX_RETRY (2):
       resume 호출로 출력 파일 작성 재요청
   - MAX_RETRY 초과: step.status=failed
9. git diff → diffs/NN_<step_id>.diff 저장
10. step.status=done
11. Conductor.update(task_id, stepResult) — 동기 호출
12. Reporter.notify(step_done) — 비동기 (events 테이블 우선 기록)
```

## 검증 규칙

- output 파일 미존재 → 실패로 간주, resume
- 파일 크기 < 50 bytes → 실패로 간주, resume
- 내용에 명백한 거부 응답("Sorry I cannot...", "에러:") 만 있으면 step.status=failed (MVP는 정규식 휴리스틱)

## Conductor와의 연계

- Conductor는 같은 `.forgeroom/` 디렉토리 읽기. summary 갱신 시 `context/summary.md` write 만 허용
- Conductor 호출 전후 git status diff로 scope 검증

## 큰 입력 전달 (input_refs)

큰 본문을 인라인으로 치환하면 프롬프트가 비대해진다. `input_refs`로 파일 경로만 전달하고, 프롬프트 내부에서 "read <path>" 지시:

```yaml
- id: phase_review
  agent: claude
  prompt_template: review.md
  input_refs:
    diff: ${phase_impl.diff_path}
```

`review.md` 템플릿:
```markdown
Review the implementation diff at {{diff}}.
Focus on correctness, edge cases, and adherence to AGENTS.md.
Write your review to .forgeroom/outputs/{{step_index}}_{{step_id}}.md.
```

## 보안

- agent의 file write는 worktree 내부로 제한 (cwd 강제 + post-run path 검사)
- worktree 외부 변경 발견 시 WorktreeManager.revertOutside로 복원

## 관련 결정

- [ADR-004: 파일 기반 프롬프트 전달](../decisions/2026-05-21-004-file-based-prompt-passing.md)
