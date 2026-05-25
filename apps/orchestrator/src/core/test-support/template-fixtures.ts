import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Prompt-template names referenced by unit + integration test workflows. The
 * bundled product templates live in `<repo>/templates`; tests use an isolated
 * temp root so they never depend on the shipped set.
 */
const TEST_TEMPLATE_NAMES = [
  'plan.md',
  'impl.md',
  'build.md',
  'wrap.md',
  'review.md',
  'refine.md',
  'execute.md',
  'implementation_plan.md',
  'refine_plan.md',
  'slice_impl.md',
  'final_review.md',
  'final_refine.md',
  'hotfix.md',
  'review_hotfix.md',
  'review_diff.md',
  'refine_from_review.md',
] as const;

/**
 * Create a temp template root populated with placeholder-free stubs for every
 * template name the tests reference. `{{step_id}}` / `{{step_index}}` always
 * resolve, so rendering never throws regardless of a step's input_refs.
 */
export async function makeTestTemplateRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fr-templates-'));
  await Promise.all(
    TEST_TEMPLATE_NAMES.map((name) =>
      writeFile(
        path.join(dir, name),
        `# ${name}\n\nTest prompt template for step {{step_id}} (index {{step_index}}).\n`,
      ),
    ),
  );
  return dir;
}
