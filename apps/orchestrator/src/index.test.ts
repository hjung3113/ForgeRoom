import { describe, expect, it } from 'vitest';

import { version } from './index.js';

describe('orchestrator entrypoint', () => {
  it('exposes a version string', () => {
    expect(typeof version).toBe('string');
    expect(version.length).toBeGreaterThan(0);
  });
});
