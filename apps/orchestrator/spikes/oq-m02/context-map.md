---
status: living
last_reviewed: 2026-05-23
---

# oq-m02 Context Map

## 책임

Empirical spike for OQ-M02 — does a step nested in Mastra `.foreach()` suspend
mid-iteration and resume to the same iteration?

## 주요 파일

| 파일 | 역할 |
|---|---|
| `foreach-suspend.spike.ts` | Runnable proof: foreach over 3 items, item 1 suspends, resume continues from item 1. |

## 같이 읽을 문서

- [spike findings](../../../../Docs/spikes/2026-05-23-oq-m02-foreach-suspend.md)
- [ADR-016](../../../../Docs/decisions/2026-05-23-016-dsl-to-mastra-adapter.md)
- [OQ-M02](../../../../Docs/open-questions.md)
