export class RegistryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryValidationError';
  }
}

export interface ResolvedIntent {
  id: string;
  kind: string;
  agent: string;
  harness: string;
  /** Optional model policy ref (ADR-024); absent → agent-derived runtime/model. */
  model_policy?: string;
}

interface RawIntent {
  kind?: unknown;
  agent?: unknown;
  harness?: unknown;
  model_policy?: unknown;
}

export interface IntentRegistryOptions {
  /** Fail-fast validator for `model_policy` refs (ADR-024). Default: accept all. */
  policyExists?: (policyId: string) => boolean;
}

export class IntentRegistry {
  private constructor(private readonly intents: Map<string, ResolvedIntent>) {}

  static fromConfig(config: Record<string, RawIntent>, options: IntentRegistryOptions = {}): IntentRegistry {
    const intents = new Map<string, ResolvedIntent>();
    const policyExists = options.policyExists ?? ((): boolean => true);

    for (const [id, raw] of Object.entries(config)) {
      if (id.trim() === '') {
        throw new RegistryValidationError('intent id must not be empty');
      }

      const kind = requiredString(raw.kind, `intent ${id}.kind`);
      const agent = requiredString(raw.agent, `intent ${id}.agent`);
      const harness = requiredString(raw.harness, `intent ${id}.harness`);
      const modelPolicy =
        raw.model_policy === undefined ? undefined : requiredString(raw.model_policy, `intent ${id}.model_policy`);
      if (modelPolicy !== undefined && !policyExists(modelPolicy)) {
        throw new RegistryValidationError(`Unknown model policy for intent ${id}: ${modelPolicy}`);
      }

      intents.set(id, { id, kind, agent, harness, ...(modelPolicy === undefined ? {} : { model_policy: modelPolicy }) });
    }

    return new IntentRegistry(intents);
  }

  has(intentId: string): boolean {
    return this.intents.has(intentId);
  }

  resolve(intentId: string): ResolvedIntent {
    const intent = this.intents.get(intentId);

    if (!intent) {
      throw new RegistryValidationError(`Unknown intent: ${intentId}`);
    }

    return intent;
  }
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RegistryValidationError(`Missing required field: ${field}`);
  }

  return value;
}
