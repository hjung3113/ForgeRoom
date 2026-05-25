import { describe, expect, it } from 'vitest';

import { ModelPolicyRegistry } from './model-policy-registry.js';
import { RegistryValidationError } from './intent-registry.js';

describe('ModelPolicyRegistry', () => {
  it('resolves a policy to its provider-neutral primary runtime target', () => {
    const registry = ModelPolicyRegistry.fromConfig({
      code_default: {
        description: 'd',
        primary: { provider: 'openclaw', runtime: 'claude-cli', model: 'anthropic/claude-opus-4-7' },
      },
    });

    expect(registry.has('code_default')).toBe(true);
    expect(registry.resolveTarget('code_default')).toEqual({
      providerId: 'openclaw',
      runtime: 'claude-cli',
      model: 'anthropic/claude-opus-4-7',
    });
  });

  it('carries an optional permissionProfile onto the target', () => {
    const registry = ModelPolicyRegistry.fromConfig({
      p: { primary: { provider: 'openclaw', runtime: 'r', model: 'm', permissionProfile: 'extended' } },
    });
    expect(registry.resolveTarget('p').permissionProfile).toBe('extended');
  });

  it.each(['fallback', 'escalate_if', 'budgetMode'])(
    'rejects the unsupported %s key rather than silently ignoring it (Phase 2A)',
    (key) => {
      expect(() =>
        ModelPolicyRegistry.fromConfig({
          p: { primary: { provider: 'openclaw', runtime: 'r', model: 'm' }, [key]: {} },
        }),
      ).toThrow(RegistryValidationError);
    },
  );

  it('fails fast when primary is missing', () => {
    expect(() => ModelPolicyRegistry.fromConfig({ p: { description: 'x' } })).toThrow(RegistryValidationError);
  });

  it('fails fast on a missing primary field', () => {
    expect(() =>
      ModelPolicyRegistry.fromConfig({ p: { primary: { provider: 'openclaw', runtime: 'r' } } }),
    ).toThrow(/model/);
  });

  it('throws on an unknown policy id', () => {
    const registry = ModelPolicyRegistry.fromConfig({});
    expect(() => registry.resolveTarget('nope')).toThrow(RegistryValidationError);
  });
});
