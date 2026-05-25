import { RegistryValidationError, requiredString } from '../registries/intent-registry.js';

export interface ResolvedHarness {
  id: string;
  source: string;
}

interface RawHarness {
  source?: unknown;
}

export class HarnessRegistry {
  private constructor(private readonly harnesses: Map<string, ResolvedHarness>) {}

  static fromConfig(config: Record<string, RawHarness>): HarnessRegistry {
    const harnesses = new Map<string, ResolvedHarness>();

    for (const [id, raw] of Object.entries(config)) {
      if (id.trim() === '') {
        throw new RegistryValidationError('harness id must not be empty');
      }

      const source = requiredString(raw.source, `harness ${id}.source`);
      if (source.startsWith('/') || source.includes('..')) {
        throw new RegistryValidationError(`Unsafe harness source: ${source}`);
      }

      harnesses.set(id, { id, source });
    }

    return new HarnessRegistry(harnesses);
  }

  has(harnessId: string): boolean {
    return this.harnesses.has(harnessId);
  }

  resolve(harnessId: string): ResolvedHarness {
    const harness = this.harnesses.get(harnessId);

    if (!harness) {
      throw new RegistryValidationError(`Unknown harness: ${harnessId}`);
    }

    return harness;
  }
}
