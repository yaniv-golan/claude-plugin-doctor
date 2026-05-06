/**
 * Tier A — Discovery: CCD root walker.
 *
 * Reads ~/.claude/plugins (or $CLAUDE_CONFIG_DIR/plugins) and populates a
 * CcdRoot. Pure filesystem I/O; no staleness classification, no network.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type KnownMarketplace, parseKnownMarketplaces } from "../known-marketplaces.js";
import { NotImplementedError, resolveCcdPluginsRoot } from "../paths.js";
import type { CcdRoot, KnownMarketplaceEntry } from "../types.js";
import {
  mergeMarketplaceDeclarations,
  readCrossCuttingExtraKnownMarketplaces,
} from "./extra-known-marketplaces.js";

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
 * `KnownMarketplaceEntry` shape consumed by the scan pipeline.
 *
 * The existing parser's KnownMarketplace.source has shape { source: string; ... }
 * (double-source: the field name is "source" and the key is also "source").
 * KnownMarketplaceEntry.source.kind comes from that inner `.source` string.
 * The entire source object is preserved as source.raw.
 */
function adaptMarketplace(km: KnownMarketplace): KnownMarketplaceEntry {
  const raw = km.raw;

  // Extract lastUpdated — spec says it's a number (ms epoch). Real files use
  // ISO strings; we intentionally leave those as undefined per the spec.
  const rawLastUpdated = raw.lastUpdated;
  const lastUpdated: number | undefined =
    typeof rawLastUpdated === "number" ? rawLastUpdated : undefined;

  // Extract installLocation from raw if it's a string.
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
 * Discovers the CCD (Claude Code Desktop) plugins root on disk.
 *
 * Returns `undefined` if:
 *   - The platform is non-darwin (resolveCcdPluginsRoot throws NotImplementedError), OR
 *   - The plugins root directory doesn't exist on disk.
 *
 * Otherwise returns a populated CcdRoot. Does not throw on missing or empty
 * known_marketplaces.json; throws if it is present but malformed.
 */
export function discoverCcdRoot(ctx?: SystemContext): CcdRoot | undefined {
  let pluginsRoot: string;
  try {
    pluginsRoot = resolveCcdPluginsRoot(ctx ?? {});
  } catch (err) {
    if (err instanceof NotImplementedError) return undefined;
    throw err;
  }

  if (!fs.existsSync(pluginsRoot)) return undefined;

  const knownMarketplacesPath = path.join(pluginsRoot, "known_marketplaces.json");
  const installedPluginsPath = path.join(pluginsRoot, "installed_plugins.json");
  const marketplacesDir = path.join(pluginsRoot, "marketplaces");
  const cacheDir = path.join(pluginsRoot, "cache");

  // Stat installed_plugins.json for its mtime.
  let installedPluginsMtime: number | undefined;
  try {
    installedPluginsMtime = fs.statSync(installedPluginsPath).mtimeMs;
  } catch {
    installedPluginsMtime = undefined;
  }

  // Parse known_marketplaces.json. Returns empty array when absent; propagates
  // on malformed JSON (parser already throws a descriptive message).
  const { marketplaces: rawMarketplaces } = parseKnownMarketplaces(knownMarketplacesPath);
  const knownEntries: KnownMarketplaceEntry[] = rawMarketplaces.map(adaptMarketplace);

  // Merge with cross-cutting `extraKnownMarketplaces` declarations from
  // settings sources. The CCD root receives all four cross-cutting sources
  // (userSettings + projectSettings + localSettings + policySettings); cowork
  // roots receive these PLUS their per-root coworkSettings (handled in
  // cowork-roots.ts). See PLAN-2026-05-06-tranche-2.md "Per-root vs global
  // merge semantics".
  const extras = readCrossCuttingExtraKnownMarketplaces(ctx ?? {});
  const marketplaces = mergeMarketplaceDeclarations(knownEntries, extras);

  return {
    pluginsRoot,
    knownMarketplacesPath,
    installedPluginsPath,
    marketplacesDir,
    cacheDir,
    marketplaces,
    ...(installedPluginsMtime !== undefined ? { installedPluginsMtime } : {}),
  };
}
