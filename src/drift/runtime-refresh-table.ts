/**
 * Runtime-refresh lookup table — tier E, phase 5.
 *
 * Maps each SurfaceKind to the minimum RefreshSemantics required to pick up
 * a change to that surface without full plugin reinstall.
 *
 * Source of truth: SPEC-v1.0.md §7.2.
 */

import type { RefreshSemantics, SurfaceKind } from "../types.js";

export const RUNTIME_REFRESH: Record<SurfaceKind, RefreshSemantics> = {
  skill: "new-task",
  command: "new-task",
  agent: "new-task",
  hook: "new-task",
  mcp: "in-task",
  config: "ui-restart",
  "plugin-itself": "new-task",
};

/** Refresh-semantics ordering: strictest first. */
const STRICTNESS_ORDER: RefreshSemantics[] = ["ui-restart", "new-task", "in-task"];

/** Returns the strictest-required refresh across multiple surfaces.
 *  Order: ui-restart > new-task > in-task.
 *  Empty array returns "in-task" (no-op / least strict). */
export function strictestRefresh(surfaces: SurfaceKind[]): RefreshSemantics {
  if (surfaces.length === 0) return "in-task";
  let strictest: RefreshSemantics = "in-task";
  for (const s of surfaces) {
    const candidate = RUNTIME_REFRESH[s];
    if (STRICTNESS_ORDER.indexOf(candidate) < STRICTNESS_ORDER.indexOf(strictest)) {
      strictest = candidate;
    }
  }
  return strictest;
}

/** Compute the runtime boundary for a plugin given its changed surfaces.
 *  Empty `surfaces` → null (caller suppresses the drift item per §7.4.1). */
export function computeRuntimeBoundary(surfaces: SurfaceKind[]): RefreshSemantics | null {
  if (surfaces.length === 0) return null;
  return strictestRefresh(surfaces);
}
