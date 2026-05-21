---
status: decided
date: 2026-05-21
---

# ADR-009: Forge Phase와 Slice 용어 분리

## 배경

문서에서 `Phase`가 두 의미로 쓰이고 있었다.

- ForgeRoom 제품 개발 로드맵 단계: Phase 1 MVP, Phase 2, Phase 3
- 하나의 task 안에서 `foreach`로 반복 구현되는 작업 단위

동시에 Target Project 쪽 계획 단위도 Milestone / Phase / Issue / Slice처럼 표현될 수 있어, `Phase`를 계속 범용어로 쓰면 ForgeRoom 자체 로드맵과 Target Project 계획, workflow 반복 단위가 섞인다.

## 결정

ForgeRoom 제품 개발 로드맵 단계는 **Forge Phase**라고 부른다.

Target Project 쪽 큰 작업 구조를 논의할 때는 다음 용어를 후보로 쓴다.

- Milestone: Target Project의 큰 제품 목표나 릴리스 단위
- Project Phase: Target Project 안의 중간 계획 단위
- Issue: GitHub Issue 같은 외부 작업 항목
- Slice: 하나의 Task를 실행 가능한 작은 구현 단위로 나눈 것

ForgeRoom 내부 실행 단위는 **Task**로 유지한다. MVP에서 Task는 보통 하나의 Issue를 처리하지만, Task는 Issue 자체가 아니라 Branch / Worktree / PR / 실행 이력을 묶는 ForgeRoom runtime entity다.

처리 범위를 Issue보다 크게 확장하더라도 Task라는 실행 단위는 유지한다. Forge Phase 3에서는 Task 아래에 Project Phase / Slice 같은 workflow hierarchy를 둘 수 있는지 검토한다. 이 단계는 정해진 workflow를 강제하기 어렵기 때문에, 동적으로 workflow를 구성하는 방법까지 함께 설계해야 한다.

Workflow 내부 반복 구현 단위는 `Phase`가 아니라 **Slice**로 부른다.

- `## Phases` → `## Slices`
- `${task.final_phases}` → `${task.final_slices}`
- `${<step>.output.phases}` → `${<step>.output.slices}`
- `phase_impl` / `phase_review` / `phase_refine` → `slice_impl` / `slice_review` / `slice_refine`

로드맵은 다음처럼 조정한다.

- Forge Phase 1: MVP
- Forge Phase 2: 운영성·안전성·유연성
- Forge Phase 3: 처리 단위 확장. Task 아래 workflow hierarchy와 동적 workflow 구성 방식 검토
- Forge Phase 4: Desktop App + Tailscale

## 이유

- `Phase`의 의미 충돌을 제거한다.
- MVP의 Task 모델을 Issue에 과도하게 종속시키지 않는다. Discord 요청은 Issue가 아닐 수 있고, 같은 Issue를 여러 Task로 재실행할 수도 있다.
- Slice는 구현 반복 단위라는 의미가 선명하고, 기존 implementation plan의 수직 분할 언어와 맞는다.
- Desktop App과 Tailscale은 처리 단위 확장 이후에 붙이는 편이 자연스럽다.

## 결과

- Glossary에 Forge Phase / Milestone / Project Phase / Issue / Task / Slice / Final Slice List를 구분해 기록하되, Project Phase 이상 처리 방식은 Forge Phase 3 설계로 남긴다.
- Workflow DSL과 prompt-file protocol은 `## Slices`, `${task.final_slices}`, `${<step>.output.slices}`를 사용한다.
- 기존 Desktop App Phase 3 결정과 Tailscale Phase 3 결정은 이 ADR로 대체한다.

## 트레이드오프

- 기존 `phase_*` 예시와 legacy spec은 새 문서와 이름이 달라진다.
- `Docs/phases/` 폴더명은 당장 유지한다. 문서 경로 변경은 링크 churn이 크므로 별도 정리 시점에 다룬다.
