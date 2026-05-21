---
status: decided
last_reviewed: 2026-05-21
---

# Context Map 룰

각 코드 폴더는 진입 시 LLM/사람이 가장 먼저 읽는 `context-map.md`를 둔다. CLAUDE.md(규칙)와 역할 분리.

## 역할 분리

| 파일 | 역할 |
|---|---|
| `<folder>/CLAUDE.md` | 이 폴더 작업 시 따라야 할 **규칙·금기·체크리스트** |
| `<folder>/context-map.md` | 이 폴더에 **무엇이 있는지, 어떤 문서를 같이 읽어야 하는지** |

## context-map.md 구조 (템플릿)

```markdown
---
status: living
last_reviewed: YYYY-MM-DD
---

# <folder-name> Context Map

## 책임

(이 폴더가 담당하는 영역 1-2문장)

## 주요 파일

| 파일 | 역할 |
|---|---|
| `foo.ts` | ... |
| `bar.ts` | ... |

## 같이 읽을 문서

- [모듈 spec](../../../../Docs/modules/<name>.md)
- [관련 개념](../../../../Docs/concepts/<topic>.md)
- [관련 ADR](../../../../Docs/decisions/<file>.md)

## 의존

- 외부 패키지: ...
- 다른 폴더: `core/`, `db/` ...

## 진입 가이드

(처음 이 폴더 작업 시 무엇부터 보면 좋을지 1-3개 포인터)
```

## CLAUDE.md 구조 (템플릿)

```markdown
---
status: living
last_reviewed: YYYY-MM-DD
---

# <folder> Rules

작업 시작 전 [context-map.md](context-map.md)부터 읽어라.

## 이 폴더의 핵심 규칙

1. ...
2. ...

## 금기

- ...

## 체크리스트 (PR 전)

- [ ] ...
- [ ] ...

## 상위 규칙

이 폴더에만 해당하지 않는 규칙은 다음 참조:
- [전역 코딩 룰](../../../../Docs/rules/coding-rules.md)
- [네이밍](../../../../Docs/rules/naming-rules.md)
- [테스트](../../../../Docs/rules/testing-rules.md)
```

## 작성 시점

- 폴더 생성과 동시에 두 파일 작성 (빈 placeholder OK)
- 파일/모듈 추가 시 context-map의 "주요 파일" 표 갱신
- 폴더 책임이 바뀌면 둘 다 갱신
- 폴더 삭제 시 두 파일 함께

## 길이 가이드

- context-map: 100줄 이내 권장
- CLAUDE.md: 80줄 이내 권장
- 길어지면 root rules로 끌어올리기 검토
