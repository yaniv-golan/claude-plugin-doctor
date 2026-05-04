/**
 * Tier A — Discovery: active-root heuristic.
 *
 * Pure function — no I/O. Exported for tests and for future phases that want a
 * single "active" pick independently of the isMostRecent flag set per-root by
 * cowork-roots.ts.
 */

import type { CoworkRoot } from "../types.js";

/**
 * Returns the single CoworkRoot with the largest `installedPluginsMtime`, or
 * `undefined` if no root has a defined mtime.
 *
 * Tie-breaking: first occurrence wins (stable, insertion-order-preserving).
 */
export function pickMostRecentCoworkRoot(roots: CoworkRoot[]): CoworkRoot | undefined {
  let best: CoworkRoot | undefined;
  let bestMtime = Number.NEGATIVE_INFINITY;

  for (const root of roots) {
    if (root.installedPluginsMtime !== undefined && root.installedPluginsMtime > bestMtime) {
      bestMtime = root.installedPluginsMtime;
      best = root;
    }
  }

  return best;
}
