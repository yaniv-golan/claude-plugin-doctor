import * as fs from "node:fs";
import * as path from "node:path";
import type { RpmEntry } from "../rpm-manifest.js";
import type { CacheSnapshot, CheckResult, RpmCopyData } from "../types.js";
import { readPluginJsonVersion } from "./install-snapshot.js";

/**
 * Pre-resolved marketplace-clone version info for an RPM plugin. The caller
 * is responsible for the lookup chain (which marketplace? which plugin in it?
 * which version?) — see scan.ts:resolveRpmCloneVersion. Layer 5 freshness
 * compares the on-disk RPM `plugin.json#version` against `version` here.
 *
 * When `version` is undefined, `lookupFailure` MUST be set so the resulting
 * `unknowable` status can explain why no comparison was possible.
 */
export type MarketplaceCloneHint = {
  version?: string;
  /** Required when `version` is undefined. */
  lookupFailure?:
    | "marketplace-clone-unavailable"
    | "plugin-not-in-marketplace"
    | "marketplace-version-unknown";
  /** Absolute path to the marketplace clone directory for evidence rendering. */
  clonePath?: string;
};

export type CheckArgs = {
  rpmRoot: string;
  entry: RpmEntry;
  /** When provided, enables Layer 5 freshness comparison against the local
   *  marketplace clone (no network). When omitted, the check degrades to
   *  the legacy directory-existence-only verdict — kept for back-compat
   *  with tests that don't supply clone context. */
  marketplaceClone?: MarketplaceCloneHint;
};

/** Compare two version strings using the same Intl.Collator approach the
 *  drift composer uses (`numeric:true` ⇒ "1.10" > "1.9"). Returns:
 *    -1 when rpm <  clone
 *     0 when rpm == clone
 *     1 when rpm >  clone */
function compareVersions(rpm: string, clone: string): -1 | 0 | 1 {
  if (rpm === clone) return 0;
  const cmp = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare(
    rpm,
    clone,
  );
  return cmp < 0 ? -1 : 1;
}

export function checkRpmCopy(args: CheckArgs): CheckResult {
  const { rpmRoot, entry, marketplaceClone } = args;
  const dir = path.join(rpmRoot, entry.pluginId);
  const evidence: Record<string, unknown> = {
    pluginDir: dir,
    installedBy: entry.installedBy,
    updatedAt: entry.updatedAt,
  };
  if (!fs.existsSync(dir)) {
    return {
      plugin: entry.pluginId,
      layer: "rpm_copy",
      status: "missing",
      detail: `Claude Cowork's manifest references ${entry.pluginId} but ${dir} does not exist.`,
      evidence,
      recommendation: {
        action: "Resync via Claude Cowork → Plugins → Personal plugins",
        reason: "Cowork-installed plugin directory missing on disk",
        risk: "safe",
      },
    };
  }

  // Legacy path: no clone info supplied — return the dir-existence verdict.
  // Kept for unit tests and any caller that hasn't been migrated.
  if (marketplaceClone === undefined) {
    return {
      plugin: entry.pluginId,
      layer: "rpm_copy",
      status: "fresh",
      detail: `Installed via Claude Cowork's in-app Plugins UI (${entry.installedBy} scope, updated ${entry.updatedAt ?? "n/a"}).`,
      evidence,
    };
  }

  const rpmVersion = readPluginJsonVersion(dir);
  if (rpmVersion === undefined) {
    return {
      plugin: entry.pluginId,
      layer: "rpm_copy",
      status: "unknowable",
      detail: `RPM plugin directory exists but its .claude-plugin/plugin.json is missing or unparseable; cannot determine the installed version.`,
      evidence: {
        ...evidence,
        rpmVersion: null,
        cloneVersion: marketplaceClone.version ?? null,
        skipReason: "rpm-plugin-json-missing",
      },
    };
  }

  if (marketplaceClone.version === undefined) {
    const reason = marketplaceClone.lookupFailure ?? "marketplace-version-unknown";
    const detailByReason: Record<NonNullable<MarketplaceCloneHint["lookupFailure"]>, string> = {
      "marketplace-clone-unavailable":
        "No local marketplace clone for this plugin's marketplace — cannot compare RPM version against upstream.",
      "plugin-not-in-marketplace":
        "Plugin is not listed in the local marketplace.json — cannot compare RPM version against upstream.",
      "marketplace-version-unknown":
        "Local marketplace clone exists but does not declare a version for this plugin — cannot compare.",
    };
    return {
      plugin: entry.pluginId,
      layer: "rpm_copy",
      status: "unknowable",
      detail: detailByReason[reason],
      evidence: {
        ...evidence,
        rpmVersion,
        cloneVersion: null,
        skipReason: reason,
        ...(marketplaceClone.clonePath ? { clonePath: marketplaceClone.clonePath } : {}),
      },
    };
  }

  const cloneVersion = marketplaceClone.version;
  const comparison = compareVersions(rpmVersion, cloneVersion);
  const versionEvidence = {
    ...evidence,
    rpmVersion,
    cloneVersion,
    ...(marketplaceClone.clonePath ? { clonePath: marketplaceClone.clonePath } : {}),
  };

  if (comparison < 0) {
    return {
      plugin: entry.pluginId,
      layer: "rpm_copy",
      status: "stale",
      detail: `Personal-plugins install is ${rpmVersion} but the local marketplace clone has ${cloneVersion}.`,
      evidence: versionEvidence,
      recommendation: {
        action: `Open Claude Desktop → Settings → Plugins → ${entry.raw.name ?? entry.pluginId}: Uninstall, then Install (or wait for the next auto-sync).`,
        reason: `RPM plugin.json#version (${rpmVersion}) is behind the marketplace clone (${cloneVersion}).`,
        risk: "safe",
      },
    };
  }

  // comparison >= 0 — fresh. (==: fully fresh; >: ahead-of-marketplace, which
  // can happen when a user installed manually and the marketplace clone hasn't
  // been refreshed yet. Not a failure — surface as fresh with the versions
  // visible in evidence so the user can spot it in --verbose.)
  return {
    plugin: entry.pluginId,
    layer: "rpm_copy",
    status: "fresh",
    detail:
      comparison === 0
        ? `Personal-plugins install ${rpmVersion} matches the local marketplace clone.`
        : `Personal-plugins install ${rpmVersion} is ahead of the local marketplace clone (${cloneVersion}); marketplace clone may need refresh.`,
    evidence: versionEvidence,
  };
}

// ── v1.0 Tier C typed snapshot ───────────────────────────────────────────────

export type RpmCopySnapshotArgs = {
  /** Absolute path to the rpm/ directory (parent of <plugin-id>/ dirs). */
  rpmRoot: string;
  /** Single RPM manifest entry for the plugin to snapshot. */
  entry: RpmEntry;
  /** Which (accountId, orgId) pair this RPM root belongs to. */
  cowork: { accountId: string; orgId: string };
  /** Optional marketplace association from the manifest entry (array-form only). */
  marketplaceId?: string;
  marketplaceName?: string;
  /** Same pre-resolved clone info accepted by `checkRpmCopy`. When provided,
   *  the snapshot carries a `versionDelta` evidence field describing the
   *  comparison; when omitted (or undefined version), the snapshot records
   *  why no comparison was possible via `versionDeltaSkipReason`. */
  marketplaceClone?: MarketplaceCloneHint;
};

/**
 * Returns a typed `CacheSnapshot` for the rpm_copy layer.
 *
 * Pure file-system inspection — no network I/O. The cowork root coordinates
 * are included so tier E can correlate RPM entries with marketplace state.
 */
export function snapshotRpmCopy(args: RpmCopySnapshotArgs): CacheSnapshot {
  const { rpmRoot, entry, cowork, marketplaceId, marketplaceName, marketplaceClone } = args;
  const pluginDirPath = path.join(rpmRoot, entry.pluginId);
  const pluginDirExists = fs.existsSync(pluginDirPath);

  const presence = pluginDirExists ? "present" : "absent";
  const evidencePaths: string[] = [pluginDirPath];

  const manifestEntry: RpmCopyData["manifestEntry"] = {
    installedBy: entry.installedBy,
    ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
    raw: entry.raw,
  };

  // Compute versionDelta when both sides yield a version. Otherwise capture
  // a skip reason so consumers can render an honest "unknowable" verdict.
  let versionDelta: RpmCopyData["versionDelta"] | undefined;
  let versionDeltaSkipReason: RpmCopyData["versionDeltaSkipReason"] | undefined;
  if (pluginDirExists) {
    const rpmVersion = readPluginJsonVersion(pluginDirPath);
    if (rpmVersion === undefined) {
      versionDeltaSkipReason = "rpm-plugin-json-missing";
    } else if (marketplaceClone === undefined) {
      versionDeltaSkipReason = "marketplace-clone-unavailable";
    } else if (marketplaceClone.version === undefined) {
      versionDeltaSkipReason = marketplaceClone.lookupFailure ?? "marketplace-version-unknown";
    } else {
      versionDelta = {
        rpm: rpmVersion,
        clone: marketplaceClone.version,
        comparison: compareVersions(rpmVersion, marketplaceClone.version),
      };
    }
  }

  const data: RpmCopyData = {
    kind: "rpm_copy",
    cowork,
    pluginId: entry.pluginId,
    ...(marketplaceId !== undefined ? { marketplaceId } : {}),
    ...(marketplaceName !== undefined ? { marketplaceName } : {}),
    manifestEntry,
    pluginDirPath,
    pluginDirExists,
    ...(versionDelta !== undefined ? { versionDelta } : {}),
    ...(versionDeltaSkipReason !== undefined ? { versionDeltaSkipReason } : {}),
  };

  return {
    layer: "rpm_copy",
    rootRef: { kind: "cowork", accountId: cowork.accountId, orgId: cowork.orgId },
    subject: { kind: "rpm-plugin", pluginId: entry.pluginId },
    presence,
    evidencePaths,
    parsedAt: new Date().toISOString(),
    data,
  };
}
