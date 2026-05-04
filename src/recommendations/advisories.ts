/**
 * Tier F — Post-action advisories.
 *
 * Computes the global runtime advisory for a set of drifts by reducing
 * over runtime-boundary items.
 *
 * Source of truth: SPEC-v1.0.md §8.3.
 */

import { strictestRefresh } from "../drift/runtime-refresh-table.js";
import type { Drift, SurfaceKind } from "../types.js";

/**
 * Compute the global post-action advisory level for a set of recommendations.
 * Walks the drifts to find the strictest required refresh across all
 * runtime-boundary drifts.
 *
 * Returns null if no runtime-boundary drift is present (no surface change).
 */
export function computeGlobalRuntimeAdvisory(
  drifts: Drift[],
): "in-task" | "new-task" | "ui-restart" | null {
  const boundaryDrifts = drifts.filter((d) => d.kind === "runtime-boundary");
  if (boundaryDrifts.length === 0) return null;

  // Collect all changed surfaces across all runtime-boundary items.
  const allSurfaces: SurfaceKind[] = [];
  for (const d of boundaryDrifts) {
    if (d.kind === "runtime-boundary") {
      allSurfaces.push(...d.changedSurfaces);
    }
  }

  if (allSurfaces.length === 0) return null;
  return strictestRefresh(allSurfaces);
}
