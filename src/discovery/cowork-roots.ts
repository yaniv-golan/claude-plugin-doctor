/**
 * Tier A — Discovery: Cowork roots walker.
 *
 * Walks <userData>/local-agent-mode-sessions/<accountId>/<orgId>/ and
 * enumerates CoworkRoot entries. Pure filesystem I/O; no staleness
 * classification, no network.
 *
 * NOTE: This is a parallel implementation to enumerateCoworkRoots() in
 * paths.ts. That function returns the `CoworkRootInfo` shape used by the
 * per-command reporters (refresh, list, watch, check) and must not be
 * changed — those callers depend on it. This function returns the
 * `CoworkRoot` shape consumed by the scan pipeline.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type KnownMarketplace, parseKnownMarketplaces } from "../known-marketplaces.js";
import { NotImplementedError, resolveUserDataDir } from "../paths.js";
import type { CoworkRoot, KnownMarketplaceEntry } from "../types.js";
import { pickMostRecentCoworkRoot } from "./active-root.js";

type SystemContext = {
  platform?: NodeJS.Platform;
  home?: string;
};

/**
 * Adapts a KnownMarketplace (from `parseKnownMarketplaces`) into the
 * `KnownMarketplaceEntry` shape used by the scan pipeline. Shared logic
 * with ccd-root.ts.
 *
 * - source.kind: from km.source.source (the inner "source" field)
 * - source.raw: the entire source object
 * - lastUpdated: extracted from raw.lastUpdated if a number (ms epoch)
 * - installLocation: extracted from raw.installLocation if a string
 */
function adaptMarketplace(km: KnownMarketplace): KnownMarketplaceEntry {
  const raw = km.raw;

  const rawLastUpdated = raw.lastUpdated;
  const lastUpdated: number | undefined =
    typeof rawLastUpdated === "number" ? rawLastUpdated : undefined;

  const rawInstallLocation = raw.installLocation;
  const installLocation: string | undefined =
    typeof rawInstallLocation === "string" ? rawInstallLocation : undefined;

  return {
    name: km.name,
    source: {
      kind: km.source.source,
      raw: km.source as unknown,
    },
    raw: raw,
    ...(lastUpdated !== undefined ? { lastUpdated } : {}),
    ...(installLocation !== undefined ? { installLocation } : {}),
  };
}

/**
 * Reads known_marketplaces.json from coworkPluginsDir and returns adapted
 * entries. Returns empty array on any absence; propagates on malformed JSON.
 */
function readMarketplaces(coworkPluginsDir: string): KnownMarketplaceEntry[] {
  const file = path.join(coworkPluginsDir, "known_marketplaces.json");
  const { marketplaces } = parseKnownMarketplaces(file);
  return marketplaces.map(adaptMarketplace);
}

/**
 * Discovers all Cowork roots under <userData>/local-agent-mode-sessions/.
 *
 * Returns [] if:
 *   - The platform is non-darwin (resolveUserDataDir throws NotImplementedError)
 *   - The sessions directory doesn't exist
 *
 * The `skills-plugin/` directory is explicitly skipped — it is enumerated by
 * discoverSkillsPluginRoot() instead.
 *
 * `isMostRecent` is set to true on at most one root: the one with the largest
 * `installedPluginsMtime`. Ties: first occurrence (insertion order) wins. When
 * no root has a defined mtime, no root is isMostRecent.
 */
export function discoverCoworkRoots(ctx?: SystemContext): CoworkRoot[] {
  let userDataDir: string;
  try {
    userDataDir = resolveUserDataDir(ctx ?? {});
  } catch (err) {
    if (err instanceof NotImplementedError) return [];
    throw err;
  }

  const sessionsDir = path.join(userDataDir, "local-agent-mode-sessions");
  if (!fs.existsSync(sessionsDir)) return [];

  let accountDirs: string[];
  try {
    accountDirs = fs.readdirSync(sessionsDir);
  } catch {
    return [];
  }

  const out: CoworkRoot[] = [];

  for (const accountId of accountDirs) {
    // Skip the skills-plugin special directory — handled by skills-plugin-root.ts.
    if (accountId === "skills-plugin") continue;

    const accDir = path.join(sessionsDir, accountId);
    let accStat: fs.Stats;
    try {
      accStat = fs.statSync(accDir);
    } catch {
      continue;
    }
    if (!accStat.isDirectory()) continue;

    let orgDirs: string[];
    try {
      orgDirs = fs.readdirSync(accDir);
    } catch {
      continue;
    }

    for (const orgId of orgDirs) {
      // Skip session-local and ditto-bridge dirs — they are siblings of <orgId>
      // at the account level. The session-locals walker handles them separately.
      // Matches: local_<UUID> and local_ditto_<UUID>_g<N>.
      if (/^local_/.test(orgId)) continue;

      const rootPath = path.join(accDir, orgId);
      let orgStat: fs.Stats;
      try {
        orgStat = fs.statSync(rootPath);
      } catch {
        continue;
      }
      if (!orgStat.isDirectory()) continue;

      const coworkPluginsDir = path.join(rootPath, "cowork_plugins");
      const rpmDir = path.join(rootPath, "rpm");

      const hasCoworkPlugins = fs.existsSync(coworkPluginsDir);
      const hasRpm = fs.existsSync(rpmDir);

      // Optional path fields: only set if the file exists on disk.
      const knownMarketplacesFile = path.join(coworkPluginsDir, "known_marketplaces.json");
      const installedPluginsFile = path.join(coworkPluginsDir, "installed_plugins.json");
      const rpmManifestFile = path.join(rpmDir, "manifest.json");
      const coworkSettingsFile = path.join(rootPath, "cowork_settings.json");

      const knownMarketplacesPath = fs.existsSync(knownMarketplacesFile)
        ? knownMarketplacesFile
        : undefined;
      const installedPluginsPath = fs.existsSync(installedPluginsFile)
        ? installedPluginsFile
        : undefined;
      const rpmManifestPath = fs.existsSync(rpmManifestFile) ? rpmManifestFile : undefined;
      const coworkSettingsPath = fs.existsSync(coworkSettingsFile) ? coworkSettingsFile : undefined;

      // Stat installed_plugins.json for mtime.
      let installedPluginsMtime: number | undefined;
      if (installedPluginsPath !== undefined) {
        try {
          installedPluginsMtime = fs.statSync(installedPluginsPath).mtimeMs;
        } catch {
          installedPluginsMtime = undefined;
        }
      }

      // Read known_marketplaces.json if present; empty array otherwise.
      let marketplaces: KnownMarketplaceEntry[] = [];
      if (hasCoworkPlugins) {
        marketplaces = readMarketplaces(coworkPluginsDir);
      }

      out.push({
        accountId,
        orgId,
        rootPath,
        hasCoworkPlugins,
        hasRpm,
        // isMostRecent is set in a second pass below.
        isMostRecent: false,
        marketplaces,
        ...(knownMarketplacesPath !== undefined ? { knownMarketplacesPath } : {}),
        ...(installedPluginsPath !== undefined ? { installedPluginsPath } : {}),
        ...(rpmManifestPath !== undefined ? { rpmManifestPath } : {}),
        ...(coworkSettingsPath !== undefined ? { coworkSettingsPath } : {}),
        ...(installedPluginsMtime !== undefined ? { installedPluginsMtime } : {}),
      });
    }
  }

  // Second pass: set isMostRecent on the root with the largest installedPluginsMtime.
  // Uses pickMostRecentCoworkRoot for consistent logic (same heuristic exported for tests).
  const mostRecent = pickMostRecentCoworkRoot(out);
  if (mostRecent !== undefined) {
    for (const root of out) {
      if (root === mostRecent) {
        root.isMostRecent = true;
      }
    }
  }

  return out;
}
