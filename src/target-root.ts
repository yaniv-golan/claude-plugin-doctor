import * as fs from "node:fs";
import * as path from "node:path";
import { effectiveActiveMtime } from "./discovery/active-root.js";
import { parseKnownMarketplaces } from "./known-marketplaces.js";
import {
  coworkPluginsRootFor,
  enumerateCoworkRoots,
  resolveCcdPluginsRoot,
  resolveUserDataDir,
} from "./paths.js";

export type TargetRootDirective =
  | { kind: "ccd" }
  | { kind: "cowork"; accountId: string; orgId: string };

export type ResolveTargetRootResult = {
  directive?: TargetRootDirective;
  searched: string[];
  ambiguous: boolean;
};

type Candidate = {
  directive: TargetRootDirective;
  hasClone: boolean;
  mtime: number;
};

/**
 * True if `known_marketplaces.json` under `pluginsRoot` registers `name`.
 *
 * `parseKnownMarketplaces` THROWS on malformed/schema-invalid JSON
 * (known-marketplaces.ts:51,55). The resolver runs BEFORE `runV05Scan` and
 * probes EVERY root, so without this catch the resolver would be the first
 * stack to throw on a corrupt sibling root. Treat a throwing root as "does not
 * register", mirroring scan.ts:239-241. (Phase A independently makes the
 * subsequent scan's discoverTopology resilient too.)
 */
function registers(pluginsRoot: string, name: string): boolean {
  try {
    const parsed = parseKnownMarketplaces(path.join(pluginsRoot, "known_marketplaces.json"));
    return parsed.marketplaces.some((m) => m.name === name);
  } catch {
    return false;
  }
}

/** True if the marketplace clone dir exists on disk under `pluginsRoot`. */
function hasCloneOnDisk(pluginsRoot: string, name: string): boolean {
  return fs.existsSync(path.join(pluginsRoot, "marketplaces", name));
}

function mtimeOf(pluginsRoot: string): number {
  try {
    return fs.statSync(path.join(pluginsRoot, "installed_plugins.json")).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Resolve which plugins root a *named* marketplace lives in, so `refresh`/`list`
 * target the correct root instead of the single root picked by installed_plugins
 * mtime (right for a targetless `scan`, wrong when a marketplace is named).
 *
 * `directive: undefined` when no root registers it → caller keeps the mtime
 * default (and the existing "not registered" error). When >1 root registers it,
 * prefers the root with the clone on disk, then the most recently touched root.
 */
export function resolveTargetRootForMarketplace(args: {
  marketplaceName: string;
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
}): ResolveTargetRootResult {
  const { marketplaceName, platform, home, env } = args;
  const ccdRoot = resolveCcdPluginsRoot({ platform, home, env });
  const userData = resolveUserDataDir({ platform, home });
  const coworkRoots = enumerateCoworkRoots(userData);

  const searched: string[] = [ccdRoot];
  const candidates: Candidate[] = [];

  if (registers(ccdRoot, marketplaceName)) {
    candidates.push({
      directive: { kind: "ccd" },
      hasClone: hasCloneOnDisk(ccdRoot, marketplaceName),
      mtime: mtimeOf(ccdRoot),
    });
  }

  for (const cw of coworkRoots) {
    const cwPluginsRoot = coworkPluginsRootFor(cw);
    searched.push(cwPluginsRoot);
    if (registers(cwPluginsRoot, marketplaceName)) {
      candidates.push({
        directive: { kind: "cowork", accountId: cw.accountId, orgId: cw.orgId },
        hasClone: hasCloneOnDisk(cwPluginsRoot, marketplaceName),
        // Same recent-activity timestamp the active-root heuristic uses (max of
        // installed_plugins and rpm/manifest mtimes) so Personal-plugins roots
        // — which touch only rpm/manifest.json — aren't under-ranked.
        mtime: effectiveActiveMtime(cw) ?? mtimeOf(cwPluginsRoot),
      });
    }
  }

  if (candidates.length === 0) {
    return { searched, ambiguous: false };
  }

  candidates.sort((a, b) => {
    if (a.hasClone !== b.hasClone) return a.hasClone ? -1 : 1;
    return b.mtime - a.mtime;
  });

  const best = candidates[0];
  if (best === undefined) {
    return { searched, ambiguous: false };
  }
  return { directive: best.directive, searched, ambiguous: candidates.length > 1 };
}
