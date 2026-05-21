---
status: decided
last_reviewed: 2026-05-21
---

# 보안 정책

## 통신

- inbound 포트 0개. 외부 접근 전면 차단
- Discord WebSocket: outbound only
- GitHub API: outbound only, Octokit polling
- OpenClaw: 로컬 IPC/loopback HTTP
- Tailscale: MVP 제외, Forge Phase 4에서 데스크탑 앱과 함께

## 시크릿

- 위치: `~/forgeroom/.env`, `chmod 600`
- 항목 (MVP):
  - `DISCORD_BOT_TOKEN`
  - `DISCORD_GUILD_ID`
  - `GITHUB_TOKEN`
  - `OPENCLAW_TOKEN`
- git 무시 (`.gitignore`)
- 로그 출력 시 패턴 마스킹: `AKIA[0-9A-Z]+`, `ghp_[A-Za-z0-9]+`, `sk-[A-Za-z0-9]+`, JWT 형태 `eyJ...`

## 인증·인가

- Discord: 사용자 ID allowlist (`configs/discord.yaml`)
  - guild ID 매치 추가 확인
  - 명령 수신 시 user.id 체크
- GitHub: token 스코프 최소 (`repo`만)
- 등록되지 않은 owner/repo 호출 차단

## 프로젝트 격리

- `configs/projects.yaml`에 등록된 path만 접근
- agent 작업은 worktree 내부 cwd로 강제
- worktree 외부 file write 발견 시 자동 revert

## Prompt template 격리

- `prompt_template`은 bundled template root 아래 상대 경로만 허용
- 절대경로, `..`, root 밖 symlink escape 금지
- custom workflow도 MVP에서는 bundled template만 참조
- 프로젝트별 `template_dir` override 실제 사용은 Forge Phase 2에서 별도 검토

## 위험 명령 차단 (ApprovalGate)

상세는 [modules/approval-gate.md](../modules/approval-gate.md).

차단 카테고리:
- 파괴적 git (`push --force`, `reset --hard`, branch 삭제)
- main 직접 수정
- 시스템 파일 접근 (`/etc/`, `~/.ssh/` 등)
- 시크릿 접근 (`.env`, `id_rsa`, `*.pem`)
- 임의 다운로드·실행 (`curl ... | sh`)
- 마이그레이션·DB reset

## 머지 정책

- PR 자동 머지 X. 항상 사람이 GitHub UI에서 머지
- main에 직접 commit 금지 (worktree 단계에서 차단)

## 감사 로그

- 모든 명령·차단·시크릿 접근 시도는 `logs/audit_<date>.log`에 기록
- 로테이션: 30일 (Forge Phase 2)

## OpenClaw 의존성 보안

- OpenClaw 자체 인증 토큰은 `.env`
- OpenClaw가 노출하는 게이트웨이 포트는 loopback 바인딩 확인
- 가능하면 per-call permission profile 활용 (OQ-001)

## Forge Phase 2/4 강화

- Discord 승인 게이트 (위험 작업 1회 승인)
- 차단 카탈로그 핫리로드
- Tailscale 통합
- 토큰 자동 로테이션 가이드
