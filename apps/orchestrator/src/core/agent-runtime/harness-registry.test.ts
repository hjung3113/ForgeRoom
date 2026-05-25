import { describe, expect, it } from 'vitest';

import { HarnessRegistry } from './harness-registry.js';
import { RegistryValidationError } from '../registries/intent-registry.js';

describe('HarnessRegistry', () => {
  it('loads harness source locations keyed by harness id', () => {
    const registry = HarnessRegistry.fromConfig({
      review: { source: '.forgeroom/harnesses/review' },
    });

    expect(registry.has('review')).toBe(true);
    expect(registry.resolve('review')).toEqual({
      id: 'review',
      source: '.forgeroom/harnesses/review',
    });
  });

  it('rejects harnesses without a source', () => {
    expect(() =>
      HarnessRegistry.fromConfig({
        review: {},
      }),
    ).toThrow(RegistryValidationError);
  });

  it('rejects unsafe harness source paths', () => {
    expect(() =>
      HarnessRegistry.fromConfig({
        review: { source: '../outside' },
      }),
    ).toThrow(/source/);
  });
});
