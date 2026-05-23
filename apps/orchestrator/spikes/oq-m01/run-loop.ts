/**
 * OQ-M01 spike — Part A runner: plain `.dountil()` over ~3 iterations.
 *
 * Run: `pnpm -F orchestrator exec tsx spikes/oq-m01/run-loop.ts`
 * (or via the vitest test `loop.test.ts`).
 *
 * Proves: (1) the loop runs the expected number of iterations, (2) per-iteration
 * marker files are written with the threaded iteration index, (3) whether the
 * execute body sees a native iteration counter.
 */
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mastra } from '@mastra/core';
import { InMemoryStore } from '@mastra/core/storage';
import { buildLoopWorkflow, initialLoopState, type LoopState } from './workflow.js';

export interface LoopRunReport {
  finalState: LoopState;
  filesOnDisk: string[];
  nativeIterationVisibleInBody: boolean;
}

export async function runLoop(outDir?: string): Promise<LoopRunReport> {
  const dir = outDir ?? mkdtempSync(join(tmpdir(), 'oq-m01-loop-'));
  const { workflow } = buildLoopWorkflow(dir);

  const mastra = new Mastra({
    storage: new InMemoryStore(),
    workflows: { oq_m01_loop: workflow },
    logger: false,
  });

  const wf = mastra.getWorkflow('oq_m01_loop');
  const run = await wf.createRun();
  const result = await run.start({ inputData: initialLoopState });

  if (result.status !== 'success') {
    throw new Error(`loop did not succeed: ${result.status} ${JSON.stringify(result)}`);
  }
  const finalState = result.result as LoopState;

  return {
    finalState,
    filesOnDisk: readdirSync(dir).sort(),
    nativeIterationVisibleInBody: finalState.nativeIterationVisible,
  };
}

// Allow direct execution for ad-hoc runs.
if (import.meta.url === `file://${process.argv[1]}`) {
  runLoop()
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
