/**
 * OQ-M02 spike: can a step nested inside Mastra `.foreach()` suspend
 * mid-iteration and resume to the SAME iteration (not restart, not skip)?
 *
 * Plain JS step functions only — no LLM/model. The step suspends on the
 * first item it sees that has not yet been "approved", records which items
 * it actually processed via a module-level side-effect log, then we resume
 * and assert the loop continues from the suspended item.
 *
 * Run: pnpm -F orchestrator spike:oq-m02
 */
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';

// Side-effect log: every time the inner step BODY runs to completion for an
// item, we push that item. If foreach restarts the loop on resume, already
// processed items will appear twice. If it skips, the suspended item is
// missing. A clean mid-iteration resume yields each item exactly once.
const processed: string[] = [];

const itemSchema = z.object({ name: z.string(), approved: z.boolean() });

const handleItem = createStep({
  id: 'handle-item',
  inputSchema: itemSchema,
  outputSchema: z.object({ handled: z.string() }),
  resumeSchema: z.object({ approved: z.boolean() }),
  suspendSchema: z.object({ waitingFor: z.string() }),
  execute: async ({ inputData, resumeData, suspend }) => {
    const approved = resumeData?.approved ?? inputData.approved;
    if (!approved) {
      // Pause inside the iteration for this specific item.
      return await suspend({ waitingFor: inputData.name });
    }
    processed.push(inputData.name);
    return { handled: inputData.name };
  },
});

const wf = createWorkflow({
  id: 'oq-m02-foreach-suspend',
  inputSchema: z.array(itemSchema),
  outputSchema: z.array(z.object({ handled: z.string() })),
})
  .foreach(handleItem)
  .commit();

async function main(): Promise<void> {
  const { Mastra } = await import('@mastra/core');
  const { MockStore } = await import('@mastra/core/storage');
  // Persisted snapshot store is required for suspend/resume across run.start/run.resume.
  const mastra = new Mastra({
    workflows: { wf },
    storage: new MockStore(),
  });
  const workflow = mastra.getWorkflow('wf');
  const run = await workflow.createRun();

  // Item index 1 ("b") is NOT pre-approved → step suspends at iteration 1.
  const items = [
    { name: 'a', approved: true },
    { name: 'b', approved: false },
    { name: 'c', approved: true },
  ];

  const first = await run.start({ inputData: items });
  console.log('after start: status =', first.status);
  console.log('processed after start:', JSON.stringify(processed));
  console.log(
    'suspended steps:',
    JSON.stringify((first as { suspended?: unknown }).suspended ?? null),
  );

  if (first.status !== 'suspended') {
    console.log('OUTCOME: foreach did NOT suspend mid-iteration. full result:');
    console.log(JSON.stringify(first, null, 2).slice(0, 2000));
    process.exitCode = 1;
    return;
  }

  // Resume: approve item "b".
  const resumed = await run.resume({ resumeData: { approved: true } });
  console.log('after resume: status =', resumed.status);
  console.log('processed after resume:', JSON.stringify(processed));
  console.log('result:', JSON.stringify(resumed, null, 2).slice(0, 2000));

  const ok =
    resumed.status === 'success' &&
    JSON.stringify(processed) === JSON.stringify(['a', 'b', 'c']);
  console.log('CLEAN_MID_ITERATION_RESUME =', ok);
  process.exitCode = ok ? 0 : 2;
}

void main();
