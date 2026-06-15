/**
 * RuntimeProfileCompiler (ADR-029 E4).
 *
 * Compiles a harness manifest's permissions/tools into a per-step profile of
 * three parts (ADR-029 §4):
 *
 *  (a) **advisory text** — a soft prompt/AGENTS block injected into the
 *      rendered prompt. The provider model is *asked* to honor it; OpenClaw
 *      itself enforces NOTHING (its CLI has no per-call permission/tool flags).
 *  (b) **gate config** — ForgeRoom-owned HARD enforcement config. Currently
 *      consumed by {@link ApprovalGate}:
 *        - `shell` — `disabled` denies every project-shell command (check
 *          commands etc). Agent-execution synthetic is exempt; an agent must
 *          still be able to write its declared output file.
 *        - `filesystem` — `read_only` restricts agent-execution writes to
 *          the `.forgeroom/outputs/` and `.forgeroom/logs/` channels.
 *        - `network`, `tools.allow`, `tools.deny` — emitted into advisory
 *          text only. Hard enforcement DEFERRED (no current choke point;
 *          requires a provider-runtime callback or sandbox layer).
 *      Producing the full config remains the compiler's contract; integration
 *      additional choke points may bind further fields over time.
 *  (c) `providerAgentId` — passed through from {@link RuntimeSession} if the
 *      caller already selected one (ADR-028 #85). The compiler does not derive
 *      one on its own; provider-side enforcement still does not exist.
 *
 * NEVER produce output claiming the provider runtime-enforces permissions —
 * that would lie. Hard enforcement is ForgeRoom-owned (ADR-029 §4).
 */
import type { HarnessManifest } from '../agent-runtime/harness-manifest.js';

export interface CompiledRuntimeProfile {
  /** Soft advisory text — injected into the rendered prompt next to the harness contract. */
  advisory: string;
  /**
   * ForgeRoom-side enforcement config. {@link ApprovalGate} consumes `shell`
   * and `filesystem`. `network` / `toolsAllow` / `toolsDeny` are produced
   * here but enforcement is deferred (see header comment).
   */
  gate: GateProfile;
  /** Pre-selected provider-native agent (ADR-028 #85), passed through unchanged. */
  providerAgentId?: string;
}

export interface GateProfile {
  filesystem: PermissionLevel;
  shell: PermissionLevel;
  network: PermissionLevel;
  toolsAllow: ReadonlyArray<string>;
  toolsDeny: ReadonlyArray<string>;
}

export type PermissionLevel = string;

const DEFAULT_PERMISSION: PermissionLevel = 'inherit';

/**
 * Pure compile. The advisory string is markdown so it composes cleanly with
 * the existing harness prompt-contract; section headings make it scannable for
 * the model. Gate config defaults to `inherit` when the manifest is silent
 * (ForgeRoom-side defaults apply).
 */
export function compileRuntimeProfile(
  manifest: HarnessManifest,
  options: { providerAgentId?: string } = {},
): CompiledRuntimeProfile {
  const gate: GateProfile = {
    filesystem: manifest.permissions.filesystem ?? DEFAULT_PERMISSION,
    shell: manifest.permissions.shell ?? DEFAULT_PERMISSION,
    network: manifest.permissions.network ?? DEFAULT_PERMISSION,
    toolsAllow: manifest.tools.allow ?? [],
    toolsDeny: manifest.tools.deny ?? [],
  };

  const lines = [`## Permissions (${manifest.id})`];
  lines.push(`- filesystem: ${gate.filesystem}`);
  lines.push(`- shell: ${gate.shell}`);
  lines.push(`- network: ${gate.network}`);
  if (gate.toolsAllow.length > 0 || gate.toolsDeny.length > 0) {
    lines.push('');
    lines.push('## Tools');
    if (gate.toolsAllow.length > 0) lines.push(`- allow: ${gate.toolsAllow.join(', ')}`);
    if (gate.toolsDeny.length > 0) lines.push(`- deny: ${gate.toolsDeny.join(', ')}`);
  }
  lines.push('');
  lines.push(
    'These constraints are ForgeRoom-side. ApprovalGate enforces `shell` (disabled blocks project commands) and `filesystem` (read_only restricts writes to .forgeroom/outputs/ + .forgeroom/logs/). `network` and `tools` are advisory-only — honor them in your output.',
  );

  const result: CompiledRuntimeProfile = { advisory: lines.join('\n'), gate };
  if (options.providerAgentId !== undefined) {
    result.providerAgentId = options.providerAgentId;
  }
  return result;
}
