import { describe, expect, it } from 'vitest';

import { IntentRegistry, RegistryValidationError } from './intent-registry.js';

describe('IntentRegistry', () => {
  it('loads valid intents keyed by intent id', () => {
    const registry = IntentRegistry.fromConfig({
      codex_execute: {
        kind: 'execute',
        agent: 'codex',
        harness: 'implementation',
      },
    });

    expect(registry.has('codex_execute')).toBe(true);
    expect(registry.resolve('codex_execute')).toEqual({
      id: 'codex_execute',
      kind: 'execute',
      agent: 'codex',
      harness: 'implementation',
    });
  });

  it('rejects intents missing required execution fields', () => {
    expect(() =>
      IntentRegistry.fromConfig({
        codex_execute: {
          kind: 'execute',
          agent: 'codex',
        },
      }),
    ).toThrow(RegistryValidationError);
  });

  it('rejects empty intent ids', () => {
    expect(() =>
      IntentRegistry.fromConfig({
        '': {
          kind: 'execute',
          agent: 'codex',
          harness: 'implementation',
        },
      }),
    ).toThrow(/intent id/);
  });
});
