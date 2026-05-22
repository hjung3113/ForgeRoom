import path from 'node:path';

import { PathSafetyError } from '../core/errors';

export function assertInsideRoot(targetPath: string, rootPath: string): string {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedRoot, resolvedTarget);

  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolvedTarget;
  }

  throw new PathSafetyError(`Path is outside allowed root: ${resolvedTarget}`);
}

export function safeJoinInsideRoot(rootPath: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new PathSafetyError(`Expected a relative path: ${relativePath}`);
  }

  return assertInsideRoot(path.join(rootPath, relativePath), rootPath);
}

export function isSecretPath(targetPath: string): boolean {
  const normalized = targetPath.split(path.sep).join('/');
  const basename = path.basename(targetPath);

  return (
    basename === '.env' ||
    basename === '.env.local' ||
    basename === 'id_rsa' ||
    basename === 'id_dsa' ||
    basename === 'id_ecdsa' ||
    basename === 'id_ed25519' ||
    normalized.endsWith('.pem')
  );
}
