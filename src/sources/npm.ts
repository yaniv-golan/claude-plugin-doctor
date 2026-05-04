/**
 * Tier B upstream probe for `kind: "npm"` sources.
 *
 * Currently returns "unknowable" — npm registry lookups are planned but not
 * yet implemented. See SPEC-v1.0.md §4.
 */

import type { UpstreamProbeOpts, UpstreamProbeResult } from "../types.js";

export function probeNpm(
  _source: { kind: "npm"; package: string; version?: string; registry?: string },
  _opts: UpstreamProbeOpts,
): UpstreamProbeResult {
  return { status: "unknowable", reason: "npm-not-implemented" };
}
