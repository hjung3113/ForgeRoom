/**
 * OQ-M01 spike — Part B test: mid-loop suspend/resume across a simulated restart.
 *
 * The resume test IS the proof the threaded iteration index survives a restart.
 *
 * "Fresh process" is simulated faithfully: phase 1 and phase 2 share NO runtime
 * objects. Phase 1 starts the run, the loop step suspends at iteration 1, and the
 * snapshot is serialized to a JSON file on disk. Phase 2 then builds a brand-new
 * workflow, a brand-new InMemoryStore, and a brand-new Mastra instance, hydrates
 * the store from the JSON file ONLY, recreates the Run by its persisted runId, and
 * resumes. The only thing crossing the boundary is the on-disk snapshot — exactly
 * what a durable store (LibSQL/Postgres) replays after a real process restart.
 *
 * A separate-OS-process variant exists as resume-phase1.ts / resume-phase2.ts
 * (runnable under tsx) and produces the same result; it is omitted from the
 * automated test to avoid depending on a globally-resolvable tsx binary.
 *
 * Run: pnpm -F orchestrator exec vitest run -c spikes/oq-m01/vitest.config.ts
 */
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Mastra } from '@mastra/core';
import { InMemoryStore } from '@mastra/core/storage';
import { buildResumeWorkflow, initialLoopState, type LoopState } from './workflow.js';
import { dumpSnapshot, hydrateSnapshot } from './snapshot-io.js';

const SUSPEND_AT = 1;
const WORKFLOW_NAME = 'oq_m01_resume';

describe('OQ-M01 mid-loop suspend/resume across a simulated restart', () => {
  it('preserves the iteration counter after rehydrating from an on-disk snapshot', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'oq-m01-resume-'));
    const snapshotFile = join(outDir, 'snapshot.json');

    // ---- Phase 1: start, suspend at iteration 1, dump snapshot, discard runtime.
    let runId: string;
    {
      const { workflow } = buildResumeWorkflow(outDir, SUSPEND_AT);
      const store = new InMemoryStore();
      const mastra = new Mastra({ storage: store, workflows: { [WORKFLOW_NAME]: workflow }, logger: false });
      const run = await mastra.getWorkflow(WORKFLOW_NAME).createRun();
      runId = run.runId;
      const result = await run.start({ inputData: initialLoopState });
      expect(result.status).toBe('suspended');
      await dumpSnapshot(store, WORKFLOW_NAME, runId, snapshotFile);
    }

    // Iteration 0 ran and wrote its file; iteration 1 suspended before writing.
    expect(readdirSync(outDir).filter((f) => f.endsWith('.md')).sort()).toEqual([
      '07_slice_review.0.md',
    ]);

    // ---- Phase 2: brand-new everything, hydrate from disk only, resume.
    {
      const { workflow, loopStep } = buildResumeWorkflow(outDir, SUSPEND_AT);
      const store = new InMemoryStore();
      const payload = await hydrateSnapshot(store, snapshotFile);
      expect(payload.runId).toBe(runId);

      const mastra = new Mastra({ storage: store, workflows: { [WORKFLOW_NAME]: workflow }, logger: false });
      const run = await mastra.getWorkflow(WORKFLOW_NAME).createRun({ runId: payload.runId });
      const result = await run.resume({ step: loopStep, resumeData: { ack: true } });

      expect(result.status).toBe('success');
      if (result.status !== 'success') throw new Error('resume did not succeed');
      const finalState = result.result as LoopState;
      // Resume continued from iteration 1 (NOT restarting at 0) and finished all 3.
      expect(finalState.iteration).toBe(3);
      expect(finalState.passed).toBe(true);
    }

    // Files for iterations 0,1,2 all present — counter survived the restart and
    // numbering stayed monotonic across the boundary.
    expect(readdirSync(outDir).filter((f) => f.endsWith('.md')).sort()).toEqual([
      '07_slice_review.0.md',
      '07_slice_review.1.md',
      '07_slice_review.2.md',
    ]);
  });
});
