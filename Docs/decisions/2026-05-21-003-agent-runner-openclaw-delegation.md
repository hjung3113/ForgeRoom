---
status: superseded
date: 2026-05-21
superseded_by: 2026-05-22-012-agent-runtime-provider-boundary.md
---

# ADR-003: AgentRunner를 OpenClaw에 위임

## 배경

여러 CLI agent(Claude Code, Codex, Gemini CLI)를 통일된 인터페이스로 호출해야 한다. 후보:

- **A) OpenClaw 위임**: `agents.yaml`이 OpenClaw runtime을 참조. ForgeRoom은 OpenClaw에 메시지만 보냄
- **B) 직접 child_process**: CLI 바이너리 직접 spawn. CLI별 인자/IO 차이 ForgeRoom이 처리
- **C) 하이브리드**: 기본 OpenClaw, fallback 직접

## 결정

**A) OpenClaw 위임**.

## 이유

- OpenClaw가 `claude-cli`, `openai-codex`, `google-gemini-cli` runtime 이미 지원
- 새 CLI 추가 시 OpenClaw 설정만 손대면 됨. ForgeRoom 코드 변경 0
- 통일된 호출 인터페이스로 ForgeRoom 단순화
- OpenClaw가 Discord gateway·local IPC를 이미 제공해 일관된 stack

## 트레이드오프

- OpenClaw 의존성 강화. OpenClaw 장애 → ForgeRoom 마비
- OpenClaw 외부의 커스텀 CLI는 Phase 2/3로 미룸 (C 옵션은 후속 검토)

## 결과

- `agents.yaml`에 OpenClaw runtime/model 참조
- AgentRunner는 OpenClaw IPC/HTTP 클라이언트
- 인증 토큰은 `.env`에 `OPENCLAW_TOKEN`

## 후속 검토

- OpenClaw per-call permission profile 지원 여부 ([OQ-001](../open-questions.md))
- 커스텀 CLI 등록 필요성이 커지면 옵션 C로 확장
