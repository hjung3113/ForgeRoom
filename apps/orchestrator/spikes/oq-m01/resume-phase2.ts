/**
 * OQ-M01 spike — resume Part B, PROCESS 2 (fresh process).
 *
 * Rebuilds the workflow from scratch, hydrates a brand-new InMemoryStore from
 * the on-disk snapshot, recreates the Run by its persisted runId, and resumes.
 * Proves the threaded iteration index survives the process boundary: after
 * resume the loop must continue from iteration 1 and finish all 3 iterations.
 *
 * argv: [outDir] [snapshotFile]
 * Prints a JSON line to stdout describing the final state.
 */
import { Mastra } from '@mastra/core';
import { InMemoryStore } from '@mastra/core/storage';
import { buildResumeWorkflow, type LoopState } from './workflow.js';
import { hydrateSnapshot } from './snapshot-io.js';

const SUSPEND_AT = 1;

async function main(): Promise<void> {
  const outDir = process.argv[2];
  const snapshotFile = process.argv[3];
  if (!outDir || !snapshotFile) throw new Error('usage: resume-phase2 <outDir> <snapshotFile>');

  const { workflow, loopStep } = buildResumeWorkflow(outDir, SUSPEND_AT);
  const store = new InMemoryStore();
  const payload = await hydrateSnapshot(store, snapshotFile);

  const mastra = new Mastra({
    storage: store,
    workflows: { oq_m01_resume: workflow },
    logger: false,
  });

  const wf = mastra.getWorkflow('oq_m01_resume');
  const run = await wf.createRun({ runId: payload.runId });

  const result = await run.resume({
    step: loopStep,
    resumeData: { ack: true },
  });

  if (result.status !== 'success') {
    throw new Error(`expected success after resume, got ${result.status}: ${JSON.stringify(result)}`);
  }
  const finalState = result.result as LoopState;

  console.log(JSON.stringify({ phase: 2, runId: payload.runId, status: result.status, finalState }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
