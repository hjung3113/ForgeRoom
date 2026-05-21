---
status: decided
last_reviewed: 2026-05-21
---

# 네이밍 룰

## 파일·폴더

- 폴더: `kebab-case` (`pipeline-engine`, `agent-runner`)
- TS 소스 파일: `kebab-case.ts` (`pipeline-engine.ts`)
- 테스트 파일: `<원본>.test.ts` (`pipeline-engine.test.ts`)
- 인터페이스 전용 파일: `types.ts` (해당 폴더의 외부 노출 타입 모음)
- 마크다운 문서: `kebab-case.md`
- ADR: `YYYY-MM-DD-NNN-<slug>.md`
- Plan: `YYYY-MM-DD-<feature-name>.md`
- Review: `YYYY-MM-DD-<topic>-review.md`

## 식별자

| 종류 | 규칙 | 예시 |
|---|---|---|
| 변수·함수 | `camelCase` | `taskStore`, `createWorktree` |
| 클래스·인터페이스·타입 | `PascalCase` | `PipelineEngine`, `TaskMeta` |
| 상수 | `SCREAMING_SNAKE_CASE` | `MAX_RETRY`, `MIN_OUTPUT_BYTES` |
| 환경변수 | `SCREAMING_SNAKE_CASE` | `DISCORD_BOT_TOKEN` |
| Enum 멤버 | `PascalCase` | `TaskStatus.Running` |
| 파일·디렉토리 경로 변수 | suffix `Path` | `worktreePath`, `outputPath` |
| boolean | `is/has/should/can` 접두 | `isPaused`, `hasIssue` |
| 비동기 함수 | 동사 시작 | `loadWorkflow`, `runStep` |

## yaml 키

- `snake_case` (예: `default_workflow`, `allowed_workflows`)
- yaml 안에서 일관성 우선. JS 측에서 mapper로 변환 가능

## 데이터베이스

- 테이블: `snake_case` 복수 (`tasks`, `steps`, `events`)
- 컬럼: `snake_case`
- 인덱스: `idx_<table>_<columns>`
- 외래키: `<referenced>_id` (`task_id`)

## 워크플로우 DSL

- 워크플로우 id: `snake_case` (`quick`, `full`, `slice_impl`)
- step id: `snake_case`
- agent id: `snake_case` 또는 한 단어 (`claude`, `codex`, `gemini`)

## 에러 클래스

- 끝에 `Error` 접미: `WorkflowParseError`, `AgentTimeoutError`
- 도메인별 base: `OrchestratorError` extends `Error`

## 이벤트 타입

- `snake_case` 동사_명사 또는 명사_상태: `task_started`, `step_done`, `check_result`, `pr_created`, `task_failed`

## 금기

- 의미 없는 약어 (`mgr`, `svc`, `tmp` 단독). 단 표준 약어 `id`, `url`, `db`, `api`는 허용
- 한국어 + 영어 혼용 식별자
- 단일 문자 변수 (loop counter `i`, `j` 제외)
- 동음이의어 (`Step` = 워크플로우 단계 AND DB row. 별칭 분리: `StepDefinition` vs `StepRow`)

## ForgeRoom 도메인 용어 매핑 (필독)

| 도메인 | 코드 |
|---|---|
| 워크플로우 정의 (yaml) | `WorkflowDefinition` / `ParsedWorkflow` |
| 워크플로우 step 정의 | `StepDefinition` / `ParsedStep` |
| 실행 중인 task | `Task` / `TaskRow` |
| 실행 중인 step | `StepRun` / `StepRow` |
| 큐 대기 작업 | `QueuedTask` |
| OpenClaw runtime 식별자 | `runtimeId` (string) |
| agents.yaml의 키 | `agentId` (string) |
