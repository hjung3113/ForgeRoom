# wiki Context Map

## 책임

`Docs/wiki/`는 ForgeRoom 설계 문서를 사람이 빠르게 검토할 수 있도록 재구성한 파생 산출물을 보관한다.

## 주요 파일

- `mvp-review.html`: Forge Phase 1 MVP를 한 번에 훑어보기 위한 단일 HTML wiki.

## 같이 읽을 문서

- `../overview.md`
- `../architecture.md`
- `../phases/phase-1-mvp.md`
- `../modules/`
- `../concepts/`
- `../decisions/README.md`

## 의존

- canonical 설계 문서: `Docs/overview.md`, `Docs/architecture.md`, `Docs/phases/phase-1-mvp.md`
- 모듈 상세: `Docs/modules/*.md`
- 결정 기록: `Docs/decisions/*.md`

## 진입 가이드

리뷰용 HTML을 수정할 때는 먼저 canonical 문서의 현재 상태를 확인한다. 의미 있는 설계 변경은 이 폴더에서만 반영하지 말고 ADR과 원본 문서 변경으로 처리한다.
