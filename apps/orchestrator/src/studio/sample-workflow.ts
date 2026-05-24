/**
 * Sample workflow for Mastra Studio dev visualization (#10).
 *
 * Builds the `full` workflow from {@link configs/workflows.yaml} via the #6
 * adapter ({@link toMastraWorkflow}) using a STUB set of collaborators — no real
 * LLM, no OpenClaw CLI subprocess. The stub produces deterministic, contract-
 * shaped step outputs so a Studio run advances every step (plan -> refine ->
 * foreach slices -> review_loop) and renders a complete graph + trace.
 *
 * This module is dev-only. It does NOT touch pipeline-engine.ts or to-mastra.ts;
 * it only CONSUMES the adapter to demonstrate the graph in Studio. The stub
 * mirrors the real PipelineEngine's collaborator call order
 * (renderPrompt -> runAgent -> runChecks -> saveDiff -> conductorUpdate) so the
 * trace shape matches production step boundaries.
 */
import { IntentRegistry } from '../core/intent-registry.js';
import {
  parseForgeWorkflow,
  toMastraWorkflow,
  type BuiltMastraWorkflow,
} from '../dsl/to-mastra.js';
import type {
  AdapterContext,
  AgentRunResult,
  InterpolatedInputs,
  InterpolationSource,
  ResolvedStep,
  StepOutputView,
} from '../workflow/types.js';
import { parseSlicesOutput, parseReviewPassedOutput } from '../core/output-selectors.js';
import { SAMPLE_WORKFLOW_ID, SAMPLE_WORKFLOW_YAML, SAMPLE_INTENTS } from './sample-config.js';

/**
 * Stub output for a step. Mirrors what a real agent would write to
 * `.forgeroom/outputs/NN_<step>.md`, but is synthesised in-memory so Studio can
 * render the trace without any external process. The plan step emits a parseable
 * `slices` list (so the `foreach` group runs) and the review step emits
 * `passed: true` (so the `review_loop` terminates on its first iteration).
 */
function stubOutputFor(resolved: ResolvedStep): string {
  if (resolved.kind === 'write_plan') {
    // parseSlicesOutput requires a `## Slices` heading with `- ` bullets.
    return [
      `# Plan output (stub) for ${resolved.stepId}`,
      '',
      'This is a deterministic Studio sample; no LLM was invoked.',
      '',
      '## Slices',
      '- slice-a',
      '- slice-b',
    ].join('\n');
  }
  if (resolved.kind === 'review') {
    // parseReviewPassedOutput requires `Review Result: pass` as the FIRST
    // non-empty line so the review_loop terminates on its first iteration.
    return [
      'Review Result: pass',
      '',
      `Stub review for ${resolved.stepId}; approved on first pass.`,
    ].join('\n');
  }
  return [
    `# ${resolved.kind} output (stub) for ${resolved.stepId}`,
    '',
    `Synthesised by the Studio sample stub for agent "${resolved.agent}".`,
    'No OpenClaw CLI subprocess ran; this output is in-memory only.',
  ].join('\n');
}

/**
 * Build the sample {@link AdapterContext}: a self-contained interpolation source
 * plus stub collaborators that never spawn a process. Each collaborator returns
 * the same contract shape the real PipelineEngine produces, so the Studio trace
 * shows realistic per-step input/output without external dependencies.
 */
export function buildSampleAdapterContext(): AdapterContext {
  const stepOutputs: Record<string, StepOutputView> = {};
  const interpolation: InterpolationSource = {
    task: {
      title: 'Studio sample task',
      description: 'Demonstrates the full workflow graph in Mastra Studio with stub agents.',
      project: 'sample',
      branch: 'feat/studio-sample',
      worktree_path: '/tmp/forgeroom-studio-sample',
      issue_number: '10',
      full_diff_path: '.forgeroom/diffs/full.diff',
      // Pre-seeded so the `foreach` list step has slices even before the plan
      // step's stub mutates them (the adapter captures this array by reference).
      final_slices: ['slice-a', 'slice-b'],
    },
    vars: {},
    stepOutputs,
  };

  const collaborators: AdapterContext['collaborators'] = {
    renderPrompt: async (resolved: ResolvedStep, _inputs: InterpolatedInputs): Promise<string> => {
      // Real engine writes a file; the stub returns a virtual path string only.
      return `.forgeroom/prompts/${resolved.stepId}.md`;
    },
    runAgent: async (resolved: ResolvedStep, _promptPath: string): Promise<AgentRunResult> => {
      const output = stubOutputFor(resolved);
      return {
        outputPath: `.forgeroom/outputs/${resolved.stepId}.md`,
        output,
        diffPath: resolved.kind === 'execute' ? `.forgeroom/diffs/${resolved.stepId}.diff` : null,
      };
    },
    runChecks: async (): Promise<{ allPassed: boolean }> => {
      // Stub checks always pass; the real CheckRunner runs lint/typecheck/tests.
      return { allPassed: true };
    },
    saveDiff: async (_resolved: ResolvedStep, run: AgentRunResult): Promise<string | null> => {
      return run.diffPath;
    },
    conductorUpdate: async (resolved: ResolvedStep, run: AgentRunResult): Promise<void> => {
      let slices: string[] | null;
      try {
        slices = parseSlicesOutput(run.output);
      } catch {
        slices = null;
      }
      let passed: boolean | undefined;
      if (resolved.kind === 'review') {
        try {
          passed = parseReviewPassedOutput(run.output);
        } catch {
          passed = undefined;
        }
      }
      stepOutputs[resolved.stepId] = {
        output: run.output,
        output_path: run.outputPath,
        diff_path: run.diffPath,
        ...(passed === undefined ? {} : { passed }),
        ...(slices === null ? {} : { slices }),
      };
      if (slices !== null) {
        // Mutate the captured array in place (same coupling the engine documents).
        interpolation.task.final_slices.splice(0, interpolation.task.final_slices.length, ...slices);
      }
    },
    suspend: async (): Promise<void> => {
      await Promise.resolve();
    },
  };

  return {
    interpolation,
    collaborators,
    selectors: {
      parseSlices: (output: string): string[] => parseSlicesOutput(output),
      parseReviewPassed: (output: string): boolean => parseReviewPassedOutput(output),
    },
  };
}

/**
 * Build the committed Mastra workflow for the Studio sample. Pure: no I/O, no
 * process spawn. Used both by the Studio entry ({@link mastra/index.ts}) and the
 * tests that assert the graph builds and runs end to end.
 */
export function buildSampleWorkflow(): BuiltMastraWorkflow {
  const parsed = parseForgeWorkflow(SAMPLE_WORKFLOW_YAML, SAMPLE_WORKFLOW_ID);
  const intents = IntentRegistry.fromConfig(SAMPLE_INTENTS);
  return toMastraWorkflow(parsed, intents, buildSampleAdapterContext());
}
