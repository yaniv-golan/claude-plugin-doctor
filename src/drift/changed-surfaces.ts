/**
 * Changed-surfaces derivation — tier E, phase 5.
 *
 * Derives which SurfaceKind values have changed between an installed plugin's
 * current state and the resolved (upstream) state. Used by the drift composer
 * to populate RuntimeBoundary.changedSurfaces.
 *
 * Source of truth: SPEC-v1.0.md §7.2.1.
 */

import type { SurfaceKind } from "../types.js";

export type SurfaceProvenance = "diff-installed-vs-resolved" | "conservative-all-surfaces";

type PluginJsonShape = {
  commands?: unknown;
  agents?: unknown;
  skills?: unknown;
  hooks?: unknown;
  raw: Record<string, unknown>;
};

/** Map from plugin.json top-level key to SurfaceKind. */
const KEY_TO_SURFACE: Record<string, SurfaceKind> = {
  commands: "command",
  agents: "agent",
  skills: "skill",
  hooks: "hook",
  mcpServers: "mcp",
};

/** Conservative full set of all surfaces — returned when diff is not possible. */
const ALL_SURFACES: SurfaceKind[] = [
  "skill",
  "command",
  "agent",
  "hook",
  "mcp",
  "config",
  "plugin-itself",
];

/**
 * Derives the changed surfaces between two plugin.json snapshots.
 *
 * If both `installedPluginJson` and `resolvedPluginJson` are provided, a diff
 * is performed: a surface is "changed" if it is present in one snapshot but not
 * the other, or if the values are structurally different (JSON.stringify
 * comparison — good enough for v1.0; a future phase can use deep equality).
 *
 * If either snapshot is missing, the conservative fallback returns all 7
 * surfaces (safe but over-broad: tells the user to restart the UI).
 *
 * An empty `surfaces` array means no detectable change — the caller should
 * suppress the RuntimeBoundary drift item.
 */
export function deriveChangedSurfaces(args: {
  installedPluginJson?: PluginJsonShape;
  resolvedPluginJson?: PluginJsonShape;
}): { surfaces: SurfaceKind[]; provenance: SurfaceProvenance } {
  const { installedPluginJson, resolvedPluginJson } = args;

  if (installedPluginJson === undefined || resolvedPluginJson === undefined) {
    return { surfaces: ALL_SURFACES, provenance: "conservative-all-surfaces" };
  }

  const changed = new Set<SurfaceKind>();

  // Diff known surface keys.
  for (const [key, surface] of Object.entries(KEY_TO_SURFACE)) {
    const inInstalled = key in installedPluginJson.raw;
    const inResolved = key in resolvedPluginJson.raw;
    if (inInstalled !== inResolved) {
      // Present in one but not the other.
      changed.add(surface);
    } else if (inInstalled && inResolved) {
      // Present in both — compare structurally.
      const installedVal = JSON.stringify(installedPluginJson.raw[key]);
      const resolvedVal = JSON.stringify(resolvedPluginJson.raw[key]);
      if (installedVal !== resolvedVal) {
        changed.add(surface);
      }
    }
  }

  // Check for config-level changes: any top-level key outside the known surface
  // keys and "name"/"version"/"description" (identity keys) indicates config drift.
  const identityKeys = new Set(["name", "version", "description", ...Object.keys(KEY_TO_SURFACE)]);
  const installedOtherKeys = Object.keys(installedPluginJson.raw).filter(
    (k) => !identityKeys.has(k),
  );
  const resolvedOtherKeys = Object.keys(resolvedPluginJson.raw).filter((k) => !identityKeys.has(k));

  const allOtherKeys = new Set([...installedOtherKeys, ...resolvedOtherKeys]);
  for (const key of allOtherKeys) {
    const inInstalled = key in installedPluginJson.raw;
    const inResolved = key in resolvedPluginJson.raw;
    if (inInstalled !== inResolved) {
      changed.add("config");
    } else {
      const installedVal = JSON.stringify(installedPluginJson.raw[key]);
      const resolvedVal = JSON.stringify(resolvedPluginJson.raw[key]);
      if (installedVal !== resolvedVal) {
        changed.add("config");
      }
    }
  }

  // If any version-identity fields changed (name/version), tag plugin-itself.
  const versionKeys = ["name", "version", "description"];
  for (const key of versionKeys) {
    const inInstalled = installedPluginJson.raw[key];
    const inResolved = resolvedPluginJson.raw[key];
    if (JSON.stringify(inInstalled) !== JSON.stringify(inResolved)) {
      changed.add("plugin-itself");
    }
  }

  return { surfaces: Array.from(changed), provenance: "diff-installed-vs-resolved" };
}
