/**
 * Session-bloat trap detector — tier E, phase 5.
 *
 * Detects session-local directories that are older than a threshold and
 * aggregates them by root. These directories accumulate over time and can
 * be safely pruned to reclaim disk space.
 *
 * Source of truth: SPEC-v1.0.md §7.3.
 */

import type { KnownTrap, RootRef, SessionLocalDir } from "../../types.js";

export type SessionBloatArgs = {
  sessionLocals: SessionLocalDir[];
  /** Only count dirs older than this. Default 14 days. */
  olderThanDays?: number;
  /**
   * Optional map from parentRoot path to RootRef.
   * When absent, a cowork-shaped RootRef with empty acc/org is used as a
   * placeholder.
   *
   * TODO(tier-A integration): wire in the topology's root map so we can
   * emit properly-keyed RootRefs here.
   */
  parentRootRefMap?: Map<string, RootRef>;
};

type SessionBloatTrap = Extract<KnownTrap, { kind: "session-bloat-cleanup-eligible" }>;

/**
 * Groups session-local directories by `parentRoot` and emits one trap per
 * root where at least one dir is older than `olderThanDays` days.
 *
 * `bytesReclaimable` = sum of `approxSizeBytes` for qualifying dirs.
 * `dirsCount` = count of qualifying dirs.
 */
export function detectSessionBloat(args: SessionBloatArgs): SessionBloatTrap[] {
  const { sessionLocals, olderThanDays = 14, parentRootRefMap } = args;
  const nowMs = Date.now();
  const thresholdMs = olderThanDays * 86_400_000;

  // Group by parentRoot; only qualifying (old-enough) dirs.
  const byRoot = new Map<string, { bytesReclaimable: number; dirsCount: number }>();

  for (const dir of sessionLocals) {
    const age = nowMs - dir.lastModified;
    if (age < thresholdMs) continue;

    const existing = byRoot.get(dir.parentRoot);
    if (existing) {
      existing.bytesReclaimable += dir.approxSizeBytes;
      existing.dirsCount += 1;
    } else {
      byRoot.set(dir.parentRoot, {
        bytesReclaimable: dir.approxSizeBytes,
        dirsCount: 1,
      });
    }
  }

  const traps: SessionBloatTrap[] = [];
  for (const [parentRoot, { bytesReclaimable, dirsCount }] of byRoot) {
    const ref: RootRef = parentRootRefMap?.get(parentRoot) ?? {
      kind: "cowork",
      accountId: "",
      orgId: "",
    };

    traps.push({
      kind: "session-bloat-cleanup-eligible",
      subject: { kind: "root", ref },
      bytesReclaimable,
      dirsCount,
    });
  }

  return traps;
}
