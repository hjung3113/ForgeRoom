// ---------------------------------------------------------------------------
// Shared workflow execution/validation errors (ADR-022).
//
// These live in the neutral `workflow/` layer because both the dsl builder
// (which throws them during build/run) and core (which classifies them in
// PipelineEngine.mapFailureReason via instanceof) must reference the SAME class
// identity. Splitting them across layers would break `instanceof` and reopen
// the core → dsl import the inversion removes.
// ---------------------------------------------------------------------------

/**
 * Raised when the resolved-workflow → Mastra adapter rejects a workflow during
 * build/validate (ADR-016). `failure_reason` is the value PipelineEngine records
 * on the task; it is a build-time failure, not a task runtime failure.
 */
export class AdapterValidationError extends Error {
  readonly failure_reason = 'adapter_validation_failed' as const;

  constructor(
    message: string,
    readonly workflowId: string,
    readonly field: string | null = null,
  ) {
    super(field === null ? message : `${message} (${workflowId}.${field})`);
    this.name = 'AdapterValidationError';
  }
}

/** Surfaced as a run failure; the pipeline maps it to review_loop_max_iterations. */
export class ReviewLoopMaxIterationsError extends Error {
  readonly failure_reason = 'review_loop_max_iterations' as const;
  constructor(
    readonly loopId: string,
    readonly maxIterations: number,
  ) {
    super(`review_loop ${loopId} exhausted max_iterations=${String(maxIterations)}`);
    this.name = 'ReviewLoopMaxIterationsError';
  }
}
