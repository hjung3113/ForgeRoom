---
status: living
last_reviewed: 2026-05-21
---

# Open Questions

미해결 또는 후속 검토 항목 누적.

| ID | 항목 | 영향 | 차단 여부 | 상태 |
|---|---|---|---|---|
| OQ-001 | OpenClaw가 per-call permission profile 지원하는가? | Conductor scope 사전 차단 가능 여부 | MVP 미차단 (fallback으로 진행) | pending |
| OQ-002 | foreach의 `list-expr` 평가가 마크다운 목록 추출(`- `)만으로 충분한가? | DSL 표현력 | MVP 가능, Phase 2에서 JSON 출력 옵션 검토 | pending |
| OQ-003 | Conductor `update` 동기 호출이 step 사이 latency 얼마나 늘리는가? | 사용성 | 측정 필요 | pending |
| OQ-004 | OpenClaw IPC 인터페이스 (HTTP vs Unix socket vs Node SDK) | AgentRunner 구현 | 구현 단계 진입 시 확인 | pending |
| OQ-005 | PR 본문 생성에 Conductor의 summary를 그대로 사용해도 되는가? | 품질 vs 자동화 | Phase 1 시도, Phase 2에서 LLM judge 도입 가능 | pending |
| OQ-006 | `agents.yaml`에서 모델 자동 선택(예: 토큰량 기준) 필요한가? | 비용 | Phase 2 검토 | pending |
| OQ-007 | step별 timeout 기본값? (agent run, check 별도) | 안정성 | 합리적 기본값 + 설정화 | pending |
| OQ-008 | worktree 정리 정책 (성공 후 보존 기간) | 디스크 사용 | MVP는 수동, Phase 2 자동화 | pending |
| OQ-009 | Discord 메시지 길이 제한(2000자) 대응 (긴 step output 분할) | 사용성 | 구현 단계에서 split 또는 thread 사용 | pending |
| OQ-010 | yaml `commands` 명령에 환경변수 주입 필요한가? (예: `${task.id}`) | 워크플로우 표현력 | Phase 2 | pending |

## 작성 규칙

- 새 항목은 다음 OQ 번호 부여
- 해결되면 `상태 = resolved` + 결정 출처(ADR 또는 PR) 명시
- 사라진 항목은 삭제하지 말고 `상태 = withdrawn` 유지
