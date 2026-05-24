// ---------------------------------------------------------------------------
// Parsed ForgeRoom workflow shape (typed view over workflow yaml)
// ---------------------------------------------------------------------------

export type WorkflowWorktreeEffect = 'read_only' | 'modifies';
export type WorkflowReportEffect = 'none' | 'status' | 'final';
export type WorkflowPrEffect = 'none' | 'draft' | 'ready';

export interface WorkflowEffects {
  worktree: WorkflowWorktreeEffect;
  external: {
    report: WorkflowReportEffect;
    pr: WorkflowPrEffect;
  };
}

export type SelectorName = 'slices';

/** An Executable Step (`type: run`, or a review_loop's review/refine spec). */
export interface ParsedRunStep {
  type: 'run';
  id: string;
  intent: string;
  prompt_template: string;
  input_refs: Record<string, string>;
  vars: Record<string, string>;
  /** Output selectors to parse in the body, e.g. ['slices']. */
  output_selectors: SelectorName[];
  pause_after: boolean;
}

/** Executable spec used inside a review_loop (no `type`, no `pause_after`). */
export interface ParsedExecutableSpec {
  id: string;
  intent: string;
  prompt_template: string;
  input_refs: Record<string, string>;
  vars: Record<string, string>;
}

export interface ParsedGroupStep {
  type: 'group';
  id: string;
  foreach: string;
  as: string;
  steps: ParsedRunStep[];
}

export interface ParsedReviewLoopStep {
  type: 'review_loop';
  id: string;
  until: string;
  max_iterations: number;
  review: ParsedExecutableSpec;
  refine: ParsedExecutableSpec;
}

export type ParsedStep = ParsedRunStep | ParsedGroupStep | ParsedReviewLoopStep;

export interface ParsedForgeWorkflow {
  id: string;
  description: string;
  effects: WorkflowEffects;
  steps: ParsedStep[];
}

export interface ResolvedWorkflow {
  id: string;
  description: string;
  effects: WorkflowEffects;
  steps: ResolvedWorkflowStep[];
  executableSteps: ResolvedWorkflowExecutableStep[];
}

export type ResolvedWorkflowStep =
  | ResolvedWorkflowExecutableStep
  | ResolvedWorkflowGroupStep
  | ResolvedWorkflowReviewLoopStep;

export interface ResolvedWorkflowExecutableStep {
  type: 'run';
  id: string;
  intent: string;
  prompt_template: string;
  input_refs: Record<string, string>;
  vars: Record<string, string>;
  output_selectors: SelectorName[];
  foreach: null;
  as: null;
  steps: [];
  review: null;
  refine: null;
  until: null;
  max_iterations: null;
  pause_after: boolean;
  kind: string;
  agent: string;
  harness: string;
}

export interface ResolvedWorkflowGroupStep {
  type: 'group';
  id: string;
  intent: null;
  prompt_template: null;
  input_refs: Record<string, never>;
  vars: Record<string, never>;
  output_selectors: [];
  foreach: string;
  as: string;
  steps: ResolvedWorkflowStep[];
  review: null;
  refine: null;
  until: null;
  max_iterations: null;
  pause_after: false;
  kind: null;
  agent: null;
  harness: null;
}

export interface ResolvedWorkflowReviewLoopStep {
  type: 'review_loop';
  id: string;
  intent: null;
  prompt_template: null;
  input_refs: Record<string, never>;
  vars: Record<string, never>;
  output_selectors: [];
  foreach: null;
  as: null;
  steps: [];
  review: ResolvedWorkflowExecutableStep;
  refine: ResolvedWorkflowExecutableStep;
  until: string;
  max_iterations: number;
  pause_after: false;
  kind: null;
  agent: null;
  harness: null;
}

// ---------------------------------------------------------------------------
// Mastra adapter contract shared by dsl builder and core collaborators
// ---------------------------------------------------------------------------

/** Resolved Step metadata (Intent + Step Harness composed at build time). */
export interface ResolvedStep {
  /** Mastra step id: `${intent_id}:${step_id}`. */
  mastraStepId: string;
  stepId: string;
  intentId: string;
  kind: string;
  agent: string;
  harness: string;
  promptTemplate: string;
  /** Raw (uninterpolated) vars from the DSL, evaluated at bind time. */
  vars: Record<string, string>;
  /** Raw (uninterpolated) input_refs from the DSL, evaluated at bind time. */
  input_refs: Record<string, string>;
}

/** Variables made available to `${...}` interpolation. */
export interface InterpolationSource {
  task: {
    title: string;
    description: string;
    project: string;
    branch: string;
    worktree_path: string;
    issue_number: string;
    full_diff_path: string;
    final_slices: string[];
  };
  vars: Record<string, string>;
  /** Prior step outputs keyed by step id (filled by the pipeline at runtime). */
  stepOutputs: Record<string, StepOutputView>;
}

export interface StepOutputView {
  output?: string;
  output_path?: string;
  diff_path?: string | null;
  passed?: boolean;
  slices?: string[];
}

/** Values produced by interpolating a step's vars / input_refs. */
export interface InterpolatedInputs {
  vars: Record<string, unknown>;
  input_refs: Record<string, unknown>;
}

export interface AgentRunResult {
  outputPath: string;
  output: string;
  diffPath: string | null;
}

/**
 * The collaborators the step bodies call. Concrete implementations are wired by
 * PipelineEngine; tests pass fakes. The adapter only orchestrates call order.
 */
export interface AdapterCollaborators {
  renderPrompt(resolved: ResolvedStep, inputs: InterpolatedInputs): Promise<string>;
  runAgent(resolved: ResolvedStep, promptPath: string, inputs: InterpolatedInputs): Promise<AgentRunResult>;
  runChecks(resolved: ResolvedStep, run: AgentRunResult): Promise<{ allPassed: boolean }>;
  saveDiff(resolved: ResolvedStep, run: AgentRunResult): Promise<string | null>;
  conductorUpdate(resolved: ResolvedStep, run: AgentRunResult): Promise<void>;
  /** Called from the dedicated pauseAfterGate step (suspend lives in the gate). */
  suspend(resolved: ResolvedStep): Promise<void>;
}

export interface SelectorParsers {
  parseSlices(output: string): string[];
  parseReviewPassed(output: string): boolean;
}

export interface AdapterContext {
  interpolation: InterpolationSource;
  collaborators: AdapterCollaborators;
  selectors: SelectorParsers;
}
