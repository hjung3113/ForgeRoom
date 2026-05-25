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

  it('carries an optional model_policy and validates the ref when policyExists is provided (ADR-024)', () => {
    const registry = IntentRegistry.fromConfig(
      { codex_execute: { kind: 'execute', agent: 'codex', harness: 'implementation', model_policy: 'code_default' } },
      { policyExists: (id) => id === 'code_default' },
    );
    expect(registry.resolve('codex_execute').model_policy).toBe('code_default');
  });

  it('fails fast when an intent references an unknown model policy', () => {
    expect(() =>
      IntentRegistry.fromConfig(
        { codex_execute: { kind: 'execute', agent: 'codex', harness: 'implementation', model_policy: 'ghost' } },
        { policyExists: () => false },
      ),
    ).toThrow(/Unknown model policy/);
  });

  it('omits model_policy when not specified', () => {
    const registry = IntentRegistry.fromConfig({
      codex_execute: { kind: 'execute', agent: 'codex', harness: 'implementation' },
    });
    expect(registry.resolve('codex_execute').model_policy).toBeUndefined();
  });
});
