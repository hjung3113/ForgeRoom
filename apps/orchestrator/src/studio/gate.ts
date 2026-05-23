/**
 * Production-OFF gate for Mastra Studio (#10, ADR-015).
 *
 * Studio is a dev-only visualization surface and MUST NOT be reachable in a
 * production build. Two independent guards enforce this:
 *
 *  1. The launch gate (this module): the Studio entry ({@link mastra/index.ts})
 *     refuses to register the sample workflow unless {@link isStudioEnabled}
 *     returns true. `mastra dev` loads that entry, so a prod process that never
 *     sets the flag gets an empty (inert) Mastra instance.
 *  2. The script gate ({@link package.json} `dev:studio`): only that script
 *     invokes `mastra dev` and it sets `FORGEROOM_STUDIO=1`. Production start
 *     scripts never call `mastra dev` (codex 92: gate the launch, not the
 *     runtime config).
 *
 * The gate is OFF by default. It opts in ONLY when `FORGEROOM_STUDIO` holds a
 * recognised truthy opt-in value. The explicit-opt-in design is deliberate: the
 * Studio dev server (`mastra dev`) sets `NODE_ENV=production` for its own bundle
 * step, so NODE_ENV cannot be used as a second guard without breaking Studio.
 * Production protection therefore lives at the LAUNCH boundary — production
 * start scripts never invoke `mastra dev` and never set `FORGEROOM_STUDIO`
 * (codex 92: gate the launch, not the runtime config).
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export interface StudioEnv {
  FORGEROOM_STUDIO?: string | undefined;
}

/**
 * True only when the operator explicitly opted in via `FORGEROOM_STUDIO`. Pure
 * function of the passed env (defaults to `process.env`) so it is trivially
 * testable.
 */
export function isStudioEnabled(env: StudioEnv = process.env): boolean {
  const flag = (env.FORGEROOM_STUDIO ?? '').trim().toLowerCase();
  return TRUTHY.has(flag);
}
