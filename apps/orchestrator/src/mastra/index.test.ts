import { describe, expect, it } from 'vitest';

import { buildStudioMastra } from './index.js';
import { SAMPLE_WORKFLOW_ID } from '../studio/sample-config.js';

describe('Studio Mastra entry (production-OFF)', () => {
  it('registers no workflows when the gate is OFF (production default)', () => {
    const mastra = buildStudioMastra(false);
    expect(() => mastra.getWorkflow(SAMPLE_WORKFLOW_ID)).toThrow();
  });

  it('registers the sample workflow when the gate is ON', () => {
    const mastra = buildStudioMastra(true);
    const wf = mastra.getWorkflow(SAMPLE_WORKFLOW_ID);
    expect((wf as { id: string }).id).toBe(SAMPLE_WORKFLOW_ID);
  });
});
