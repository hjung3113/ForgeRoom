import { describe, expect, it } from 'vitest';

import { version } from '../../src/index.js';

describe('toolchain integration smoke', () => {
  it('imports the orchestrator package across the integration boundary', () => {
    expect(version).toBeTypeOf('string');
  });
});
