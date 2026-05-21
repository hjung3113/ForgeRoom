---
status: decided
date: 2026-05-21
---

# ADR-004: 프롬프트는 파일 기반으로 전달

## 배경

step 실행 시 agent에 프롬프트를 전달하는 방식 후보:

- **A) CLI 인자/stdin 직접 주입**: 단순. 그러나 장문 프롬프트는 CLI 인자/stdin 길이 한계나 응답 품질 저하 발생
- **B) 파일 기반**: worktree 내부 `.forgeroom/prompts/` 에 프롬프트 파일 작성, agent가 읽음. 출력도 `.forgeroom/outputs/`로 받음

## 결정

**B) 파일 기반**.

## 이유

- 사용자 운영 경험: 인라인 장문 프롬프트는 응답 품질이 자주 저하됨
- agent가 partial read 가능 (큰 diff는 head/grep)
- worktree에 모든 흔적 보존 → 디버깅·감사·재시작 회복 용이
- Conductor가 같은 파일 트리 읽으면 자연스럽게 동일 컨텍스트 확보
- DB는 메타·상태머신에만 집중, 본문은 파일

## 결과

- 폴더 컨벤션: `<worktree>/.forgeroom/{context,prompts,outputs,diffs,logs}/`
- 변수 보간 시 큰 본문은 `input_refs`로 경로 참조 권장
- AgentRunner는 output 파일 존재·크기 검증 + resume 재시도

## 트레이드오프

- 단순 호출보다 파일 IO 단계 증가. 무시 가능한 비용
- agent가 파일 시스템 도구 보유해야 함 (Claude Code/Codex/Gemini CLI 모두 지원)

## 후속 검토

- output 파일 검증 강화 (정규식·LLM judge) — Phase 2
- Conductor scope 위반 방어 강화 — Phase 2
