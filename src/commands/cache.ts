/**
 * `cpd cache` subcommand — v1.0 deliverable (SPEC-v1.0.md §9.1 + §18.7).
 *
 * Subcommands:
 *   --prune-cowork-sessions  Reap stale local_<UUID>/ and local_ditto_*_g<N>/ dirs.
 *   --orphans                List install-snapshot dirs not referenced by any
 *                            installed_plugins.json entry (read-only).
 *
 * Liveness check for --prune-cowork-sessions (§18.7):
 *   Skip a dir if any of:
 *     - mtime within the last 30 minutes (active-session heuristic)
 *     - newer than --older-than <days> (default 14)
 *     - contains a lockfile (*.lock, LOCK) UNLESS --force
 *   With --dry-run (always default): list candidates and total reclaimable bytes.
 *   With --yes AND !--dry-run: delete.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionLocalDir } from "../types.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type CachePruneOpts = {
  /** Dirs whose mtime is > olderThanDays ago are candidates. Default: 14. */
  olderThanDays: number;
  /** When true, bypass the lockfile check (still respects 30-min heuristic). */
  force: boolean;
  /** When true (default), list candidates but do not delete. */
  dryRun: boolean;
  /** When true AND !dryRun, actually delete. Guard gate. */
  yes: boolean;
  /** Session-local dirs collected from topology. */
  sessionLocals: SessionLocalDir[];
  /** Logger-compatible output sink. */
  logger?: { info(msg: string, data?: Record<string, unknown>): void };
};

export type CachePruneCandidate = {
  pathOnDisk: string;
  kind: SessionLocalDir["kind"];
  lastModified: number;
  approxSizeBytes: number;
  skipReason?: string;
};

export type CachePruneReport = {
  kind: "cache_prune";
  dryRun: boolean;
  candidates: CachePruneCandidate[];
  deleted: string[];
  skipped: CachePruneCandidate[];
  totalReclaimableBytes: number;
  totalDeletedBytes: number;
  exitCode: 0 | 1;
};

export type CacheOrphanEntry = {
  orphanPath: string;
  marketplace: string;
  pluginName: string;
  version: string;
  approxSizeBytes: number;
};

/** A top-level directory under `cache/` that isn't a real marketplace —
 *  either a `temp_subdir_*` staging dir from an interrupted
 *  `claude plugin marketplace add` operation, or a marketplace that was
 *  removed from `known_marketplaces.json`. Reported as a single entry per
 *  parent dir with recursive size, NOT exploded into sub-paths the way an
 *  earlier version of the orphan walker did (it accidentally reported
 *  `temp_subdir_X/.git/hooks` as a "plugin install orphan"). */
export type CacheStrayEntry = {
  strayPath: string;
  approxSizeBytes: number;
  reason: "temp-staging-dir" | "unknown-marketplace";
};

export type CacheOrphansReport = {
  kind: "cache_orphans";
  orphans: CacheOrphanEntry[];
  strayDirs: CacheStrayEntry[];
  totalOrphanBytes: number;
  totalStrayBytes: number;
  exitCode: 0;
};

// ── Constants ────────────────────────────────────────────────────────────────

/** Active-session heuristic: skip dirs modified within the last 30 minutes. */
const ACTIVE_SESSION_WINDOW_MS = 30 * 60 * 1000;

/** Lockfile names / patterns that indicate a session is active. */
const LOCKFILE_NAMES = new Set(["LOCK", ".lock", "session.lock"]);
const LOCKFILE_EXT = ".lock";

// ── Helpers ─────────────────────────────────────────────────────────────────

function hasLockfile(dirPath: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    return false;
  }
  return entries.some((e) => LOCKFILE_NAMES.has(e) || e.endsWith(LOCKFILE_EXT));
}

/** Recursive directory-size walker. fs.statSync(dir).size returns the
 *  inode/dir-entry size on most filesystems — typically 64-1024 bytes —
 *  NOT the cumulative size of the directory's contents. Earlier versions
 *  of this file used the non-recursive form, which produced the visible bug
 *  of `cpd cache --orphans` reporting "Total orphan size: 8.3 KB" for a
 *  cache containing multi-megabyte git-pack stragglers. */
function dirSizeBytes(dirPath: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    try {
      if (entry.isSymbolicLink()) {
        // Don't follow symlinks — fs.statSync would follow, lstatSync gives
        // the link entry's own size which is small. Skip them entirely;
        // counting symlinked content would double-count.
        continue;
      }
      if (entry.isFile()) {
        total += fs.statSync(full).size;
      } else if (entry.isDirectory()) {
        total += dirSizeBytes(full);
      }
    } catch {
      // skip unreadable entries
    }
  }
  return total;
}

/** Heuristic: does this top-level directory name under `cache/` look like
 *  a transient staging directory left behind by an interrupted upstream
 *  `claude plugin marketplace add`? The Anthropic CLI's pattern is
 *  `temp_subdir_<unix-ms>_<random>.clone/`. We also catch any other
 *  `temp_*` / `temp.*` / `.temp*` form defensively — none of these are
 *  real marketplaces. */
function isTempStagingDirName(name: string): boolean {
  return (
    name.startsWith("temp_") ||
    name.startsWith("temp.") ||
    name.startsWith(".temp_") ||
    name.startsWith(".temp.")
  );
}

/** Read `known_marketplaces.json` and return the set of registered marketplace
 *  names. Used to cross-check entries under `cache/` — a directory whose name
 *  isn't in this set is most likely either a stray staging dir or a
 *  marketplace that was removed (the upstream CLI does NOT clean up the
 *  `cache/<mp>/` tree on `claude plugin marketplace remove`). Returns an
 *  empty set on any error — callers should treat that as "no information"
 *  rather than "no known marketplaces" (failing closed would mark every
 *  cache entry as stray). */
function loadKnownMarketplaceNames(pluginsRoot: string): Set<string> {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(pluginsRoot, "known_marketplaces.json"), "utf8"),
    ) as Record<string, unknown>;
    return new Set(Object.keys(raw));
  } catch {
    return new Set();
  }
}

// ── Prune cowork sessions ────────────────────────────────────────────────────

export function runCachePrune(opts: CachePruneOpts): CachePruneReport {
  const now = Date.now();
  const olderThanMs = opts.olderThanDays * 24 * 60 * 60 * 1000;

  const candidates: CachePruneCandidate[] = [];
  const skipped: CachePruneCandidate[] = [];
  const deleted: string[] = [];
  let totalReclaimableBytes = 0;
  let totalDeletedBytes = 0;

  for (const dir of opts.sessionLocals) {
    const approxSizeBytes =
      dir.approxSizeBytes > 0 ? dir.approxSizeBytes : dirSizeBytes(dir.pathOnDisk);

    // Skip: active-session heuristic (modified within last 30 min)
    if (now - dir.lastModified < ACTIVE_SESSION_WINDOW_MS) {
      skipped.push({
        pathOnDisk: dir.pathOnDisk,
        kind: dir.kind,
        lastModified: dir.lastModified,
        approxSizeBytes,
        skipReason: "active-session-heuristic (modified within 30 min)",
      });
      continue;
    }

    // Skip: newer than --older-than threshold
    if (now - dir.lastModified < olderThanMs) {
      skipped.push({
        pathOnDisk: dir.pathOnDisk,
        kind: dir.kind,
        lastModified: dir.lastModified,
        approxSizeBytes,
        skipReason: `newer-than-${opts.olderThanDays}d threshold`,
      });
      continue;
    }

    // Skip: lockfile present (unless --force)
    if (!opts.force && hasLockfile(dir.pathOnDisk)) {
      skipped.push({
        pathOnDisk: dir.pathOnDisk,
        kind: dir.kind,
        lastModified: dir.lastModified,
        approxSizeBytes,
        skipReason: "lockfile-present (use --force to bypass)",
      });
      continue;
    }

    // Candidate
    candidates.push({
      pathOnDisk: dir.pathOnDisk,
      kind: dir.kind,
      lastModified: dir.lastModified,
      approxSizeBytes,
    });
    totalReclaimableBytes += approxSizeBytes;
  }

  // Destructive gate: only delete when --yes AND !--dry-run
  if (!opts.dryRun && opts.yes) {
    for (const candidate of candidates) {
      try {
        fs.rmSync(candidate.pathOnDisk, { recursive: true, force: true });
        deleted.push(candidate.pathOnDisk);
        totalDeletedBytes += candidate.approxSizeBytes;
        opts.logger?.info("cache_prune_deleted", { path: candidate.pathOnDisk });
      } catch (err) {
        opts.logger?.info("cache_prune_delete_failed", {
          path: candidate.pathOnDisk,
          error: (err as Error).message,
        });
      }
    }
  }

  return {
    kind: "cache_prune",
    dryRun: opts.dryRun || !opts.yes,
    candidates,
    deleted,
    skipped,
    totalReclaimableBytes,
    totalDeletedBytes,
    exitCode: 0,
  };
}

// ── Cache orphans ────────────────────────────────────────────────────────────

export type CacheOrphansOpts = {
  /** Absolute path to the plugins root (<ccd-root>/plugins or cowork_plugins). */
  pluginsRoot: string;
};

export function runCacheOrphans(opts: CacheOrphansOpts): CacheOrphansReport {
  const cacheDir = path.join(opts.pluginsRoot, "cache");
  const orphans: CacheOrphanEntry[] = [];
  const strayDirs: CacheStrayEntry[] = [];
  let totalOrphanBytes = 0;
  let totalStrayBytes = 0;

  const empty: CacheOrphansReport = {
    kind: "cache_orphans",
    orphans: [],
    strayDirs: [],
    totalOrphanBytes: 0,
    totalStrayBytes: 0,
    exitCode: 0,
  };

  // Load installed_plugins.json to build the set of referenced install paths.
  // If we can't parse it, we have no ground truth for "is this a real orphan"
  // — bail rather than flagging everything (which would be worse than
  // reporting nothing).
  const installedPath = path.join(opts.pluginsRoot, "installed_plugins.json");
  const referencedPaths = new Set<string>();
  try {
    const raw = JSON.parse(fs.readFileSync(installedPath, "utf8")) as {
      plugins?: Record<string, Array<{ installPath?: string }>>;
    };
    if (raw.plugins && typeof raw.plugins === "object") {
      for (const entries of Object.values(raw.plugins)) {
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            if (typeof entry.installPath === "string") {
              referencedPaths.add(entry.installPath);
            }
          }
        }
      }
    }
  } catch {
    return empty;
  }

  if (!fs.existsSync(cacheDir)) return empty;

  let topLevelEntries: string[];
  try {
    topLevelEntries = fs.readdirSync(cacheDir);
  } catch {
    return empty;
  }

  // Cross-check: top-level dirs under cache/ should correspond to a known
  // marketplace registered in known_marketplaces.json. Anything else is
  // either a transient staging dir or a marketplace that was removed
  // without cleanup — both warrant the "stray dir" classification rather
  // than the (misleading) "plugin install orphan" classification.
  const knownMarketplaces = loadKnownMarketplaceNames(opts.pluginsRoot);

  for (const topName of topLevelEntries) {
    const topDir = path.join(cacheDir, topName);
    let topStat: fs.Stats;
    try {
      topStat = fs.statSync(topDir);
    } catch {
      continue;
    }
    if (!topStat.isDirectory()) continue;

    // Stray-dir detection. Precedence: known-marketplace membership wins
    // over the temp_* name pattern, so a marketplace legitimately
    // registered as `temp_legitimate` is NOT classified as a stray. The
    // stray heuristics only fire for dirs that are NOT in the registry.
    if (!knownMarketplaces.has(topName)) {
      // Unknown-marketplace stray: we have a non-empty registry and
      // this dir isn't in it.
      if (knownMarketplaces.size > 0) {
        const size = dirSizeBytes(topDir);
        strayDirs.push({
          strayPath: topDir,
          approxSizeBytes: size,
          reason: "unknown-marketplace",
        });
        totalStrayBytes += size;
        continue;
      }
      // Temp-staging stray: empty registry (or unreadable) AND the
      // name matches the staging-dir pattern. The
      // `temp_subdir_<unix-ms>_<rand>.clone/` interrupted-install case.
      if (isTempStagingDirName(topName)) {
        const size = dirSizeBytes(topDir);
        strayDirs.push({
          strayPath: topDir,
          approxSizeBytes: size,
          reason: "temp-staging-dir",
        });
        totalStrayBytes += size;
        continue;
      }
      // Empty registry, plain name — fall through and walk best-effort.
    }

    // Real marketplace — walk <mp>/<plugin>/<version>/ for plugin orphans.
    let plugins: string[];
    try {
      plugins = fs.readdirSync(topDir);
    } catch {
      continue;
    }

    for (const pluginName of plugins) {
      const pluginDir = path.join(topDir, pluginName);
      let pluginStat: fs.Stats;
      try {
        pluginStat = fs.statSync(pluginDir);
      } catch {
        continue;
      }
      if (!pluginStat.isDirectory()) continue;

      let versions: string[];
      try {
        versions = fs.readdirSync(pluginDir);
      } catch {
        continue;
      }

      for (const version of versions) {
        const versionDir = path.join(pluginDir, version);
        let versionStat: fs.Stats;
        try {
          versionStat = fs.statSync(versionDir);
        } catch {
          continue;
        }
        if (!versionStat.isDirectory()) continue;

        if (!referencedPaths.has(versionDir)) {
          const approxSizeBytes = dirSizeBytes(versionDir);
          orphans.push({
            orphanPath: versionDir,
            marketplace: topName,
            pluginName,
            version,
            approxSizeBytes,
          });
          totalOrphanBytes += approxSizeBytes;
        }
      }
    }
  }

  return {
    kind: "cache_orphans",
    orphans,
    strayDirs,
    totalOrphanBytes,
    totalStrayBytes,
    exitCode: 0,
  };
}
