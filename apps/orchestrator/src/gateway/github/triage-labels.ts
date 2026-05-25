/**
 * Canonical triage label strings (docs/agents/triage-labels.md).
 *
 * Single source of truth for the five triage roles used in this repo's
 * GitHub issue tracker. The label-lifecycle effect (ADR-026) references
 * these constants so string literals never appear in business logic.
 */

export const TRIAGE_LABELS = {
  /** Maintainer needs to evaluate this issue. */
  NEEDS_TRIAGE: 'needs-triage',
  /** Waiting on reporter for more information. */
  NEEDS_INFO: 'needs-info',
  /** Fully specified, ready for an AFK agent. */
  READY_FOR_AGENT: 'ready-for-agent',
  /** Requires human implementation or review. */
  READY_FOR_HUMAN: 'ready-for-human',
  /** Will not be actioned. */
  WONTFIX: 'wontfix',
} as const;

export type TriageLabel = (typeof TRIAGE_LABELS)[keyof typeof TRIAGE_LABELS];
