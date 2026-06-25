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
import {
  mergeMarketplaceDeclarations,
  readCrossCuttingExtraKnownMarketplaces,
  readExtraKnownMarketplacesFrom,
} from "./extra-known-marketplaces.js";
import { enumerateSessionConfigs } from "./session-configs.js";

type SystemContext = {
  platform?: NodeJS.Platform;
  home?: string;
  env?: Record<string, string | undefined>;
  /** Used for `projectSettings` / `localSettings` resolution. Defaults to
   *  `process.cwd()` when not injected; tests inject a tmp dir. */
  cwd?: string;
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

  // Read cross-cutting extraKnownMarketplaces ONCE for the whole pass —
  // userSettings, projectSettings, localSettings, policySettings all apply
  // machine-globally (or cwd-relative for project/local) and the same set
  // gets merged into every cowork root's marketplace inventory. See
  // PLAN-2026-05-06-tranche-2.md "Per-root vs global merge semantics".
  const crossCutting = readCrossCuttingExtraKnownMarketplaces(ctx ?? {});

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

      // Stat rpm/manifest.json for mtime. Considered alongside
      // installedPluginsMtime by the active-root heuristic — Personal-plugins
      // installs touch only this file, not installed_plugins.json.
      let rpmManifestMtime: number | undefined;
      if (rpmManifestPath !== undefined) {
        try {
          rpmManifestMtime = fs.statSync(rpmManifestPath).mtimeMs;
        } catch {
          rpmManifestMtime = undefined;
        }
      }

      // Read known_marketplaces.json if present; empty array otherwise.
      // A malformed/locked file in ONE Cowork root must not abort discovery for
      // every command (parseKnownMarketplaces throws on bad JSON). Skip just this
      // root's marketplaces and keep going — same swallow-and-continue posture as
      // the readdirSync/statSync catches above in this loop.
      let knownEntries: KnownMarketplaceEntry[] = [];
      if (hasCoworkPlugins) {
        try {
          knownEntries = readMarketplaces(coworkPluginsDir);
        } catch {
          knownEntries = [];
        }
      }

      // Read this cowork root's per-root coworkSettings.extraKnownMarketplaces
      // (if cowork_settings.json exists). Per-root scope — does NOT apply to
      // other cowork roots or to CCD.
      const coworkExtras =
        coworkSettingsPath !== undefined
          ? readExtraKnownMarketplacesFrom(coworkSettingsPath, "coworkSettings")
          : [];

      // Merge: known_marketplaces.json + cross-cutting (machine-global +
      // cwd-relative) + this root's coworkSettings. Cross-cutting is shared
      // across roots; coworkExtras is per-root.
      const marketplaces = mergeMarketplaceDeclarations(knownEntries, [
        ...crossCutting,
        ...coworkExtras,
      ]);

      // Per-session feature-gate sidecars (Item 2 — gist revision
      // 2026-05-06T11:27:26Z §"Per-session feature gates"). Walk
      // `<rootPath>/local_*.json` for sessions that have toggled
      // pluginsEnabled / skillsEnabled away from their default-true.
      const sessionEnum = enumerateSessionConfigs(rootPath);

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
        ...(rpmManifestMtime !== undefined ? { rpmManifestMtime } : {}),
        ...(sessionEnum.configs.length > 0 ? { sessionConfigs: sessionEnum.configs } : {}),
        ...(sessionEnum.truncated ? { sessionConfigsTruncated: true } : {}),
        ...(sessionEnum.totalScanned > 0
          ? { sessionConfigsTotalScanned: sessionEnum.totalScanned }
          : {}),
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
