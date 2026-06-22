import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Repo-root `templates/`, resolved the same way the app's defaultTemplateRoot does.
const templateRoot = fileURLToPath(new URL('../../../../../templates', import.meta.url));

// Step templates whose output IS the agent's reply message (ADR-029, #114). They
// pair with a harness prompt-contract that states "your reply IS the step output".
// They must NOT also instruct the agent to write its response under
// `.forgeroom/outputs/` — that contradiction caused empty NO_REPLY runs.
const REPLY_OUTPUT_TEMPLATES = ['refine_plan.md', 'implementation_plan.md', 'final_review.md', 'review_hotfix.md'];

describe('reply-as-output step templates (ADR-029)', () => {
  for (const name of REPLY_OUTPUT_TEMPLATES) {
    it(`${name} does not direct the response to a file, and states the reply IS the output`, async () => {
      const body = await readFile(path.join(templateRoot, name), 'utf8');
      // No affirmative "write your response to <file>" directive (the ADR-029 contradiction).
      expect(body).not.toMatch(/write your response to/i);
      // States the reply-as-output contract so the template stands alone, harness or not.
      expect(body).toMatch(/reply message IS the step output/i);
    });
  }
});
