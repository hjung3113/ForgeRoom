import { describe, expect, it } from 'vitest';

import { compileRuntimeProfile } from './runtime-profile-compiler.js';
import type { HarnessManifest } from '../agent-runtime/harness-manifest.js';

function manifest(over: Partial<HarnessManifest> = {}): HarnessManifest {
  return {
    id: 'review',
    description: 'd',
    applies_to_kinds: ['review'],
    prompt_contract: './prompt-contract.md',
    output: {},
    permissions: {},
    tools: {},
    ...over,
  };
}

describe('compileRuntimeProfile (ADR-029 E4)', () => {
  it('compiles permissions + tools into both an advisory and a gate config', () => {
    const m = manifest({
      permissions: { filesystem: 'read_only', shell: 'disabled', network: 'disabled' },
      tools: { allow: ['read_file', 'grep'], deny: ['write_file'] },
    });
    const profile = compileRuntimeProfile(m);

    expect(profile.gate).toEqual({
      filesystem: 'read_only',
      shell: 'disabled',
      network: 'disabled',
      toolsAllow: ['read_file', 'grep'],
      toolsDeny: ['write_file'],
    });
    expect(profile.advisory).toContain('filesystem: read_only');
    expect(profile.advisory).toContain('allow: read_file, grep');
    expect(profile.advisory).toContain('deny: write_file');
  });

  it('defaults silent permissions to inherit', () => {
    const profile = compileRuntimeProfile(manifest());
    expect(profile.gate.filesystem).toBe('inherit');
    expect(profile.gate.shell).toBe('inherit');
    expect(profile.gate.network).toBe('inherit');
    expect(profile.gate.toolsAllow).toEqual([]);
  });

  it('omits the Tools heading when both allow and deny are empty', () => {
    const profile = compileRuntimeProfile(manifest());
    expect(profile.advisory).not.toContain('## Tools');
  });

  it('passes through providerAgentId from RuntimeSession (ADR-028 #85)', () => {
    const profile = compileRuntimeProfile(manifest(), { providerAgentId: 'fr-impl' });
    expect(profile.providerAgentId).toBe('fr-impl');
  });

  it('NEVER claims provider enforcement in the advisory (ADR-029 §4)', () => {
    const profile = compileRuntimeProfile(
      manifest({ permissions: { shell: 'disabled' } }),
    );
    expect(profile.advisory).toMatch(/ForgeRoom-side/i);
    expect(profile.advisory).not.toMatch(/openclaw.*enforces/i);
  });
});
