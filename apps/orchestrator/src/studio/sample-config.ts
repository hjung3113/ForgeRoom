/**
 * Self-contained sample workflow + intent config for Mastra Studio (#10).
 *
 * This is the `full` workflow from {@link configs/workflows.yaml} reproduced
 * inline so the Studio sample is hermetic: it does not read project config off
 * disk and does not depend on a project being registered. The structure
 * (plan -> refine -> foreach slices -> review_loop) is preserved verbatim so
 * Studio renders the same graph shape as a real `full` run; only the execution
 * collaborators are stubbed (see {@link sample-workflow.ts}).
 */
export const SAMPLE_WORKFLOW_ID = 'full' as const;

/** The three intents the `full` workflow references (from configs/intents.yaml). */
export const SAMPLE_INTENTS = {
  claude_write_plan: { kind: 'write_plan', agent: 'claude', harness: 'planning' },
  codex_execute: { kind: 'execute', agent: 'codex', harness: 'implementation' },
  claude_review: { kind: 'review', agent: 'claude', harness: 'review' },
} as const;

/**
 * The `full` workflow yaml. Kept structurally identical to configs/workflows.yaml
 * so the rendered graph matches production. If the canonical workflow changes,
 * update this sample in the same PR (it is intentionally a copy, not an import,
 * to keep the Studio demo decoupled from project-config loading).
 */
export const SAMPLE_WORKFLOW_YAML = `full:
  description: "Studio sample — design, plan, slice impl, final review (stub agents)"
  effects:
    worktree: modifies
    external:
      report: status
      pr: ready
  steps:
    - type: run
      id: impl_plan
      intent: claude_write_plan
      prompt_template: implementation_plan.md
    - type: run
      id: impl_plan_refine
      intent: claude_write_plan
      prompt_template: refine_plan.md
      input_refs:
        original: \${impl_plan.output_path}
    - type: group
      id: slices
      foreach: \${task.final_slices}
      as: slice
      steps:
        - type: run
          id: slice_impl
          intent: codex_execute
          prompt_template: slice_impl.md
          vars:
            slice: \${slice}
    - type: review_loop
      id: final_quality
      max_iterations: 2
      until: \${final_review.passed}
      review:
        id: final_review
        intent: claude_review
        prompt_template: final_review.md
        input_refs:
          full_diff: \${task.full_diff_path}
      refine:
        id: final_refine
        intent: codex_execute
        prompt_template: final_refine.md
        input_refs:
          review: \${final_review.output_path}
          full_diff: \${task.full_diff_path}
`;
