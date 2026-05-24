import { afterEach, describe, expect, it, vi } from 'vitest';

import { terminateProcessGroup } from './subprocess.js';

describe('terminateProcessGroup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does nothing when the child has no pid yet', () => {
    const kill = vi.spyOn(process, 'kill');

    terminateProcessGroup(undefined, 'SIGTERM');

    expect(kill).not.toHaveBeenCalled();
  });

  it('falls back to killing the child pid when process-group termination fails', () => {
    if (process.platform === 'win32') {
      return;
    }
    const kill = vi
      .spyOn(process, 'kill')
      .mockImplementationOnce(() => {
        throw new Error('missing process group');
      })
      .mockImplementationOnce(() => true);

    terminateProcessGroup(123, 'SIGKILL');

    expect(kill).toHaveBeenNthCalledWith(1, -123, 'SIGKILL');
    expect(kill).toHaveBeenNthCalledWith(2, 123, 'SIGKILL');
  });
});
