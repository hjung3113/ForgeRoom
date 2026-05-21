---
status: decided
date: 2026-05-21
---

# ADR-011: CheckRunner는 execute kind 직후에만 실행

## 배경

MVP workflow에는 plan, review, refine, execute step이 섞여 있다. CheckRunner가 어느 step 뒤에 실행되는지 명확하지 않으면 review가 깨진 빌드 상태를 검토하거나, 문서 전용 step 뒤에 불필요한 test/lint/typecheck가 반복될 수 있다.

후보:

- **A) 모든 step 뒤에 checks 실행**
- **B) workflow 끝에서만 checks 실행**
- **C) `kind: execute` step 직후에만 checks 실행**

## 결정

**C) `kind: execute` step 직후에만 CheckRunner를 실행한다.**

`kind: write_plan`, `kind: review`, 문서 보강용 `kind: refine` step은 checks를 실행하지 않는다. `review_loop.refine`이 `kind: execute`이면 매 refine cycle 뒤 checks를 실행한다.

## 이유

- 코드 변경 직후에만 검증하므로 불필요한 check 실행을 줄인다.
- review는 checks를 통과한 diff를 대상으로 판단한다.
- plan/review 문서 작업과 코드 품질 게이트를 분리한다.
- `Intent Kind`를 품질 게이트 정책에만 사용하고, agent 선택은 Intent id와 agent 설정에 남긴다.

## 결과

- PipelineEngine은 Resolved Step의 `kind`가 `execute`인지 보고 CheckRunner 호출 여부를 결정한다.
- checks 자동 수정이 성공하면 같은 execute step의 diff는 자동 수정 결과까지 포함한다.
- CheckRunner 실패 후 재시도에도 실패하면 task.status=failed가 된다.

## 트레이드오프

- 문서 변경만 하는 workflow에서는 checks가 돌지 않는다. 문서 검증이 필요하면 Forge Phase 2에서 별도 doc check command 또는 workflow policy를 검토한다.
- `kind`가 실행 정책에 일부 영향을 주므로 Intent Catalog validation과 문서가 이 계약을 명확히 유지해야 한다.
