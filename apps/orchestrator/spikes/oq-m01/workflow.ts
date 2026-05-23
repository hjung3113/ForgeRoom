/**
 * OQ-M01 spike — shared Mastra workflow definitions.
 *
 * Goal: determine whether Mastra `.dountil()` exposes a loop ITERATION INDEX
 * to the loop step's `execute` body, mirroring ForgeRoom's review_loop need
 * (per-iteration numbering for `NN_<step_id>.<iteration>.md` files + step rows).
 *
 * Two workflows are exported:
 *  - `buildLoopWorkflow`     — plain `.dountil()` over ~3 iterations (no suspend)
 *  - `buildResumeWorkflow`   — same loop, but suspends inside iteration 1 so the
 *                              resume test can prove the counter survives a fresh
 *                              process.
 *
 * Both keep step bodies plain JS (NO LLM) — this is a control-flow probe.
 *
 * NodeNext/ESM: relative imports use `.js` extensions.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';

const TARGET_ITERATIONS = 3;

/**
 * Loop step input/output schema.
 *
 * `iteration` and `passed` are MANUALLY threaded through the loop step's
 * input/output — this is the ADR-016 assumption under test. If Mastra exposed
 * the index natively in the execute body we would not need to carry `iteration`
 * in the schema at all.
 */
const loopState = z.object({
  iteration: z.number(),
  passed: z.boolean(),
  prevOutputPath: z.string().nullable(),
  /** Diagnostic: what the execute body could observe about a native counter. */
  nativeIterationVisible: z.boolean(),
});
export type LoopState = z.infer<typeof loopState>;

export interface ProbeResult {
  /** Was a native `iterationCount` (or similar) visible in the execute body? */
  nativeIterationVisibleInBody: boolean;
  /** Files written, one per iteration, named with the threaded iteration index. */
  writtenFiles: string[];
}

/**
 * Build the no-suspend loop workflow. `outDir` is where per-iteration marker
 * files are written so we can prove numbering on disk.
 */
export function buildLoopWorkflow(outDir: string) {
  mkdirSync(outDir, { recursive: true });
  const writtenFiles: string[] = [];

  const loopStep = createStep({
    id: 'slice_review',
    inputSchema: loopState,
    outputSchema: loopState,
    execute: async (ctx) => {
      const input = ctx.inputData;

      // PROBE: does the execute context expose a native iteration counter?
      // Inspect every key on the context object for anything iteration-like.
      const ctxRecord = ctx as unknown as Record<string, unknown>;
      const nativeKeys = Object.keys(ctxRecord).filter((k) =>
        /iteration|loopindex|loopcount/i.test(k),
      );
      const nativeIterationVisible = nativeKeys.length > 0;

      // Manual threading: derive this round's index from the threaded input.
      const iteration = input.iteration;

      // Prove numbering: write a file named with the threaded iteration index,
      // matching ForgeRoom's `NN_<step_id>.<iteration>.md` convention.
      const fileName = `07_slice_review.${iteration}.md`;
      const filePath = join(outDir, fileName);
      writeFileSync(
        filePath,
        `iteration=${iteration}\nnativeKeysFound=${JSON.stringify(nativeKeys)}\n`,
        'utf8',
      );
      writtenFiles.push(fileName);

      // Simulate a review that passes only on the final target iteration.
      const passed = iteration + 1 >= TARGET_ITERATIONS;

      return {
        iteration: iteration + 1,
        passed,
        prevOutputPath: filePath,
        nativeIterationVisible,
      };
    },
  });

  const workflow = createWorkflow({
    id: 'oq_m01_loop',
    inputSchema: loopState,
    outputSchema: loopState,
  })
    .dountil(loopStep, async ({ inputData, iterationCount }) => {
      // `iterationCount` IS available here in the condition (native).
      // Hard ceiling so a buggy condition can never spin forever.
      if (iterationCount >= 10) {
        throw new Error('OQ-M01 loop exceeded ceiling');
      }
      return inputData.passed;
    })
    .commit();

  return { workflow, writtenFiles };
}

/**
 * Build the resume-test loop workflow. Identical loop, but the step suspends
 * exactly once — when it first reaches `suspendAt` — so we can kill the process
 * and prove the threaded iteration index is restored on resume.
 */
export function buildResumeWorkflow(outDir: string, suspendAt: number) {
  mkdirSync(outDir, { recursive: true });

  const loopStep = createStep({
    id: 'slice_review',
    inputSchema: loopState,
    outputSchema: loopState,
    resumeSchema: z.object({ ack: z.boolean() }),
    suspendSchema: z.object({ atIteration: z.number() }),
    execute: async (ctx) => {
      const input = ctx.inputData;
      const resumeData = ctx.resumeData as { ack?: boolean } | undefined;
      const iteration = input.iteration;

      // Suspend once, at the target iteration, before doing the work — unless
      // we are being resumed (resumeData present).
      if (iteration === suspendAt && !resumeData?.ack) {
        return (await ctx.suspend({ atIteration: iteration })) as never;
      }

      const fileName = `07_slice_review.${iteration}.md`;
      const filePath = join(outDir, fileName);
      writeFileSync(filePath, `iteration=${iteration}\nresumed=${Boolean(resumeData?.ack)}\n`, 'utf8');

      const passed = iteration + 1 >= TARGET_ITERATIONS;
      return {
        iteration: iteration + 1,
        passed,
        prevOutputPath: filePath,
        nativeIterationVisible: false,
      };
    },
  });

  const workflow = createWorkflow({
    id: 'oq_m01_resume',
    inputSchema: loopState,
    outputSchema: loopState,
  })
    .dountil(loopStep, async ({ inputData, iterationCount }) => {
      if (iterationCount >= 10) {
        throw new Error('OQ-M01 resume loop exceeded ceiling');
      }
      return inputData.passed;
    })
    .commit();

  return { workflow, loopStep };
}

export const initialLoopState: LoopState = {
  iteration: 0,
  passed: false,
  prevOutputPath: null,
  nativeIterationVisible: false,
};

export { TARGET_ITERATIONS };
