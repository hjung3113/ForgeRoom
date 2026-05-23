import { describe, expect, it } from 'vitest';

import { isStudioEnabled } from './gate.js';

describe('isStudioEnabled (production-OFF gate)', () => {
  it('is OFF when the opt-in flag is absent (production default)', () => {
    expect(isStudioEnabled({})).toBe(false);
  });

  it('is OFF for falsy / unrecognised flag values', () => {
    expect(isStudioEnabled({ FORGEROOM_STUDIO: '0' })).toBe(false);
    expect(isStudioEnabled({ FORGEROOM_STUDIO: 'false' })).toBe(false);
    expect(isStudioEnabled({ FORGEROOM_STUDIO: '' })).toBe(false);
    expect(isStudioEnabled({ FORGEROOM_STUDIO: 'maybe' })).toBe(false);
  });

  it('opts in for recognised truthy flag values', () => {
    for (const v of ['1', 'true', 'YES', 'on']) {
      expect(isStudioEnabled({ FORGEROOM_STUDIO: v })).toBe(true);
    }
  });
});
