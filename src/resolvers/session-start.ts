/**
 * Session start simulator — tier D, phase 4.
 *
 * Answers: "What would the next `+ new task` load for this plugin?"
 *
 * Pure function over typed inputs. No fs, no fetch, no child_process.
 *
 * Resolution logic (per SPEC-v1.0.md §6.1):
 *   The next session's loaded version is whatever's recorded in
 *   installed_plugins.json#installPath — the on-disk install snapshot
 *   from tier C's InstallSnapshotData.scopes.
 *
 * Scope preference order: user > project > local > unknown.
 * When multiple scopes carry different versions, the first scope by this
 * order wins. Tier E can emit cross-scope drift advisories separately.
 * This is a deliberate simplification: the Claude runtime itself picks
 * the user-scope entry when multiple scopes are present, matching this
 * preference order per the gist's plugin-load description.
 */

import type { InstalledScope, SessionStartInput, SessionStartSim } from "../types.js";

/** Preference order for scope selection. Lower index = higher priority. */
const SCOPE_ORDER: InstalledScope[] = ["user", "project", "local", "unknown"];

export function simulateSessionStart(args: SessionStartInput): SessionStartSim {
  const { installedScopes } = args;

  if (installedScopes.length === 0) {
    return {
      unknowable: { reason: "not-installed" },
    };
  }

  // Pick the first scope by preference order.
  for (const preferredScope of SCOPE_ORDER) {
    const match = installedScopes.find((s) => s.scope === preferredScope);
    if (match !== undefined) {
      return {
        resolvedVersion: match.version,
        installedPath: match.installPath,
      };
    }
  }

  // Fallback: if all scopes are some unexpected value not in SCOPE_ORDER,
  // return the first entry. This should not occur with well-typed inputs.
  // exactOptionalPropertyTypes requires conditional spread for optional properties.
  const first = installedScopes[0];
  return {
    ...(first?.version !== undefined && { resolvedVersion: first.version }),
    ...(first?.installPath !== undefined && { installedPath: first.installPath }),
  };
}
