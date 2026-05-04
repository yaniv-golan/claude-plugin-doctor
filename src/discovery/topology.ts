/**
 * Tier A — Discovery: top-level topology enumerator.
 *
 * Orchestrates the four walkers (ccd-root, cowork-roots, skills-plugin-root,
 * session-locals) into a single Topology. All I/O is delegated to the walkers;
 * this module adds no I/O of its own.
 */

import type { Topology } from "../types.js";
import { discoverCcdRoot } from "./ccd-root.js";
import { discoverCoworkRoots } from "./cowork-roots.js";
import { discoverSessionLocals } from "./session-locals.js";
import { discoverSkillsPluginRoot } from "./skills-plugin-root.js";

type SystemContext = {
  platform?: NodeJS.Platform;
  home?: string;
  env?: Record<string, string | undefined>;
};

/**
 * Returns a fresh random UUID using the Node 20+ global `crypto.randomUUID()`.
 * No import needed — `crypto` is a global in Node 20+.
 */
export function runId(): string {
  return crypto.randomUUID();
}

/**
 * Runs the full Tier A topology scan and returns a populated Topology.
 *
 * - `scannedAt` is set to the ISO string of the current time at the moment
 *   discoverTopology() is called (before any walker I/O).
 * - No I/O beyond what the walkers do.
 */
export function discoverTopology(ctx?: SystemContext): Topology {
  const scannedAt = new Date().toISOString();

  const ccd = discoverCcdRoot(ctx);
  const cowork = discoverCoworkRoots(ctx);
  const skillsPlugin = discoverSkillsPluginRoot(ctx);
  const sessionLocals = discoverSessionLocals(cowork);

  return {
    scannedAt,
    cowork,
    sessionLocals,
    ...(ccd !== undefined ? { ccd } : {}),
    ...(skillsPlugin !== undefined ? { skillsPlugin } : {}),
  };
}
