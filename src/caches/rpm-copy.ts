import * as fs from "node:fs";
import * as path from "node:path";
import type { RpmEntry } from "../rpm-manifest.js";
import type { CacheSnapshot, CheckResult, RpmCopyData } from "../types.js";

export type CheckArgs = {
  rpmRoot: string;
  entry: RpmEntry;
};

export function checkRpmCopy(args: CheckArgs): CheckResult {
  const { rpmRoot, entry } = args;
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
  return {
    plugin: entry.pluginId,
    layer: "rpm_copy",
    status: "fresh",
    detail: `Installed via Claude Cowork's in-app Plugins UI (${entry.installedBy} scope, updated ${entry.updatedAt ?? "n/a"}).`,
    evidence,
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
};

/**
 * Returns a typed `CacheSnapshot` for the rpm_copy layer.
 *
 * Pure file-system inspection — no network I/O. The cowork root coordinates
 * are included so tier E can correlate RPM entries with marketplace state.
 */
export function snapshotRpmCopy(args: RpmCopySnapshotArgs): CacheSnapshot {
  const { rpmRoot, entry, cowork, marketplaceId, marketplaceName } = args;
  const pluginDirPath = path.join(rpmRoot, entry.pluginId);
  const pluginDirExists = fs.existsSync(pluginDirPath);

  const presence = pluginDirExists ? "present" : "absent";
  const evidencePaths: string[] = [pluginDirPath];

  const manifestEntry: RpmCopyData["manifestEntry"] = {
    installedBy: entry.installedBy,
    ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
    raw: entry.raw,
  };

  const data: RpmCopyData = {
    kind: "rpm_copy",
    cowork,
    pluginId: entry.pluginId,
    ...(marketplaceId !== undefined ? { marketplaceId } : {}),
    ...(marketplaceName !== undefined ? { marketplaceName } : {}),
    manifestEntry,
    pluginDirPath,
    pluginDirExists,
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
