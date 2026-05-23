---
status: living
last_reviewed: 2026-05-21
---

# Open Questions

미해결 또는 후속 검토 항목 누적.

| ID | 항목 | 영향 | 차단 여부 | 상태 |
|---|---|---|---|---|
| OQ-001 | MVP OpenClawProvider에서 per-call permission profile을 사용할 수 있는가? | Conductor scope 사전 차단 가능 여부 | MVP 미사용, Forge Phase 2 provider capability로 재검토 | resolved by ADR-012 |
| OQ-002 | foreach의 `list-expr` 평가가 마크다운 목록 추출(`- `)만으로 충분한가? | DSL 표현력 | MVP 가능, Forge Phase 2에서 JSON 출력 옵션 검토 | pending |
| OQ-003 | Conductor `update` 동기 호출이 step 사이 latency 얼마나 늘리는가? | 사용성 | 측정 필요 | pending |
| OQ-004 | OpenClaw IPC 인터페이스 (HTTP vs Unix socket vs Node SDK) | AgentRunner 구현 | ForgeRoom core는 injected OpenClaw IPC client contract로 고정. `openclaw-provider.test.ts`와 `openclaw-provider.ts`가 endpoint/token/runtime health, run/resume request shape, and response mapping을 정의한다. 실제 OpenClaw transport 검증은 adapter/e2e 단계에서 별도 확인. | resolved by Stage 5 provider contract tests |
| OQ-005 | PR 본문 생성에 Conductor의 summary를 그대로 사용해도 되는가? | 품질 vs 자동화 | Forge Phase 1 시도, Forge Phase 2에서 LLM judge 도입 가능 | pending |
| OQ-006 | `agents.yaml`에서 모델 자동 선택(예: 토큰량 기준) 필요한가? | 비용 | Forge Phase 2 검토 | pending |
| OQ-007 | step별 timeout 기본값? (agent run, check 별도) | 안정성 | Agent run default는 Stage 5 AgentRunner policy로 해결: caller `timeoutMs` 우선, 생략 시 `DEFAULT_AGENT_TIMEOUT_MS = 300_000`. Check timeout 기본값은 Stage 6 CheckRunner 정책에서 별도 결정. | partially resolved by Stage 5 AgentRunner policy; check timeout pending Stage 6 |
| OQ-008 | worktree 정리 정책 (성공 후 보존 기간) | 디스크 사용 | MVP는 수동, Forge Phase 2 자동화 | pending |
| OQ-009 | Discord 메시지 길이 제한(2000자) 대응 (긴 step output 분할) | 사용성 | 구현 단계에서 split 또는 thread 사용 | pending |
| OQ-010 | yaml `commands` 명령에 환경변수 주입 필요한가? (예: `${task.id}`) | 워크플로우 표현력 | Forge Phase 2 | pending |
| OQ-011 | GitHub Enterprise Issue/PR API가 MVP GitHubGateway contract와 얼마나 호환되는가? | 사내 TaskSource/Reporter 구현 범위 | Forge Phase 2 | pending |
| OQ-012 | OpenCodeProvider는 CLI headless 실행과 server mode 중 무엇을 기본 entrypoint로 삼는가? | 사내 AgentRuntimeProvider 구현 | Forge Phase 2 | pending |
| OQ-013 | ForgeMap refresh에서 자동 부분 갱신과 사용자 확인이 필요한 구조 변경의 기준은 무엇인가? | ForgeMap 정확도와 운영 비용 | MVP 기본 휴리스틱, Forge Phase 2 정교화 | pending |
| OQ-M01 | Mastra `.dountil()` step body가 iteration index를 직접 노출하는가? 노출 안 되면 어댑터가 input/output으로 thread해야 함 | review_loop iteration 추적, 파일명 규칙 (`07_slice_review.0.md`) 유지 | Mastra adoption spike 단계에서 검증 | pending (claude+codex grill 2026-05-23, confidence 78) |
| OQ-M02 | Mastra가 `.foreach()` mid-iteration에서 suspend 시 snapshot이 깔끔히 복구되는가? | `pause_after`가 foreach 내부 step에서 트리거될 때 동작 | Mastra adoption spike 단계에서 검증. 안 되면 (a) foreach를 explicit sequential chain으로 lowering 또는 (b) pause_after를 nested step에서 unsupported로 선언 | pending (claude+codex grill 2026-05-23, confidence 72) |
| OQ-M03 | Mastra 버전 안정성 (1.0 이전이면 minor pin + 회귀 테스트 전략) | upgrade 비용, MVP stability | Mastra 버전 확정 시점에 lock strategy 결정 | pending |
| OQ-M04 | Mastra Studio 트레이스가 외부 CLI agent process (OpenClaw subprocess) I/O를 포함하는가? 포함 안 되면 step linkage만 가능 | Studio가 실제 디버깅에 얼마나 유용한지 | Mastra adoption spike 시 확인 | pending |
| OQ-M05 | Reporter event ordering: TaskStore commit 직후 vs Mastra step boundary 중 어디서 emit | timeline 일관성 | ADR-013 (Reporter boundary) 재해석 + adoption 시 결정 | pending |

## 작성 규칙

- 새 항목은 다음 OQ 번호 부여
- 해결되면 `상태 = resolved` + 결정 출처(ADR 또는 PR) 명시
- 사라진 항목은 삭제하지 말고 `상태 = withdrawn` 유지
