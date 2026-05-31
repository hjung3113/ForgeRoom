import { describe, expect, it } from 'vitest';

import { validateOutputContract } from './output-contract-validator.js';
import { WorkflowError } from '../errors.js';
import type { HarnessOutputContract } from '../agent-runtime/harness-manifest.js';

describe('validateOutputContract (ADR-029 E2)', () => {
  it('passes when no contract is given', () => {
    expect(() => validateOutputContract('anything', undefined)).not.toThrow();
  });

  it('passes when contract is empty', () => {
    expect(() => validateOutputContract('anything', {})).not.toThrow();
  });

  it('enforces min_bytes', () => {
    const c: HarnessOutputContract = { min_bytes: 10 };
    expect(() => validateOutputContract('short', c)).toThrowError(WorkflowError);
    expect(() => validateOutputContract('long enough content', c)).not.toThrow();
  });

  it('enforces first_line_regex against the first non-empty line', () => {
    const c: HarnessOutputContract = { first_line_regex: '^Review Result: (pass|fail)$' };
    expect(() => validateOutputContract('\n\nReview Result: pass\n\nfindings', c)).not.toThrow();
    expect(() => validateOutputContract('Review Result: maybe\n', c)).toThrowError(/first line/);
    expect(() => validateOutputContract('   \n', c)).toThrowError(/no non-empty first line/);
  });

  it('enforces required_sections by markdown heading text', () => {
    const c: HarnessOutputContract = { required_sections: ['Slices'] };
    expect(() => validateOutputContract('## Slices\n- one\n- two\n', c)).not.toThrow();
    expect(() => validateOutputContract('## Other\n', c)).toThrowError(/missing required section.*Slices/);
  });

  it('throws WorkflowError with output_contract_failed failure code', () => {
    try {
      validateOutputContract('x', { min_bytes: 100 });
    } catch (e) {
      const err = e as WorkflowError;
      expect(err).toBeInstanceOf(WorkflowError);
      expect(err.code).toBe('output_contract_failed');
      return;
    }
    throw new Error('expected throw');
  });
});
