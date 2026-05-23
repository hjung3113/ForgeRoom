/**
 * OQ-M01 spike — resume Part B, PROCESS 1.
 *
 * Starts the loop workflow; the loop step suspends at iteration 1. We then dump
 * the run snapshot to disk and exit. A separate process (resume-phase2.ts)
 * resumes from that snapshot.
 *
 * argv: [outDir] [snapshotFile]
 * Prints a JSON line to stdout describing the suspended state.
 */
import { Mastra } from '@mastra/core';
import { InMemoryStore } from '@mastra/core/storage';
import { buildResumeWorkflow, initialLoopState } from './workflow.js';
import { dumpSnapshot } from './snapshot-io.js';

const SUSPEND_AT = 1;

async function main(): Promise<void> {
  const outDir = process.argv[2];
  const snapshotFile = process.argv[3];
  if (!outDir || !snapshotFile) throw new Error('usage: resume-phase1 <outDir> <snapshotFile>');

  const { workflow } = buildResumeWorkflow(outDir, SUSPEND_AT);
  const store = new InMemoryStore();
  const mastra = new Mastra({
    storage: store,
    workflows: { oq_m01_resume: workflow },
    logger: false,
  });

  const wf = mastra.getWorkflow('oq_m01_resume');
  const run = await wf.createRun();
  const result = await run.start({ inputData: initialLoopState });

  if (result.status !== 'suspended') {
    throw new Error(`expected suspended, got ${result.status}: ${JSON.stringify(result)}`);
  }

  await dumpSnapshot(store, 'oq_m01_resume', run.runId, snapshotFile);

  console.log(JSON.stringify({ phase: 1, runId: run.runId, status: result.status, suspendAt: SUSPEND_AT }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
