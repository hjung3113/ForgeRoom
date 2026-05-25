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
}

interface RawIntent {
  kind?: unknown;
  agent?: unknown;
  harness?: unknown;
}

export class IntentRegistry {
  private constructor(private readonly intents: Map<string, ResolvedIntent>) {}

  static fromConfig(config: Record<string, RawIntent>): IntentRegistry {
    const intents = new Map<string, ResolvedIntent>();

    for (const [id, raw] of Object.entries(config)) {
      if (id.trim() === '') {
        throw new RegistryValidationError('intent id must not be empty');
      }

      const kind = requiredString(raw.kind, `intent ${id}.kind`);
      const agent = requiredString(raw.agent, `intent ${id}.agent`);
      const harness = requiredString(raw.harness, `intent ${id}.harness`);

      intents.set(id, { id, kind, agent, harness });
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
