---
status: decided
date: 2026-05-21
---

# ADR-010: Review/refine 반복은 review_loop로 표현

## 배경

MVP workflow 예시는 `refine` step에 `until: ${review.passed}`를 붙여 review가 통과할 때까지 반복하려 했다. 그러나 이 구조는 refine을 반복해도 `review.passed`가 새로 계산되지 않아 조건이 갱신되지 않는다.

후보:

- **A) `type: run`에 `until` 유지**: 단일 step을 조건까지 재실행
- **B) review와 refine을 명시적으로 묶는 `review_loop` 도입**
- **C) `when`/branching DSL을 먼저 도입해 loop를 조합**

## 결정

**B) `review_loop` 도입.**

`review_loop`는 `review`를 실행하고, `until: ${<review.id>.passed}`가 거짓이면 `refine`을 실행한 뒤 다시 `review`한다. `max_iterations`는 refine cycle 최대 횟수다.

## 이유

- review pass/fail 값이 매 cycle 새로 계산된다.
- review/refine 쌍이라는 도메인 의도가 DSL에 직접 드러난다.
- MVP에 범용 branching을 넣지 않고도 quick, full, slice quality loop를 표현할 수 있다.

## 결과

- MVP DSL의 제어 흐름은 `foreach`, `review_loop`, `pause_after` 중심이 된다.
- `type: run`의 단일 step `until` 반복은 MVP에서 제외하고 Forge Phase 2 검토 항목으로 둔다.
- `review_loop`의 `until`은 `${<review.id>.passed}` 형식만 허용한다.

## 트레이드오프

- DSL type이 하나 늘어나지만, 범용 조건 분기보다 검증과 설명이 단순하다.
- review/refine 외 반복에는 바로 쓸 수 없다. 그런 반복이 필요하면 Forge Phase 2에서 별도 DSL 확장을 검토한다.
