import { describe, expect, it } from 'vitest';

import { AgentRegistry } from './agent-registry.js';
import { HarnessRegistry } from './harness-registry.js';
import { RegistryValidationError } from '../registries/intent-registry.js';

describe('AgentRegistry', () => {
  const harnesses = HarnessRegistry.fromConfig({
    implementation: { source: '.forgeroom/harnesses/implementation' },
  });

  it("resolves MVP 'openclaw'-provider agents", () => {
    const registry = AgentRegistry.fromConfig(
      {
        claude: {
          provider: 'openclaw',
          runtime: 'claude-cli',
          model: 'anthropic/claude-opus-4-7',
          harness: 'implementation',
        },
      },
      harnesses,
    );

    expect(registry.resolve('claude')).toEqual({
      agentId: 'claude',
      provider: 'openclaw',
      runtime: 'claude-cli',
      model: 'anthropic/claude-opus-4-7',
      harness: 'implementation',
    });
  });

  it("rejects non-'openclaw' providers in Phase 1", () => {
    expect(() =>
      AgentRegistry.fromConfig(
        {
          codex: {
            provider: 'opencode',
            runtime: 'openai-codex',
            model: 'gpt-5',
            harness: 'implementation',
          },
        },
        harnesses,
      ),
    ).toThrow(/provider/);
  });

  it('rejects agents referencing unknown harnesses', () => {
    expect(() =>
      AgentRegistry.fromConfig(
        {
          codex: {
            provider: 'openclaw',
            runtime: 'openai-codex',
            model: 'gpt-5',
            harness: 'missing',
          },
        },
        harnesses,
      ),
    ).toThrow(RegistryValidationError);
  });
});
