import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PathSafetyError } from '../core/errors.js';
import { assertInsideRoot, isSecretPath, safeJoinInsideRoot } from './path-safety.js';

describe('path-safety', () => {
  it('allows paths inside the configured root', () => {
    const root = path.resolve('/tmp/forgeroom/worktree');
    const target = path.join(root, '.forgeroom', 'outputs', '01_plan.md');

    expect(assertInsideRoot(target, root)).toBe(target);
  });

  it('rejects paths outside the configured root', () => {
    const root = path.resolve('/tmp/forgeroom/worktree');
    const outside = path.resolve('/tmp/forgeroom/.env');

    expect(() => assertInsideRoot(outside, root)).toThrow(PathSafetyError);
    expect(() => assertInsideRoot(outside, root)).toThrow(/outside allowed root/);
  });

  it('joins relative paths only when the result stays inside the root', () => {
    const root = path.resolve('/tmp/forgeroom/worktree');

    expect(safeJoinInsideRoot(root, '.forgeroom/prompts/01_plan.md')).toBe(
      path.join(root, '.forgeroom', 'prompts', '01_plan.md'),
    );
    expect(() => safeJoinInsideRoot(root, '../secrets.env')).toThrow(PathSafetyError);
    expect(() => safeJoinInsideRoot(root, '/tmp/forgeroom/other.md')).toThrow(
      PathSafetyError,
    );
  });

  it('detects secret-bearing paths before file access', () => {
    expect(isSecretPath('/tmp/project/.env')).toBe(true);
    expect(isSecretPath('/tmp/project/id_rsa')).toBe(true);
    expect(isSecretPath('/tmp/project/cert.pem')).toBe(true);
    expect(isSecretPath('/tmp/project/src/index.ts')).toBe(false);
  });
});
