/**
 * OQ-M01 spike — Part A test: `.dountil()` iteration numbering.
 *
 * Run: `pnpm -F orchestrator exec vitest run spikes/oq-m01/loop.test.ts`
 */
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runLoop } from './run-loop.js';

describe('OQ-M01 .dountil() iteration index', () => {
  it('runs 3 iterations and numbers files by threaded iteration index', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oq-m01-loop-test-'));
    const report = await runLoop(dir);

    // Loop stops once iteration reaches the 3-iteration target (final state
    // carries iteration === 3 because the body increments before returning).
    expect(report.finalState.passed).toBe(true);
    expect(report.finalState.iteration).toBe(3);

    // One marker file per iteration, numbered 0,1,2 — proves per-iteration
    // numbering survives the loop.
    const files = readdirSync(dir).sort();
    expect(files).toEqual([
      '07_slice_review.0.md',
      '07_slice_review.1.md',
      '07_slice_review.2.md',
    ]);
  });

  it('does NOT expose a native iteration counter in the execute body', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oq-m01-native-test-'));
    const report = await runLoop(dir);
    // Empirical OQ-M01 answer: outcome (b). No iteration-like key on the
    // execute context — the index must be threaded manually.
    expect(report.nativeIterationVisibleInBody).toBe(false);
  });
});
