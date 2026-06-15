import { describe, expect, it } from 'vitest';

import { parseHarnessManifest, HarnessManifestError } from './harness-manifest.js';

const valid = {
  id: 'review',
  description: 'Read-only diff review harness.',
  applies_to: { kinds: ['review'] },
  prompt_contract: './prompt-contract.md',
  output: { first_line_regex: '^Review Result: (pass|fail)$', required_sections: ['Findings'] },
  permissions: { filesystem: 'read_only', shell: 'disabled' },
  tools: { allow: ['read_file'], deny: ['write_file'] },
};

describe('parseHarnessManifest (ADR-029)', () => {
  it('parses a full manifest', () => {
    expect(parseHarnessManifest('review', valid)).toEqual({
      id: 'review',
      description: 'Read-only diff review harness.',
      applies_to_kinds: ['review'],
      prompt_contract: './prompt-contract.md',
      output: { first_line_regex: '^Review Result: (pass|fail)$', required_sections: ['Findings'] },
      permissions: { filesystem: 'read_only', shell: 'disabled' },
      tools: { allow: ['read_file'], deny: ['write_file'] },
    });
  });

  it('defaults optional sections to empty', () => {
    const m = parseHarnessManifest('p', { id: 'p', description: 'd', prompt_contract: './c.md' });
    expect(m).toMatchObject({ applies_to_kinds: [], output: {}, permissions: {}, tools: {} });
  });

  it('requires id to match the registry id', () => {
    expect(() => parseHarnessManifest('review', { ...valid, id: 'other' })).toThrow(/does not match registry id/);
  });

  it.each([
    ['missing prompt_contract', { id: 'p', description: 'd' }, /prompt_contract is required/],
    ['unsafe prompt_contract', { id: 'p', description: 'd', prompt_contract: '../escape.md' }, /unsafe prompt_contract/],
    ['missing description', { id: 'p', prompt_contract: './c.md' }, /description is required/],
    ['non-mapping', 'nope', /must be a mapping/],
    ['bad min_bytes', { id: 'p', description: 'd', prompt_contract: './c.md', output: { min_bytes: -1 } }, /min_bytes/],
  ])('rejects %s', (_label, raw, pattern) => {
    expect(() => parseHarnessManifest('p', raw)).toThrow(pattern as RegExp);
  });

  it('throws HarnessManifestError type', () => {
    expect(() => parseHarnessManifest('p', 'x')).toThrow(HarnessManifestError);
  });
});
