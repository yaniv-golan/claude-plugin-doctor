/**
 * Version trap detectors — tier E, phase 5.
 *
 * Detects refresh-needed, bump-needed, and badge-only-needed traps.
 * These are pure functions over typed tier C/D inputs — no fs, no fetch.
 *
 * Logic mirrors the v0.5 trap detection in src/caches/install-snapshot.ts,
 * extracted into a pure function operating on typed snapshots.
 *
 * Source of truth: SPEC-v1.0.md §7.3 + v0.5 SPEC §4 Layer 2 trap taxonomy.
 */

import type {
  CliUpdateSim,
  DesktopBadgeSim,
  KnownTrap,
  MarketplaceCloneData,
  PluginRef,
} from "../../types.js";

export type VersionTrapInput = {
  pluginRef: PluginRef;
  cli: CliUpdateSim;
  badge: DesktopBadgeSim;
  marketplaceClone?: MarketplaceCloneData;
  /** Layer 1 status: "fresh" or "stale" or "unknown". */
  marketplaceCloneStatus: "fresh" | "stale" | "unknown";
  installedVersion?: string;
  installedGitCommitSha?: string;
};

type VersionTrapResult = Extract<
  KnownTrap,
  { kind: "refresh-needed" | "bump-needed" | "badge-only-needed" }
>;

/**
 * Detects version traps for a plugin.
 *
 * `refresh-needed`:
 *   cli.resolvedVersion === installedVersion AND installedGitCommitSha !==
 *   marketplaceClone.headLocal AND marketplaceCloneStatus === "stale".
 *
 * `bump-needed`:
 *   cli.resolvedVersion === installedVersion AND installedGitCommitSha !==
 *   marketplaceClone.headLocal AND marketplaceCloneStatus === "fresh".
 *
 * `badge-only-needed`:
 *   object-source plugins ONLY (string-source cannot have this trap).
 *   Trigger: cli.evidence.remotePluginJsonVersion !== cli.evidence.marketplaceJsonVersion
 *   AND both are defined.
 *
 * Returns an array; zero, one, or two traps can coexist (e.g. refresh-needed +
 * badge-only-needed).
 */
export function detectVersionTraps(input: VersionTrapInput): VersionTrapResult[] {
  const {
    pluginRef,
    cli,
    badge,
    marketplaceClone,
    marketplaceCloneStatus,
    installedVersion,
    installedGitCommitSha,
  } = input;

  const traps: VersionTrapResult[] = [];

  // Commit-drift traps (refresh-needed / bump-needed).
  const headLocal = marketplaceClone?.headLocal;
  const commitsDiverged =
    installedGitCommitSha !== undefined &&
    headLocal !== undefined &&
    installedGitCommitSha !== headLocal;

  const versionsMatch =
    cli.resolvedVersion !== undefined && cli.resolvedVersion === installedVersion;

  if (commitsDiverged && versionsMatch) {
    if (marketplaceCloneStatus === "stale") {
      traps.push({ kind: "refresh-needed", subject: { kind: "plugin", ref: pluginRef } });
    } else if (marketplaceCloneStatus === "fresh") {
      traps.push({ kind: "bump-needed", subject: { kind: "plugin", ref: pluginRef } });
    }
    // "unknown" → no commit-drift trap (cannot distinguish)
  }

  // badge-only-needed (object-source only).
  // Object-source: github, git-subdir, url (not string-source).
  const sourceKind = cli.evidence.pluginEntrySourceKind;
  const isObjectSource =
    sourceKind === "github" || sourceKind === "git-subdir" || sourceKind === "url";

  if (isObjectSource) {
    const remoteVer = cli.evidence.remotePluginJsonVersion;
    const marketplaceVer = badge.evidence.marketplaceJsonVersion;
    if (remoteVer !== undefined && marketplaceVer !== undefined && remoteVer !== marketplaceVer) {
      traps.push({ kind: "badge-only-needed", subject: { kind: "plugin", ref: pluginRef } });
    }
  }

  return traps;
}
