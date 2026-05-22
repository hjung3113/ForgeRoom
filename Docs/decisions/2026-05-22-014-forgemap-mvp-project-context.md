---
status: decided
date: 2026-05-22
---

# ADR-014: ForgeMap을 MVP Project Context 기반으로 채택

## 배경

기존 문서는 `Target Profile`을 ForgeRoom이 관리하는 canonical 문서로 정의하고, task 실행 시 `.forgeroom/context/target-profile.md`로 staging한다고 설명한다. 그러나 Target Project의 실제 이해에는 한 장짜리 요약으로 충분하지 않다.

프로젝트 구조, 도메인 개념, 모듈 책임, 명령, 테스트 전략, 위험 영역, ADR은 서로 다른 갱신 주기와 소비자를 가진다. 이를 하나의 markdown 요약으로 합치면 오래된 정보와 과도한 압축이 누적된다.

## 결정

MVP에 `ForgeMap`을 도입한다.

ForgeMap은 Target Project를 이해하기 위한 canonical project context 저장소다. 여러 markdown 문서와 최소 구조화 index를 함께 사용하며, task 시작 시 필요한 subset만 Runtime Context로 staging한다. MVP도 markdown-only가 아니며, `forgemap.yaml` registry와 `symbols/*.json` index를 필수 산출물로 둔다.

MVP `symbols/*.json`은 graph가 아니라 deterministic selection hints다. ContextSelector는 name, alias, path, keyword, dependency, risk tag 기반으로 subset을 고르고, ranking이나 semantic retrieval은 Phase 2로 둔다. 자동 확장은 direct match와 명시적 1-hop `depends_on`까지만 허용한다.

Context widening은 hard signal reason을 기록해야 한다. 이는 enum 밖의 확장을 영구 금지하려는 규칙이 아니라, MVP에서 이유 없는 추측 확장을 막기 위한 감사 단위다.

ForgeMap은 `forgemap.yaml`에 Target Project의 `indexed_commit`, `indexed_dirty`, `indexed_at`을 기록한다. PipelineEngine은 task start에서 stale check를 반드시 수행하고, stale한 ForgeMap 위에서 ContextSelector를 실행하지 않는다.

`Target Profile`은 ForgeMap 전체가 아니라 task 실행 시점에 선택된 project context snapshot 중 하나로 재정의한다.

ForgeMap selection, stale check, dirty baseline, selection log는 이 ADR의 세부 운영 정책으로 유지한다. graph/RAG/llmwiki 도입처럼 새로운 irreversible trade-off가 생길 때는 별도 ADR을 작성한다.

ForgeMapRefresher는 local doc/path metadata 변경은 partial refresh할 수 있지만, architecture/module boundary/dependency/ADR/glossary/workflow/security policy 변경은 pending rebuild로 분류한다.

## 이유

- MVP의 agent 실행 품질은 Target Project 이해도에 직접 좌우된다.
- ContextProvider/RAG를 Phase 2로 미루더라도, 그 기반이 되는 project context substrate는 MVP에 필요하다.
- 한 장 요약 대신 목적별 문서와 구조화 index를 분리해야 갱신과 검증이 가능하다.
- Conductor가 canonical project knowledge를 즉석에서 고치는 구조를 피한다.

## 결과

- `ForgeMapStore`: 프로젝트별 map 파일 보관
- `ForgeMapBuilder`: 최초 map 생성
- `ForgeMapRefresher`: 변경 파일 기준 부분 갱신
- `ContextSelector`: task 시작 시 관련 map subset을 `.forgeroom/context/`에 staging
- Conductor는 staged context를 읽어 prompt를 보강하지만 ForgeMap canonical source를 직접 수정하지 않는다.

## 비범위

- vector DB
- llmwiki/graph query engine
- 사내 wiki/Jira/Confluence ingestion
- issue/PR history 기반 RAG
- 공식 문서 web indexing
- 자동 승인 없는 대규모 map rewrite
