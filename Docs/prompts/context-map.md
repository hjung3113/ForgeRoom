# Prompts Context Map

## 책임

`Docs/prompts/`는 ForgeRoom 구현, 리뷰, 조율 작업에 사용할 에이전트 프롬프트 문서를 보관한다.

이 폴더의 문서는 실행 보조 산출물이며, canonical source가 아니다.

## 주요 파일

- `goal-feature-orchestration-prompt.md`: `goal` 기능 구현을 총괄 에이전트가 새 브랜치, TDD, 단계별 서브 오케스트레이터, 적대적 리뷰 루프로 진행하게 하는 실행 프롬프트.

## 같이 읽을 문서

- `../overview.md`
- `../architecture.md`
- `../phases/phase-1-mvp.md`
- `../modules/`
- `../concepts/`
- `../decisions/README.md`
- `../rules/doc-rules.md`

## 의존

- canonical 설계 문서: `Docs/overview.md`, `Docs/architecture.md`, `Docs/phases/phase-1-mvp.md`
- 모듈 상세: `Docs/modules/*.md`
- 결정 기록: `Docs/decisions/*.md`
- 문서 규칙: `Docs/rules/doc-rules.md`

## 진입 가이드

프롬프트를 수정할 때는 먼저 대상 에이전트의 역할과 출력 계약을 확인한다. 설계 의미가 바뀌는 내용은 이 폴더에서만 반영하지 말고 ADR과 원본 문서 변경으로 처리한다.
