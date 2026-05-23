---
status: decided
last_reviewed: 2026-05-22
---

# ForgeMap

## 책임

- Target Project의 canonical project context를 ForgeRoom 내부에 보관
- 최초 온보딩 시 project structure, docs, commands, tests, ADR, 주요 모듈을 map으로 생성
- task 시작 시 관련 map subset을 Runtime Context로 staging
- task 종료 후 변경된 파일 기준으로 map 갱신 필요 여부를 판단

ForgeMap은 한 장짜리 요약이 아니다. 목적별 markdown 문서와 agent selection용 최소 구조화 index를 함께 쓰는 project context substrate다. MVP도 markdown-only가 아니며, `forgemap.yaml` registry와 `symbols/*.json` index를 필수 산출물로 둔다.

## 저장 위치

```
~/forgeroom/maps/<project_id>/
├── forgemap.yaml
├── project-profile.md
├── architecture-map.md
├── module-index.md
├── dependency-map.md
├── command-map.md
├── testing-map.md
├── risk-map.md
├── decisions-index.md
├── folders/
│   └── <folder_id>.md
└── symbols/
    └── <module_id>.json
```

## 문서 역할

| 파일 | 역할 |
|---|---|
| `forgemap.yaml` | map version, source repo, indexed revision, generated_at, document registry, structured index version |
| `project-profile.md` | 제품/도메인/운영 방식의 상위 개요 |
| `architecture-map.md` | 런타임 경계, 데이터 흐름, 외부 의존성 |
| `module-index.md` | 모듈 책임, 소유 파일, 같이 읽을 문서 |
| `dependency-map.md` | 패키지, 내부 import 관계, 외부 서비스 |
| `command-map.md` | dev/test/lint/typecheck/build 명령과 실패 해석 |
| `testing-map.md` | 테스트 종류, fake/mock 경계, e2e 조건 |
| `risk-map.md` | 위험 영역, known issues, 데이터/보안 주의점 |
| `decisions-index.md` | ADR과 주요 결정 링크 |
| `folders/*.md` | folder-level context map |
| `symbols/*.json` | ContextSelector가 검색/선택하기 위한 machine-readable index. 나중에 graph/RAG source로 승격 가능해야 한다 |

## Structured index

MVP `symbols/*.json`은 graph가 아니라 deterministic selection hints다. ContextSelector는 name, alias, path, keyword, dependency, risk tag 기반으로 subset을 고른다.

MVP ContextSelector는 direct match와 명시적 1-hop `depends_on`만 자동 포함한다. 2-hop 이상 확장은 Conductor sanity check, user feedback, failed check 같은 hard signal이 있을 때만 허용한다.

Hard signal은 자동 context 확장의 감사 가능한 reason이다. enum 밖의 확장을 영구 금지하는 규칙이 아니라, MVP에서 이유 없는 추측 확장을 막기 위한 기록 단위다. 사용자 명시 요청은 `user_feedback_request`로 기록하고 확장할 수 있다.

MVP hard signal:

```typescript
type ContextExpansionReason =
  | 'referenced_path'
  | 'matched_symbol'
  | '1hop_depends_on'
  | 'matched_glossary_term'
  | 'matched_adr'
  | 'workflow_kind_requires_rule'
  | 'failed_check'
  | 'user_feedback_request'
  | 'conductor_scope_mismatch'
```

최소 필드:

```typescript
type ForgeMapSymbol = {
  id: string
  kind: 'module' | 'folder' | 'command' | 'adr' | 'rule' | 'concept' | 'external_dependency'
  name: string
  aliases: string[]
  source_paths: string[]
  owned_paths: string[]
  related_docs: string[]
  keywords: string[]
  depends_on: string[]
  risk_tags: string[]
}
```

## Source revision

`forgemap.yaml`은 Target Project의 indexed revision을 기록한다.

```yaml
source:
  repo_path: /absolute/path/to/repo
  default_branch: main
  indexed_commit: abc123
  indexed_dirty: false
  indexed_at: 2026-05-22T00:00:00Z
```

PipelineEngine은 task start에서 ForgeMap stale check를 반드시 수행한다.

- `indexed_commit`이 current HEAD와 같고 dirty change가 없으면 기존 ForgeMap을 사용한다.
- HEAD만 바뀌고 dirty change가 없으면 `ForgeMapRefresher.planRefresh` 후 진행한다.
- dirty change가 있으면 provenance가 약하므로 task start를 기본 중단한다.
- 사용자가 명시적으로 dirty baseline 진행을 승인하면 `indexed_dirty: true`로 refresh/selection을 허용하고, Runtime Context artifact에 dirty baseline임을 기록한다.
- 큰 구조 변경 또는 오래된 ForgeMap이면 refresh/rebuild 대상으로 남긴다.

## Refresh classification

`ForgeMapRefresher`는 local doc/path metadata 변경은 partial refresh할 수 있다.

Partial refresh 후보:

- 새 파일 추가
- folder context map 갱신
- command/test/lint/typecheck 항목 갱신
- module owned_paths 보강
- known issue 또는 risk note 추가

Pending rebuild 후보:

- architecture-map 영향
- module boundary 변경
- dependency-map의 service/package boundary 변경
- ADR 추가/수정/폐기
- glossary/domain term 변경
- workflow DSL semantics 변경
- security/approval policy 변경

Pending rebuild 상태에서는 modification workflow를 기본 중단한다. read-only ask/investigation workflow는 warning artifact를 남기고 진행할 수 있다. Maintainer approval이 있으면 dirty baseline과 같은 방식으로 stale context 진행을 허용하되, `selected-forgemap.md`에 pending rebuild warning과 승인 사실을 기록한다.

## 인터페이스

```typescript
interface ForgeMapStore {
  get(projectId: string): Promise<ForgeMapRef | null>
  save(projectId: string, map: ForgeMapDraft): Promise<ForgeMapRef>
}

interface ForgeMapBuilder {
  build(projectId: string): Promise<ForgeMapRef>
}

interface ForgeMapRefresher {
  planRefresh(taskId: string): Promise<ForgeMapRefreshPlan>
  applyRefresh(plan: ForgeMapRefreshPlan): Promise<ForgeMapRef>
}

interface ContextSelector {
  selectForTask(task: Task): Promise<SelectedForgeMap>
  stageForTask(task: Task, selection: SelectedForgeMap): Promise<RuntimeContextPaths>
}
```

## 생성 시점

1. **Project onboarding**: 프로젝트 등록 후 `ForgeMapBuilder.build`로 최초 map 생성
2. **Task start**: `ContextSelector`가 task title, description, workflow, changed refs를 기준으로 initial map subset을 staging
3. **Pre-run context check**: 첫 `AgentRunner.run` 전에 Conductor가 staged context를 sanity check한다. 명확한 누락 또는 scope mismatch가 있으면 `ContextSelector`가 1회 expand/reselect할 수 있다.
4. **Task finish**: diff와 변경 파일을 기준으로 `ForgeMapRefresher.planRefresh` 실행. 작은 변경은 부분 갱신하고, 큰 구조 변경은 사용자 확인 대상으로 남긴다.

## Runtime Context staging

Task worktree에는 전체 ForgeMap을 복사하지 않는다.

```
<worktree>/.forgeroom/context/
├── task.md
├── selected-forgemap.md
├── target-profile.md
├── docs/
│   └── ... selected source docs snapshot copies
├── summary.md
├── feedback.md
└── workflow.md
```

`selected-forgemap.md`는 현재 task에 필요한 ForgeMap subset manifest다. `target-profile.md`는 selected context 중 상위 project profile snapshot이다.

`ContextSelector.stageForTask`는 selected source docs를 `.forgeroom/context/docs/` 아래 snapshot copy로 staging하고, `selected-forgemap.md`에는 그 readable staged path를 기록한다. Symlink는 sandbox와 portable artifact 측면에서 쓰지 않는다.

`selected-forgemap.md`는 included docs의 readable path, short summary, selection log, source warning만 담는다. selected doc 원문은 `.forgeroom/context/docs/`에 snapshot copy로 보관하고, manifest 안에 전체 내용을 inline으로 복사하지 않는다. 각 included doc은 `ContextExpansionReason`과 signal value를 기록해, task artifact만으로 왜 해당 context가 포함됐는지 재현할 수 있어야 한다.

Runtime Context snapshot docs는 task worktree가 보존되는 동안 함께 보존한다. Worktree cleanup 시에만 삭제하며, 장기 archive/export는 Forge Phase 2로 둔다.

dirty baseline으로 진행한 task는 `selected-forgemap.md`에 source revision과 dirty baseline 승인 사실을 기록해야 한다.

예:

```markdown
## Selection Log

| Included | Reason | Signal |
|---|---|---|
| modules/discord-gateway.md | matched_symbol | DiscordGateway |
| modules/reporter.md | 1hop_depends_on | DiscordGateway -> ReporterSink |
| policies/security.md | workflow_kind_requires_rule | execute |
```

## 경계

- Conductor는 staged context를 읽을 수 있지만 canonical ForgeMap을 직접 수정하지 않는다.
- Conductor는 첫 agent 실행 전 staged context의 누락과 scope mismatch를 검사할 수 있다. 이 검사는 Runtime Context 보정만 요청하며 canonical ForgeMap을 수정하지 않는다.
- PipelineEngine은 ContextSelector가 staging한 파일 경로만 prompt rendering에 연결한다.
- Target Project repo에 ForgeMap을 기본 커밋하지 않는다. repo 안의 기존 `context-map.md`는 ForgeMapBuilder의 입력으로 사용할 수 있다.

## MVP 제한

- vector DB 없음
- llmwiki/graph query engine 없음
- 외부 wiki/ticket/document ingestion 없음
- issue/PR history RAG 없음
- 자동 대규모 rewrite 없음

## 구현

- MVP `ForgeMapStager`는 `apps/orchestrator/src/core/forgemap.ts`의 `ForgeMapStagerImpl`이 구현한다. PipelineEngine의 `ForgeMapStager` seam(`stage({ taskId, worktreePath, projectId })`)을 그대로 채우며, canonical store / target-repo state probe / per-task selection signal은 생성자 DI로 주입한다.
- stale/dirty 차단은 `Promise<void>` seam 위에서 typed error로 신호한다: dirty baseline 미승인은 `ForgeMapStaleError`, pending rebuild에서 미승인 modification workflow는 `ForgeMapPendingRebuildError`.

## 관련 결정

- [ADR-014](../decisions/2026-05-22-014-forgemap-mvp-project-context.md)
