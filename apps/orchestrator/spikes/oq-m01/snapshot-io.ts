/**
 * OQ-M01 spike — cross-process snapshot bridge.
 *
 * Mastra's `InMemoryStore` does not survive process death. To prove a
 * mid-loop suspend/resume across a *fresh* process, we serialize the workflow
 * run snapshot to a JSON file after suspend (process 1) and hydrate a brand-new
 * `InMemoryStore` from it before resume (process 2). All state crosses the
 * process boundary through disk only — the same path a real restart takes when
 * backed by a durable store (LibSQL/Postgres in production).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { InMemoryStore } from '@mastra/core/storage';
import type { WorkflowRunState } from '@mastra/core/workflows';

export interface SnapshotFile {
  workflowName: string;
  runId: string;
  snapshot: WorkflowRunState;
}

export async function dumpSnapshot(
  store: InMemoryStore,
  workflowName: string,
  runId: string,
  filePath: string,
): Promise<void> {
  const workflows = await store.getStore('workflows');
  if (!workflows) throw new Error('store has no workflows domain');
  const snapshot = await workflows.loadWorkflowSnapshot({ workflowName, runId });
  if (!snapshot) throw new Error(`no snapshot for run ${runId}`);
  const payload: SnapshotFile = { workflowName, runId, snapshot };
  writeFileSync(filePath, JSON.stringify(payload), 'utf8');
}

export async function hydrateSnapshot(store: InMemoryStore, filePath: string): Promise<SnapshotFile> {
  const payload = JSON.parse(readFileSync(filePath, 'utf8')) as SnapshotFile;
  const workflows = await store.getStore('workflows');
  if (!workflows) throw new Error('store has no workflows domain');
  await workflows.persistWorkflowSnapshot({
    workflowName: payload.workflowName,
    runId: payload.runId,
    snapshot: payload.snapshot,
  });
  return payload;
}
