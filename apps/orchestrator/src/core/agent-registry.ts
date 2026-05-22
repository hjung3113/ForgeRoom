import { HarnessRegistry } from './harness-registry';
import { RegistryValidationError, requiredString } from './intent-registry';

export interface ResolvedAgent {
  agentId: string;
  provider: 'openclaw';
  runtime: string;
  model: string;
  harness: string;
}

interface RawAgent {
  provider?: unknown;
  runtime?: unknown;
  model?: unknown;
  harness?: unknown;
}

export class AgentRegistry {
  private constructor(private readonly agents: Map<string, ResolvedAgent>) {}

  static fromConfig(
    config: Record<string, RawAgent>,
    harnessRegistry: HarnessRegistry,
  ): AgentRegistry {
    const agents = new Map<string, ResolvedAgent>();

    for (const [agentId, raw] of Object.entries(config)) {
      if (agentId.trim() === '') {
        throw new RegistryValidationError('agent id must not be empty');
      }

      const provider = requiredString(raw.provider, `agent ${agentId}.provider`);
      if (provider !== 'openclaw') {
        throw new RegistryValidationError(`Unsupported Phase 1 provider: ${provider}`);
      }

      const runtime = requiredString(raw.runtime, `agent ${agentId}.runtime`);
      const model = requiredString(raw.model, `agent ${agentId}.model`);
      const harness = requiredString(raw.harness, `agent ${agentId}.harness`);
      if (!harnessRegistry.has(harness)) {
        throw new RegistryValidationError(`Unknown harness for agent ${agentId}: ${harness}`);
      }

      agents.set(agentId, { agentId, provider, runtime, model, harness });
    }

    return new AgentRegistry(agents);
  }

  has(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  resolve(agentId: string): ResolvedAgent {
    const agent = this.agents.get(agentId);

    if (!agent) {
      throw new RegistryValidationError(`Unknown agent: ${agentId}`);
    }

    return agent;
  }
}
