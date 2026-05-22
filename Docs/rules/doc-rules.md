---
status: decided
last_reviewed: 2026-05-21
---

# 문서 룰

## 문서 종류와 역할

| 종류 | 위치 | 역할 |
|---|---|---|
| overview | `Docs/overview.md` | 진입점, 비전, 핵심 원칙 |
| architecture | `Docs/architecture.md` | 시스템 다이어그램, 모듈 목록 |
| 모듈 spec | `Docs/modules/<name>.md` | 단일 모듈 책임·인터페이스·에러 |
| 횡단 개념 | `Docs/concepts/<topic>.md` | DSL, 데이터 모델, 프로토콜 |
| 운영 정책 | `Docs/policies/<topic>.md` | 보안, 에러, 동시성, 승인 |
| Phase scope | `Docs/phases/phase-<n>.md` | 단계별 범위·완료 정의 |
| ADR | `Docs/decisions/YYYY-MM-DD-NNN-<slug>.md` | 단일 결정 + 이유 |
| 룰 | `Docs/rules/<name>.md` | 코딩·문서·테스트 등 규칙 |
| Plan | `Docs/plans/YYYY-MM-DD-<feature>.md` | 구현 계획 |
| Review | `Docs/reviews/YYYY-MM-DD-<topic>-review.md` | 리뷰 기록 |
| Open Questions | `Docs/open-questions.md` | 미해결 항목 누적 |
| Glossary | `Docs/glossary.md` | 용어 사전 |

## Front-matter

모든 markdown 문서 (인덱스·룰·legacy 포함) 상단에 둠:

```yaml
---
status: draft | proposed | decided | superseded | living | planned
last_reviewed: YYYY-MM-DD
supersedes: <relative-path>      # optional
superseded_by: <relative-path>   # optional
---
```

상태 의미:
- `draft`: 작성 중, 변경 가능성 큼
- `proposed`: 작성 완료, 사용자 승인 대기
- `decided`: 승인됨, 후속 변경은 ADR 동반 필요
- `superseded`: 새 문서로 대체됨
- `living`: 지속 갱신 (`open-questions`, `glossary`, ADR 인덱스 등)
- `planned`: 미래 Phase 계획

## 변경 워크플로우

### 작은 수정 (오타·링크·표현)

- 직접 수정 + 같은 커밋
- ADR 불필요

### 의미 있는 변경 (인터페이스·정책·범위)

1. ADR 작성: `status: proposed`
2. 본 대화에서 사용자 승인 받음
3. ADR `status: decided` 변경 + `date` 갱신
4. 영향받는 spec/module 문서 동시 갱신 (같은 커밋)
5. 이전 결정이 무효화된다면 그 ADR `status: superseded` + `superseded_by` 설정

### 새 결정사항 발생

- 새 ADR 추가 + `Docs/decisions/README.md` 인덱스 갱신
- 영향받는 문서 갱신

### Open Question 해결

- `open-questions.md`에서 `상태 = resolved` + 출처(ADR 또는 PR) 명시
- 항목 자체는 삭제하지 말고 보존

## 작성 원칙

- 한국어. 코드/명령/식별자는 영어 그대로
- 한 문서 = 한 주제. 관계된 다른 문서는 링크
- placeholder 금지 (`TBD`, `TODO`, `fill later`)
- 코드/명령은 fenced code block에 언어 태그
- 다이어그램: ASCII 또는 mermaid (Phase 2부터)
- 길이 상한: 모듈 spec ~400줄, 다른 문서는 자유. 길어지면 분할

## Context Budget

문서 작업은 필요한 근거만 좁게 읽는다.

- `Docs/_legacy/**`는 사용자가 요청하거나 과거 결정의 원문이 필요한 경우에만 검색한다.
- repo-wide 검색은 먼저 `Docs/_legacy/**`를 제외하고 실행한다.
- 긴 문서는 전체를 반복해서 열지 말고 관련 heading, 표, 인터페이스 주변만 읽는다.
- 같은 파일 재확인은 전체 출력보다 `rg -n`으로 바뀐 용어와 링크를 점검한다.
- 여러 긴 문서를 병렬로 raw 출력하지 않는다. 먼저 후보 파일을 좁히고 필요한 섹션만 읽는다.
- 대량 비교·링크 점검·용어 검색은 스크립트로 결과만 출력한다.

## 링크 규칙

- 상대경로 사용 (`../modules/pipeline-engine.md`)
- 외부 링크는 명확한 도메인만
- broken link 방지: PR/커밋 전에 grep으로 점검 권장 (Phase 2에서 자동화)

## Context Map

각 코드 폴더에 `context-map.md`. 룰은 [folder context-map 컨벤션](context-map-rules.md) 참고.

## 관련

- [doc 폴더 구조](../overview.md#시스템-구성)
- [ADR 인덱스](../decisions/README.md)
