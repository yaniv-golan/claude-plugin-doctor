/**
 * Tier B upstream probe for `kind: "backend"` sources.
 *
 * Backend state is server-side only. No local mirror exists and no auth-gated
 * API call is made. Always returns "unknowable".
 *
 * The §10.4 `verify-in-ui` flow provides the alternative evidence path; this
 * stub fulfils the dispatcher contract.
 */

import type { UpstreamProbeOpts, UpstreamProbeResult } from "../types.js";

export function probeBackend(
  _source: { kind: "backend" },
  _opts: UpstreamProbeOpts,
): UpstreamProbeResult {
  return { status: "unknowable", reason: "backend" };
}
