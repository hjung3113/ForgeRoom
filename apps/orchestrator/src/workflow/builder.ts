// ---------------------------------------------------------------------------
// WorkflowBuilder port (ADR-022).
//
// core owns this boundary contract; the dsl `to-mastra` adapter implements it.
// Inverting the dependency lets PipelineEngine depend on `workflow/` (allowed)
// instead of importing the dsl builder directly (forbidden by ADR-020).
//
// `workflow` is intentionally `unknown`: core treats the committed Mastra
// workflow object as opaque (it only reads `.id` to register it). Keeping a
// Mastra type out of the neutral layer avoids merely relocating the coupling.
// ---------------------------------------------------------------------------
import type { AdapterContext, ResolvedStep, ResolvedWorkflow, WorkflowEffects } from './types.js';

export interface BuiltWorkflow {
  /** Opaque committed Mastra workflow object; core registers it by `.id`. */
  workflow: unknown;
  effects: WorkflowEffects;
  /** Resolved step metadata, in declaration order, for Registry/Reporter use. */
  resolvedSteps: ResolvedStep[];
}

export interface WorkflowBuilder {
  build(workflow: ResolvedWorkflow, ctx: AdapterContext): BuiltWorkflow;
}
