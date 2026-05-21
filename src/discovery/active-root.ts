/**
 * Tier A — Discovery: active-root heuristic.
 *
 * Pure function — no I/O. Exported for tests and for future phases that want a
 * single "active" pick independently of the isMostRecent flag set per-root by
 * cowork-roots.ts.
 *
 * The heuristic combines two filesystem signals: `installed_plugins.json`
 * mtime (touched by Cowork-marketplace installs and by `claude plugin`
 * commands) and `rpm/manifest.json` mtime (touched by Claude Desktop's
 * Personal-plugins UI installs, which do NOT touch installed_plugins.json).
 * Using only the former misses sessions whose recent activity was a
 * Personal-plugins install.
 */

import type { CoworkRoot } from "../types.js";

/** Shape shared by `CoworkRoot` and `CoworkRootInfo` — both expose the two
 *  mtimes the active-root heuristic considers. */
export type ActiveMtimeRoot = {
  installedPluginsMtime?: number;
  rpmManifestMtime?: number;
};

/**
 * Returns `max(installedPluginsMtime, rpmManifestMtime)` — the "effective
 * recent-activity timestamp" used to pick the active Cowork root. Returns
 * `undefined` when neither mtime is defined.
 */
export function effectiveActiveMtime(root: ActiveMtimeRoot): number | undefined {
  const a = root.installedPluginsMtime;
  const b = root.rpmManifestMtime;
  if (a === undefined && b === undefined) return undefined;
  return Math.max(a ?? Number.NEGATIVE_INFINITY, b ?? Number.NEGATIVE_INFINITY);
}

/**
 * Returns the single CoworkRoot with the largest `effectiveActiveMtime`, or
 * `undefined` if no root has any defined mtime.
 *
 * Tie-breaking: first occurrence wins (stable, insertion-order-preserving).
 */
export function pickMostRecentCoworkRoot(roots: CoworkRoot[]): CoworkRoot | undefined {
  let best: CoworkRoot | undefined;
  let bestMtime = Number.NEGATIVE_INFINITY;

  for (const root of roots) {
    const m = effectiveActiveMtime(root);
    if (m === undefined) continue;
    if (m > bestMtime) {
      bestMtime = m;
      best = root;
    }
  }

  return best;
}
