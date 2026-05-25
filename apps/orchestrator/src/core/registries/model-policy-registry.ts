import type { ResolvedRuntimeTarget } from '../agent-runtime/agent-runner.js';
import { RegistryValidationError, requiredString } from './intent-registry.js';

/**
 * A resolved static model policy (ADR-024, Phase 2A). Only the PRIMARY target
 * is supported; fallback/escalation are a later issue (#66) and their config
 * keys are REJECTED here rather than silently ignored.
 */
export interface ResolvedModelPolicy {
  id: string;
  description: string | null;
  primary: ResolvedRuntimeTarget;
}

interface RawModelPolicy {
  description?: unknown;
  primary?: unknown;
  // Reserved-but-unsupported in B2; presence is a hard error.
  fallback?: unknown;
  escalate_if?: unknown;
  budgetMode?: unknown;
}

interface RawPrimary {
  provider?: unknown;
  runtime?: unknown;
  model?: unknown;
  permissionProfile?: unknown;
}

const UNSUPPORTED_KEYS = ['fallback', 'escalate_if', 'budgetMode'] as const;

export class ModelPolicyRegistry {
  private constructor(private readonly policies: Map<string, ResolvedModelPolicy>) {}

  static fromConfig(config: Record<string, RawModelPolicy>): ModelPolicyRegistry {
    const policies = new Map<string, ResolvedModelPolicy>();

    for (const [id, raw] of Object.entries(config)) {
      if (id.trim() === '') {
        throw new RegistryValidationError('model policy id must not be empty');
      }

      for (const key of UNSUPPORTED_KEYS) {
        if (raw[key] !== undefined) {
          throw new RegistryValidationError(
            `model policy ${id}.${key} is not supported in Phase 2A (static policies only; see #66)`,
          );
        }
      }

      if (raw.primary === null || typeof raw.primary !== 'object') {
        throw new RegistryValidationError(`Missing required field: model policy ${id}.primary`);
      }
      const primary = raw.primary as RawPrimary;
      const providerId = requiredString(primary.provider, `model policy ${id}.primary.provider`);
      const runtime = requiredString(primary.runtime, `model policy ${id}.primary.runtime`);
      const model = requiredString(primary.model, `model policy ${id}.primary.model`);
      const permissionProfile =
        primary.permissionProfile === undefined ? undefined : requiredString(primary.permissionProfile, `model policy ${id}.primary.permissionProfile`);

      policies.set(id, {
        id,
        description: typeof raw.description === 'string' ? raw.description : null,
        primary: {
          providerId,
          runtime,
          model,
          ...(permissionProfile === undefined ? {} : { permissionProfile }),
        },
      });
    }

    return new ModelPolicyRegistry(policies);
  }

  has(policyId: string): boolean {
    return this.policies.has(policyId);
  }

  /** Resolve a policy to its provider-neutral PRIMARY runtime target. */
  resolveTarget(policyId: string): ResolvedRuntimeTarget {
    const policy = this.policies.get(policyId);
    if (!policy) {
      throw new RegistryValidationError(`Unknown model policy: ${policyId}`);
    }
    return policy.primary;
  }
}
