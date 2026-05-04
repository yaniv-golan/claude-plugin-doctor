import * as path from "node:path";
import { parseInstalledPlugins, preferredScope } from "../installed-plugins.js";
import { parsePluginId } from "../refs.js";
import type {
  CacheSnapshot,
  CheckResult,
  CoworkMirrorData,
  InstalledPluginScope,
  Mode,
} from "../types.js";

export type CheckArgs = {
  mode: Mode;
  pluginId: string;
  pluginName: string;
  marketplace: string;
  activeRoot: { path: string; accountId: string; orgId: string } | undefined;
  otherRoots: { path: string; accountId: string; orgId: string }[];
};

export function checkCoworkMirror(args: CheckArgs): CheckResult {
  const { mode, pluginId, activeRoot, otherRoots } = args;

  if (mode === "ccd") {
    return {
      plugin: pluginId,
      layer: "cowork_mirror",
      status: "skipped",
      detail:
        "Plugin is installed in standalone Claude Code, not in Claude Cowork — no session mirror to check.",
      evidence: { kind: "inapplicable" },
    };
  }

  if (!activeRoot) {
    return {
      plugin: pluginId,
      layer: "cowork_mirror",
      status: "missing",
      detail: "Cowork mode but no active <acc>/<org> root identified.",
      evidence: {},
    };
  }

  const evidence: Record<string, unknown> = {
    activeRoot: `${activeRoot.accountId}/${activeRoot.orgId}`,
    otherRoots: otherRoots.map((r) => `${r.accountId}/${r.orgId}`),
  };

  if (otherRoots.length === 0) {
    return {
      plugin: pluginId,
      layer: "cowork_mirror",
      status: "fresh",
      detail: "Single Cowork root; no cross-root drift possible.",
      evidence,
    };
  }

  const activeFile = path.join(activeRoot.path, "cowork_plugins", "installed_plugins.json");
  const activeParsed = parseInstalledPlugins(activeFile);
  const activeEntry = activeParsed.plugins.find((p) => p.id === pluginId);
  // Drift detection compares the canonical scope (user → project → local →
  // first), not whichever scope happens to be in file order. See audit #12.
  const activeVersion = activeEntry ? preferredScope(activeEntry).version : undefined;
  evidence.activeVersion = activeVersion;

  const disagreements: string[] = [];
  for (const other of otherRoots) {
    const otherFile = path.join(other.path, "cowork_plugins", "installed_plugins.json");
    const otherParsed = parseInstalledPlugins(otherFile);
    const otherEntry = otherParsed.plugins.find((p) => p.id === pluginId);
    const otherVersion = otherEntry ? preferredScope(otherEntry).version : undefined;
    if (otherVersion && activeVersion && otherVersion !== activeVersion) {
      disagreements.push(`${other.accountId}/${other.orgId}: ${otherVersion}`);
    }
  }

  if (disagreements.length === 0) {
    return {
      plugin: pluginId,
      layer: "cowork_mirror",
      status: "fresh",
      detail: "Active root version agrees with all other roots that have the plugin.",
      evidence,
    };
  }

  return {
    plugin: pluginId,
    layer: "cowork_mirror",
    status: "stale",
    detail: `Cross-root version drift: active ${activeRoot.accountId}/${activeRoot.orgId}=${activeVersion}; ${disagreements.join(", ")}`,
    evidence: { ...evidence, disagreements },
    recommendation: {
      action: "Decide which root is canonical and refresh the others, or remove unused roots",
      reason: "multiple Cowork roots disagree on plugin version",
      risk: "safe",
    },
  };
}

// ── v1.0 Tier C typed snapshot ───────────────────────────────────────────────

export type CoworkMirrorSnapshotArgs = {
  /** The cowork root to snapshot. */
  cowork: { accountId: string; orgId: string; rootPath: string };
  /**
   * Plugin id in `<plugin>@<marketplace>` form — used to look up the install
   * entry in this cowork root's installed_plugins.json.
   */
  pluginId: string;
  /**
   * Optional marketplace clone HEAD SHA for this cowork root's local clone —
   * populated when the cowork root has a marketplace clone.
   */
  marketplaceCloneHead?: string;
};

/**
 * Returns a typed `CacheSnapshot` for the cowork_mirror layer for a single
 * cowork root.
 *
 * Unlike `checkCoworkMirror` (which compares across roots to detect drift),
 * this function is scoped to ONE cowork root. Cross-root drift composition
 * is tier E's job.
 */
export function snapshotCoworkMirror(args: CoworkMirrorSnapshotArgs): CacheSnapshot {
  const { cowork, pluginId, marketplaceCloneHead } = args;

  const installedPluginsPath = path.join(
    cowork.rootPath,
    "cowork_plugins",
    "installed_plugins.json",
  );

  const parsed = parseInstalledPlugins(installedPluginsPath);
  const entry = parsed.plugins.find((p) => p.id === pluginId);

  // Surface the canonical scope rather than file order (audit #12). When all
  // scopes are managed/unknown, this falls through to the first one.
  const installedHere: InstalledPluginScope | undefined = entry ? preferredScope(entry) : undefined;

  const presence = installedHere !== undefined ? "present" : "absent";

  const evidencePaths: string[] = [cowork.rootPath];
  if (parsed.present) evidencePaths.push(installedPluginsPath);

  const data: CoworkMirrorData = {
    kind: "cowork_mirror",
    cowork,
    ...(marketplaceCloneHead !== undefined ? { marketplaceCloneHead } : {}),
    ...(installedHere !== undefined ? { installedHere } : {}),
  };

  // Split on the LAST `@` so scoped npm-style names (`@scope/foo@mp`) parse
  // correctly (audit issue #13). Falls back to the bare id when malformed —
  // composer keys won't match in that case, but neither does the v0.5 path.
  const parsedId = parsePluginId(pluginId);
  return {
    layer: "cowork_mirror",
    rootRef: { kind: "cowork", accountId: cowork.accountId, orgId: cowork.orgId },
    subject: {
      kind: "plugin",
      ref: {
        pluginName: parsedId?.pluginName ?? pluginId,
        marketplace: parsedId?.marketplace ?? "",
        root: { kind: "cowork", accountId: cowork.accountId, orgId: cowork.orgId },
      },
    },
    presence,
    evidencePaths,
    parsedAt: new Date().toISOString(),
    data,
  };
}
