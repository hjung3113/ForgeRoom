/**
 * Boot-lifecycle OpenClaw IPC client (#30).
 *
 * ADR-012 makes OpenClawProvider the MVP AgentRuntimeProvider; the provider is
 * REAL and injected by the composition root. The IPC transport that drives the
 * actual OpenClaw subprocess is owned by #31. Until then this client satisfies
 * the {@link OpenClawIpcClient} seam so the provider boots and is honestly
 * wired:
 *   - `health()` reports the provider is present but its IPC transport is not
 *     executable yet (it does NOT claim the runtime is ready).
 *   - `run()` / `resume()` throw a precise "not wired until #31" error rather
 *     than fabricating a fake success.
 *
 * This keeps the boot path real (a genuine OpenClawProvider is the injected
 * provider) without launching a subprocess that does not exist in the sandbox.
 */
import type { ProviderHealth } from '../core/agent-runner.js';
import type {
  OpenClawExecutionRequest,
  OpenClawIpcClient,
  OpenClawResumeRequest,
  OpenClawRunResponse,
} from '../core/openclaw-provider.js';

export class OpenClawIpcNotWiredError extends Error {
  constructor() {
    super('OpenClaw IPC transport is not wired until #31; real subprocess execution is out of scope for #30');
    this.name = 'OpenClawIpcNotWiredError';
  }
}

/**
 * The placeholder IPC transport injected at boot. Replaced by the real
 * subprocess-backed client in #31; the provider and its wiring stay unchanged.
 */
export class NotWiredOpenClawIpcClient implements OpenClawIpcClient {
  health(): Promise<ProviderHealth> {
    return Promise.resolve({
      ok: false,
      message: 'OpenClaw provider wired; IPC transport pending (#31)',
    });
  }

  run(_request: OpenClawExecutionRequest): Promise<OpenClawRunResponse> {
    return Promise.reject(new OpenClawIpcNotWiredError());
  }

  resume(_request: OpenClawResumeRequest): Promise<OpenClawRunResponse> {
    return Promise.reject(new OpenClawIpcNotWiredError());
  }
}
