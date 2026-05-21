---
status: decided
date: 2026-05-21
---

# ADR-008: Tailscale MVP 제외, Phase 3 통합

## 배경

설계 원문은 Tailscale 기반 원격 접속을 포함했다. MVP의 외부 인터페이스는 Discord + GitHub로 한정한다.

## 분석

- Discord/GitHub는 orchestrator의 **outbound** 연결로 동작 (WebSocket / HTTPS)
- 사용자 명령은 Discord 서버를 경유해 orchestrator가 pull
- inbound 포트를 열 필요가 없으므로 Tailscale은 MVP에서 가치 미미

Tailscale이 필요한 경우:
- 데스크탑 앱을 외부에서 접근
- 로컬 머신 SSH 원격 제어
- 외부 호스트 대시보드 노출

## 결정

**Tailscale MVP 제외. Phase 3에서 데스크탑 앱과 함께 도입.**

## 이유

- MVP 보안 모델 단순화: outbound only, inbound 0
- Tailscale 설치·계정·노드 관리 부담 회피
- Phase 3 GUI 도입 시 자연스럽게 묶어 도입

## 결과

- MVP에 Tailscale 설치 가이드·설정 없음
- 보안 정책 문서에 outbound-only 명시
- Phase 3 항목에 Tailscale 포함

## 후속 검토

- Phase 3 GUI 설계 시 Tailscale 통합 방식 (자체 IP vs MagicDNS)
