/**
 * Step Harness manifest schema (ADR-029). `harness.yaml` is the structured
 * manifest of a full Step Harness. It is ADDITIVE over ADR-027: `prompt_contract`
 * references the existing markdown contract (no rewrite). `output`, `permissions`,
 * and `tools` are parsed + validated here but CONSUMED later — by the
 * OutputContractValidator (E2) and RuntimeProfileCompiler (E4). The compiler
 * never claims provider runtime enforcement (OpenClaw has no per-call
 * permission/tool surface); hard enforcement is ForgeRoom-owned (ADR-029 §4).
 */

export interface HarnessOutputContract {
  required_sections?: string[];
  first_line_regex?: string;
  min_bytes?: number;
}

export interface HarnessPermissions {
  filesystem?: string;
  shell?: string;
  network?: string;
}

export interface HarnessTools {
  allow?: string[];
  deny?: string[];
}

export interface HarnessManifest {
  id: string;
  description: string;
  /** Intent kinds this harness applies to (advisory; validated elsewhere). */
  applies_to_kinds: string[];
  /** Harness-dir-relative path to the prompt/output contract markdown. */
  prompt_contract: string;
  output: HarnessOutputContract;
  permissions: HarnessPermissions;
  tools: HarnessTools;
}

export class HarnessManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessManifestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v): v is string => typeof v === 'string')) {
    throw new HarnessManifestError(`${field} must be a string array`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new HarnessManifestError(`${field} must be a string`);
  return value;
}

/**
 * Parse + validate a parsed-YAML object into a {@link HarnessManifest}. Fails
 * fast on a malformed manifest so a non-shippable harness surfaces at boot.
 * `expectedId` (the registry id) must match `harness.yaml`'s `id`.
 */
export function parseHarnessManifest(expectedId: string, raw: unknown): HarnessManifest {
  if (!isRecord(raw)) {
    throw new HarnessManifestError(`harness ${expectedId}: harness.yaml must be a mapping`);
  }

  const id = raw.id;
  if (typeof id !== 'string' || id.trim() === '') {
    throw new HarnessManifestError(`harness ${expectedId}: id must be a non-empty string`);
  }
  if (id !== expectedId) {
    throw new HarnessManifestError(`harness ${expectedId}: harness.yaml id "${id}" does not match registry id`);
  }

  const description = raw.description;
  if (typeof description !== 'string' || description.trim() === '') {
    throw new HarnessManifestError(`harness ${id}: description is required`);
  }

  const promptContract = raw.prompt_contract;
  if (typeof promptContract !== 'string' || promptContract.trim() === '') {
    throw new HarnessManifestError(`harness ${id}: prompt_contract is required`);
  }
  if (path_unsafe(promptContract)) {
    throw new HarnessManifestError(`harness ${id}: unsafe prompt_contract path: ${promptContract}`);
  }

  const appliesTo = raw.applies_to;
  const kinds = isRecord(appliesTo) ? stringArray(appliesTo.kinds, `harness ${id}.applies_to.kinds`) : [];

  const output = isRecord(raw.output) ? parseOutput(id, raw.output) : {};
  const permissions = isRecord(raw.permissions) ? parsePermissions(id, raw.permissions) : {};
  const tools = isRecord(raw.tools) ? parseTools(id, raw.tools) : {};

  return {
    id,
    description,
    applies_to_kinds: kinds,
    prompt_contract: promptContract,
    output,
    permissions,
    tools,
  };
}

function parseOutput(id: string, raw: Record<string, unknown>): HarnessOutputContract {
  const out: HarnessOutputContract = {};
  if (raw.required_sections !== undefined) {
    out.required_sections = stringArray(raw.required_sections, `harness ${id}.output.required_sections`);
  }
  const firstLine = optionalString(raw.first_line_regex, `harness ${id}.output.first_line_regex`);
  if (firstLine !== undefined) out.first_line_regex = firstLine;
  if (raw.min_bytes !== undefined) {
    if (typeof raw.min_bytes !== 'number' || !Number.isInteger(raw.min_bytes) || raw.min_bytes < 0) {
      throw new HarnessManifestError(`harness ${id}.output.min_bytes must be a non-negative integer`);
    }
    out.min_bytes = raw.min_bytes;
  }
  return out;
}

function parsePermissions(id: string, raw: Record<string, unknown>): HarnessPermissions {
  const p: HarnessPermissions = {};
  const fs = optionalString(raw.filesystem, `harness ${id}.permissions.filesystem`);
  if (fs !== undefined) p.filesystem = fs;
  const shell = optionalString(raw.shell, `harness ${id}.permissions.shell`);
  if (shell !== undefined) p.shell = shell;
  const network = optionalString(raw.network, `harness ${id}.permissions.network`);
  if (network !== undefined) p.network = network;
  return p;
}

function parseTools(id: string, raw: Record<string, unknown>): HarnessTools {
  const t: HarnessTools = {};
  if (raw.allow !== undefined) t.allow = stringArray(raw.allow, `harness ${id}.tools.allow`);
  if (raw.deny !== undefined) t.deny = stringArray(raw.deny, `harness ${id}.tools.deny`);
  return t;
}

function path_unsafe(rel: string): boolean {
  return rel.startsWith('/') || rel.includes('..');
}
