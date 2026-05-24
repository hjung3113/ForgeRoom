export function terminateProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    return;
  }

  if (process.platform === 'win32') {
    try {
      process.kill(pid, signal);
    } catch {
      // The process may have exited between timeout firing and signal delivery.
    }
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process may have exited between timeout firing and signal delivery.
    }
  }
}
