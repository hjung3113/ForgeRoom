import { WorkflowError } from '../errors.js';

const SLICES_HEADING = '## Slices';
const REVIEW_PASS = 'Review Result: pass';
const REVIEW_FAIL = 'Review Result: fail';

export function parseSlicesOutput(output: string): string[] {
  const slices: string[] = [];
  let inSlicesSection = false;

  for (const rawLine of output.split(/\r?\n/)) {
    if (isHeading(rawLine)) {
      if (inSlicesSection) break;
      inSlicesSection = rawLine.trim() === SLICES_HEADING;
      continue;
    }

    if (!inSlicesSection || !rawLine.startsWith('- ')) continue;

    const slice = rawLine.slice(2).trim();
    if (slice.length > 0) slices.push(slice);
  }

  if (slices.length === 0) {
    throw new WorkflowError('output_contract_failed', 'Missing non-empty top-level bullets in ## Slices');
  }

  return slices;
}

export function parseReviewPassedOutput(output: string): boolean {
  const firstContentLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (firstContentLine === REVIEW_PASS) return true;
  if (firstContentLine === REVIEW_FAIL) return false;

  throw new WorkflowError('output_contract_failed', 'Missing exact Review Result: pass/fail header');
}

function isHeading(line: string): boolean {
  return /^#{1,6}\s+\S/.test(line.trim());
}
