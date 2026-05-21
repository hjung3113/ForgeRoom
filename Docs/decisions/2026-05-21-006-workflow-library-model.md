---
status: decided
date: 2026-05-21
---

# ADR-006: 워크플로우 라이브러리 + 호출 시 선택 모델

## 배경

작업 복잡도가 다양하다. 단일 고정 파이프라인은 비효율. 워크플로우를 어떻게 구조화할지 후보:

- **A) 프로젝트당 단일 파이프라인**: `projects.yaml`에 step 시퀀스 직접 정의
- **B) 워크플로우 라이브러리**: `workflows.yaml`에 이름붙은 워크플로우 다수 정의. 프로젝트는 사용 가능 목록과 기본값 선택. 호출 시 워크플로우 지정
- **C) 명령별 라우팅**: `/plan`, `/code`, `/review` 각각 다른 agent 매핑. 사람이 단계마다 호출

## 결정

**B) 워크플로우 라이브러리** + 일부 C (개별 명령도 허용).

## 이유

- 작업 복잡도별 적절한 워크플로우 (full, quick, hotfix 등) 재사용 가능
- 새 워크플로우 = yaml 추가만. 코드 변경 0
- 프로젝트 간 워크플로우 공유 가능 (모든 Node 프로젝트가 `full` 사용 가능)
- 런타임 override (agent 교체) 와 결합해 유연성 확보

## 호출 모델

```
/run <project> "<title>"                          # default_workflow 사용
/run <project> "<title>" --workflow=quick
/run <project> "<title>" --workflow=full --override design=gemini,review=claude
/plan <project> "<title>"                         # 단일 step 호출
/code <task-id>
```

## 결과

- 설정 파일 분리: `workflows.yaml`(라이브러리), `projects.yaml`(가용 목록+기본값), `agents.yaml`(에이전트 정의)
- 검증: 프로젝트에서 참조한 워크플로우는 반드시 라이브러리에 존재

## 트레이드오프

- 설정 파일 3개로 증가. 학습 곡선 살짝 가파라짐
- 잘못된 워크플로우 매칭 디버깅 필요 → dry-run validator 도입 (Phase 2)
