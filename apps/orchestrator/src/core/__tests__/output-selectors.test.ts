import { describe, expect, it } from 'vitest';

import { WorkflowError } from '../errors';
import { parseReviewPassedOutput, parseSlicesOutput } from '../output-selectors';

describe('parseSlicesOutput', () => {
  it('parses top-level bullets from the Slices section', () => {
    const slices = parseSlicesOutput(`# Plan

## Summary
- ignored

## Slices
- Add task creation
-
  - nested implementation note
- Wire lock release

## Risks
- ignored risk
`);

    expect(slices).toEqual(['Add task creation', 'Wire lock release']);
  });

  it('rejects missing or empty Slices sections as output contract failures', () => {
    expect(() => parseSlicesOutput('## Summary\n- no slices here')).toThrow(WorkflowError);

    try {
      parseSlicesOutput('## Slices\n  - nested only');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowError);
      expect((error as WorkflowError).code).toBe('output_contract_failed');
      return;
    }

    throw new Error('Expected parseSlicesOutput to throw');
  });
});

describe('parseReviewPassedOutput', () => {
  it('parses the exact Review Result header from the first non-empty line', () => {
    expect(parseReviewPassedOutput('\n\nReview Result: pass\nLooks good')).toBe(true);
    expect(parseReviewPassedOutput('Review Result: fail\nNeeds changes')).toBe(false);
  });

  it('rejects missing or non-exact Review Result headers', () => {
    for (const output of ['Looks good\nReview Result: pass', 'Review result: pass', 'Review Result: PASS']) {
      expect(() => parseReviewPassedOutput(output)).toThrow(WorkflowError);
    }
  });
});
