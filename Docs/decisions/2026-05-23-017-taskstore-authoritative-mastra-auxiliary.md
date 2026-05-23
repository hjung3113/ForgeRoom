---
status: decided
date: 2026-05-23
---

# ADR-017: TaskStore step row = 권위 상태, Mastra snapshot = 보조

## 배경

ADR-015로 Mastra workflow primitives를 도입하면 task 실행 중 상태가 두 곳에 존재한다:
- ForgeRoom TaskStore (SQLite): task row, step rows, events, conductor_state, attempt budget, check_status, diff_path
- Mastra workflow run snapshot: workflow run id, suspended step id, step input/output, control flow state

`recoverPending()`이 어느 쪽을 권위로 보고 다음 step을 결정할지가 모호하면 restart 후 step 중복 실행이나 누락이 발생한다.

## 결정

**TaskStore step row가 권위. Mastra snapshot은 보조 (재구성 가능)다.**

세부 규칙:

1. **다음 step 결정 권한**: `recoverPending()`은 TaskStore의 `tasks.status`, 마지막 `steps` row, control step의 `iteration`/`parent_step_id`를 기준으로 "다음에 실행할 step"을 정한다. Mastra snapshot은 이 결정에 영향을 주지 않는다.

2. **resume 경로 (hybrid)**:
   - TaskStore가 가리키는 다음 step이 Mastra suspended run의 다음 step과 일치하고, Mastra run id가 유효하면 → Mastra `run.resume()` 호출.
   - 불일치하거나 Mastra run id 부재(예: 프로세스 재시작 후 in-memory cache 손실)면 → TaskStore의 next-step pointer로 **신규 Mastra run 시작** 후 진행. yaml workflow와 TaskStore step rows로 신규 run을 동일 상태로 재구성한다.

3. **.forgeroom/ 파일 일관성 우선**: Mastra snapshot이 가리키는 step output과 `.forgeroom/outputs/NN_<step_id>.md` 파일이 불일치하면 파일이 권위. Mastra snapshot을 폐기하고 TaskStore pointer로 신규 run을 시작한다.

4. **Conductor 파일**: `.forgeroom/context/summary.md`, `feedback.md`도 권위 상태다. Mastra Memory는 사용하지 않는다. Conductor.update는 Mastra suspend 이전에 동기 완료해야 한다(ADR-016).

5. **Mastra run id 저장**: TaskStore의 task row에 `mastra_run_id` nullable 컬럼 추가. recoverPending이 resume 경로 선택에 사용한다. Null이면 신규 run 경로.

6. **terminology 분리 (glossary)**:
   - `resume(a)` AgentRunner: 같은 OpenClaw session 이어 호출
   - `resume(b)` PipelineEngine: paused task 재개 (사용자 향 의미)
   - `resume(c)` Mastra workflow run: 어댑터 내부의 framework-level resume. 문서에서는 "Mastra run resume" 또는 "workflow-run resume"으로 명시.

## 결과

- TaskStore migration 추가: `tasks.mastra_run_id TEXT NULL`.
- `recoverPending()` 알고리즘 갱신: TaskStore 우선 → Mastra resume 또는 신규 run 분기.
- 통합 테스트: process kill → restart → recoverPending이 (a) 신규 run, (b) snapshot resume 두 케이스 모두 동일 외부 결과를 내야 함.
- Mastra snapshot은 디버깅/시각화/Studio 트레이스 용도로만 신뢰하며, 권위 비교는 항상 TaskStore + `.forgeroom/`를 기준으로 한다.

## 관련

- ADR-002 SQLite + Drizzle (TaskStore 기반)
- ADR-005 Conductor 메타 에이전트 (파일 권위 유지)
- ADR-015 Mastra workflow primitives 채택
- ADR-016 yaml DSL → Mastra workflow 어댑터
- `Docs/modules/pipeline-engine.md` (recoverPending 알고리즘)
- `Docs/modules/conductor.md` (Conductor.update 시점)
- `Docs/concepts/prompt-file-protocol.md` (파일 권위)
