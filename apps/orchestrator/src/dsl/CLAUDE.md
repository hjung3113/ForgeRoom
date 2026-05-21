---
status: living
last_reviewed: 2026-05-21
---

# dsl/ Rules

작업 시작 전 [context-map.md](context-map.md)부터.

## 핵심 규칙

1. **순수 함수 우선**. 파서·보간기·평가기는 가능한 한 입력→출력 함수로
2. **외부 IO 금지**. 파일 읽기/쓰기는 호출자(core)가, dsl은 문자열·객체만 다룸
3. **에러 메시지에 라인/필드 명시**. yaml 위치 정보 보존
4. **fail-fast**. 누락 변수, 알 수 없는 step id 참조 → 즉시 에러

## 파일 단위

- `workflow-parser.ts` — yaml → ParsedWorkflow
- `variable-interpolator.ts` — `${...}` 치환
- `foreach.ts` — foreach 평가 (list 추출)
- `until.ts` — until 조건 평가
- `dsl-errors.ts` — 도메인 에러
- `types.ts`

## 금기

- 파일 시스템 접근 (core/WorktreeManager에 위임)
- LLM 호출 (Conductor 영역)
- core 모듈 import (방향: dsl → core 가능하지만 dsl이 core에 의존하는 게 가능한 한 적게)

## 체크리스트

- [ ] 단위 테스트로 변수 보간 케이스 커버
- [ ] yaml 라인 정보 보존했나
- [ ] 누락 변수 fail-fast 동작 확인
- [ ] foreach/until 한 path 끝까지 통과 테스트

## 상위 규칙

- [src/CLAUDE.md](../CLAUDE.md)
- [Workflow DSL 개념](../../../../Docs/concepts/workflow-dsl.md)
