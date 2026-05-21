---
status: superseded
date: 2026-05-21
superseded_by: 2026-05-21-009-forge-phase-and-slice-terminology.md
---

# ADR-007: 데스크탑 앱은 Phase 3로 이동

> Superseded by [ADR-009](2026-05-21-009-forge-phase-and-slice-terminology.md). Desktop App은 Forge Phase 4로 이동한다.

## 배경

초기 자료에 데스크탑 앱 목업(대시보드, 칸반, 파이프라인 그래프)이 포함되어 있었다. MVP에 포함할지 분리할지 결정.

## 옵션

- **A) MVP 포함**: orchestrator + GUI 동시 구축
- **B) Phase 3로 분리**: orchestrator·CLI·Discord·GitHub만 MVP, GUI는 운영 안정화 후

## 결정

**B) Phase 3로 분리**.

## 이유

- MVP는 자동화 파이프라인의 정합성 검증이 우선
- GUI 추가는 추가 기술 스택(Tauri/Electron) 의사결정·테스트·배포 부담
- Discord + GitHub로 MVP 시점 모바일/원격 운용 모두 충족
- GUI는 데이터 모델·이벤트 스트림 안정화 후 얹는 게 자연스러움

## 결과

- MVP 인터페이스: Discord 슬래시 명령 + GitHub Issue/PR
- 목업은 `Docs/_legacy/assets/desktop-mockups/`로 보존
- Phase 3 항목에 GUI + Tailscale 묶음 포함

## 후속 검토

- Phase 3 진입 시 Tauri vs Electron 선택
- 데이터 노출 API 설계 (orchestrator 내장 vs sidecar)
