import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { type InstalledPlugin, preferredScope } from "../installed-plugins.js";
import { hashSourceDir } from "../source-hash.js";
import { parsePluginEntrySource } from "../sources/source-kind.js";
import type {
  CacheSnapshot,
  CheckResult,
  CheckStatus,
  InstallSnapshotData,
  PluginRef,
  RootRef,
  PluginEntrySourceKind as TierCPluginEntrySourceKind,
} from "../types.js";

/**
 * Plugin-entry source schema (narrower than the marketplace-level source
 * schema; see SPEC.md §4 Layer 2). Two real-world shapes:
 *
 *   1. **String** — relative path inside the marketplace clone. Plugin
 *      lives co-located with the catalog. Both Desktop badge and CLI's
 *      update op read the same `<clone>/<source>/.claude-plugin/plugin.json`.
 *
 *   2. **Object** — tagged-union by inner `source` discriminator. Plugin
 *      source is fetched separately (lives outside the clone). Desktop
 *      badge reads marketplace.json#version; CLI's update fetches fresh.
 *
 * `passthrough()` on the inner object so future fields don't fail the parse.
 */
const MarketplaceJsonPluginEntry = z
  .object({
    name: z.string(),
    version: z.string().optional(),
    source: z
      .union([
        z.string(),
        z
          .object({
            source: z.string().optional(),
            url: z.string().optional(),
            repo: z.string().optional(),
            path: z.string().optional(),
            ref: z.string().optional(),
            sha: z.string().optional(),
            package: z.string().optional(),
            registry: z.string().optional(),
          })
          .passthrough(),
      ])
      .optional(),
    /** Older marketplace.json files use `path` at the entry level instead of
     *  `source` (legacy directory-source convention). */
    path: z.string().optional(),
  })
  .passthrough();

const MarketplaceJsonSchema = z
  .object({
    plugins: z.array(MarketplaceJsonPluginEntry).optional(),
  })
  .passthrough();

/** Plugin entry's source kind — the discriminator that determines whether
 *  plugin.json lives in the clone (string) or must be fetched (object).
 *
 *  v0.5 path's local alias of the public PluginEntrySourceKind. Kept in sync
 *  with `src/types.ts` — the failure-mode triple ("not-probed-by-cpd",
 *  "unrecognized-source-kind", "clone-unreadable") replaces the old single
 *  "unsupported" catchall. */
export type PluginEntrySourceKind =
  | "string"
  | "github"
  | "git-subdir"
  | "url"
  | "npm"
  | "not-probed-by-cpd"
  | "unrecognized-source-kind"
  | "clone-unreadable";

/** Where the resolver got `resolvedVersion`. Both Desktop badge and CLI use
 *  the same priority chain; this records which step succeeded. */
export type ResolvedVersionSource =
  | "plugin.json-in-clone" // primary; works for string-source
  | "marketplace.json" // fallback; only meaningful surface for object-source without remote fetch
  | "remote-plugin.json" // network-fetched; preferred over marketplace.json for object-source
  | "git-sha-12" // resolver levels 3-5, deferred to v0.6
  | "git-sha"
  | "unknown";

/** v0.5 trap taxonomy. See SPEC.md §4 Layer 2. */
export type VersionTrapKind =
  | "refresh-needed"
  | "bump-needed"
  | "badge-only-needed"
  | "marketplace-update-broken"
  | "npm-source-not-supported"
  | "unsupported-source";

export type MarketplacePluginEntry = {
  name: string;
  version?: string;
  /** Path relative to the marketplace clone root (string-source only —
   *  object-source plugins don't live in the clone). */
  source?: string;
  /** Plugin entry's source-kind discriminator. */
  sourceKind: PluginEntrySourceKind;
  /** Older marketplace.json files use `path` instead of `source`. */
  path?: string;
};

export type CheckArgs = {
  pluginsRoot: string;
  installed: InstalledPlugin;
  /** Current marketplace clone HEAD SHA, when known. */
  cloneHeadSha?: string;
  /** Marketplace-level source type — controls source-hash drift detection. */
  marketplaceSourceType?: "github" | "git" | "directory" | "remote" | "unknown";
  /** For directory-source marketplaces: absolute path to the marketplace root. */
  marketplaceSourceRoot?: string;
  /** Layer 1's status for this plugin's marketplace. Distinguishes
   *  refresh-needed from bump-needed when commits diverged with matching
   *  versions. */
  marketplaceCloneStatus?: CheckStatus;
  /** Plugin.json#version fetched from remote at Layer 1's headRemote SHA.
   *  For object-source plugins, this is what `claude plugin update` would
   *  install — and what the Desktop badge can't see (the badge falls back to
   *  marketplace.json#plugins[].version). Comparing them detects
   *  badge-only-needed. */
  remoteCliVersion?: string;
  /** Pre-computed `git log <installedSha>..<cloneHeadSha> -- <pluginSubdir>`
   *  result, when commits diverged AND the local clone has both SHAs. Used by
   *  the bump-needed renderer to surface the actual commits between the user's
   *  install and the clone HEAD so the human can judge whether the divergence
   *  is functionally relevant (real bump-needed) or docs/CI-only (no-op fine).
   *  Computed by the caller (async-capable context); checkInstallSnapshot is
   *  sync and just consumes the result. */
  commitsBetween?: { sha: string; subject: string }[];
  /** Whether `commitsBetween` was truncated (more commits exist than were
   *  returned). Renders as "(+N more)" in the detail output. */
  commitsBetweenTruncated?: boolean;
};

export function readMarketplaceJson(
  pluginsRoot: string,
  marketplace: string,
): { ok: true; plugins: MarketplacePluginEntry[] } | { ok: false; reason: string } {
  const p = path.join(
    pluginsRoot,
    "marketplaces",
    marketplace,
    ".claude-plugin",
    "marketplace.json",
  );
  if (!fs.existsSync(p)) return { ok: false, reason: `marketplace.json missing at ${p}` };
  try {
    const json = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
    const parsed = MarketplaceJsonSchema.safeParse(json);
    if (!parsed.success) return { ok: false, reason: `schema mismatch: ${parsed.error.message}` };
    const plugins = (parsed.data.plugins ?? []).map(normalizePluginEntry);
    return { ok: true, plugins };
  } catch (e) {
    return { ok: false, reason: `parse error: ${(e as Error).message}` };
  }
}

/** Normalize the plugin-entry's polymorphic `source` field into a uniform
 *  internal shape with an explicit `sourceKind` discriminator. */
type RawPluginEntry = {
  name: string;
  version?: string | undefined;
  source?:
    | string
    | { source?: string | undefined; path?: string | undefined; url?: string | undefined }
    | undefined;
  path?: string | undefined;
};

function normalizePluginEntry(entry: RawPluginEntry): MarketplacePluginEntry {
  const out: MarketplacePluginEntry = { name: entry.name, sourceKind: "string" };
  if (entry.version !== undefined) out.version = entry.version;
  if (typeof entry.source === "string") {
    out.source = entry.source;
    out.sourceKind = "string";
  } else if (entry.source && typeof entry.source === "object") {
    if (typeof entry.source.path === "string") out.source = entry.source.path;
    const inner = typeof entry.source.source === "string" ? entry.source.source : "string";
    out.sourceKind = normalizeSourceKind(inner);
  }
  if (entry.path !== undefined) out.path = entry.path;
  return out;
}

function normalizeSourceKind(raw: string): PluginEntrySourceKind {
  if (raw === "github" || raw === "git-subdir" || raw === "url" || raw === "npm") return raw;
  // `directory`, `git` (object form, non-github HTTPS/SSH), and `backend` are
  // recognized by Claude Code but not yet probed by cpd's tier-C taxonomy.
  // Group them under "not-probed-by-cpd" so source-advisory stays silent and
  // the user isn't told to "Upgrade Claude Code" for plugins that work fine.
  if (raw === "directory" || raw === "git" || raw === "backend") return "not-probed-by-cpd";
  // An unrecognized discriminator value (e.g., a future `"oci"`/`"wasm"`)
  // is the genuine "Upgrade Claude Code" sentinel.
  // Note: this changes prior behavior — the previous version silently
  // degraded unknown discriminators to "string", which let a futuristic
  // source flow into the string-source resolver chain (wrong). Routing it
  // to "unrecognized-source-kind" lets the source-advisory detector emit
  // the correct "upgrade" advisory.
  return "unrecognized-source-kind";
}

/** Resolve a marketplace plugin's source directory within a clone. Only
 *  meaningful for string-source plugins (where plugin source is co-located
 *  with the catalog). For object-source plugins, the source lives elsewhere
 *  and this returns undefined.
 *
 *  Defense-in-depth (audit issue #10): a hostile or corrupted marketplace.json
 *  with `"source": "../../etc"` would otherwise direct path.resolve at
 *  arbitrary local directories. Containment check below: the resolved path
 *  must equal `marketplaceSourceRoot` exactly (legitimate `"."`/`""` →
 *  plugin source IS the clone root) or sit beneath it. The equality clause
 *  is required, not dead — it's the documented "plugin = whole repo" shape. */
// Exported for unit tests of the path-containment guard (audit issue #10).
export function resolvePluginSourcePath(
  marketplaceSourceRoot: string,
  pluginEntry: MarketplacePluginEntry,
): string | undefined {
  if (pluginEntry.sourceKind !== "string") return undefined;
  const rel = pluginEntry.source ?? pluginEntry.path;
  if (typeof rel === "string") {
    const resolved = path.resolve(marketplaceSourceRoot, rel);
    if (
      resolved !== marketplaceSourceRoot &&
      !resolved.startsWith(marketplaceSourceRoot + path.sep)
    ) {
      return undefined;
    }
    return resolved;
  }
  const conventional = path.join(marketplaceSourceRoot, pluginEntry.name);
  if (fs.existsSync(conventional)) return conventional;
  return undefined;
}

/** Read marketplace.json and return the plugin's source subdirectory relative
 *  to the marketplace clone root. For string-source plugins this is the
 *  directly-recorded `source` (or legacy `path`) field, or the conventional
 *  `<pluginName>/` if the dir exists. Object-source plugins return undefined
 *  (their source lives in a separate repo). Caller uses the result to scope
 *  `git log` to the plugin's subdir when surfacing the commits between an
 *  installed SHA and the clone HEAD. */
export function readPluginSubdir(
  pluginsRoot: string,
  marketplace: string,
  pluginName: string,
): string | undefined {
  const cloneRoot = path.join(pluginsRoot, "marketplaces", marketplace);
  const parsed = readMarketplaceJson(pluginsRoot, marketplace);
  if (!parsed.ok) return undefined;
  const entry = parsed.plugins.find((p) => p.name === pluginName);
  if (!entry) return undefined;
  if (entry.sourceKind !== "string") return undefined;
  const rel = entry.source ?? entry.path;
  if (typeof rel === "string" && rel.length > 0) return rel;
  // Conventional fallback: <pluginName>/ at clone root.
  const conventional = pluginName;
  if (fs.existsSync(path.join(cloneRoot, conventional))) return conventional;
  return undefined;
}

export function readPluginJsonVersion(pluginSourcePath: string): string | undefined {
  const p = path.join(pluginSourcePath, ".claude-plugin", "plugin.json");
  if (!fs.existsSync(p)) return undefined;
  try {
    const json = JSON.parse(fs.readFileSync(p, "utf8")) as { version?: unknown };
    return typeof json.version === "string" ? json.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The shared resolver — same priority chain Desktop badge and CLI's update op
 * use. Returns `{ version, source }` from the first non-undefined step:
 *
 *   1. plugin.json in the clone (string-source plugins; object-source misses)
 *   2. remote-fetched plugin.json (when --fetch-versions; object-source path)
 *   3. marketplace.json#plugins[].version
 *   4-6. SHA fallbacks (deferred to v0.6)
 *
 * Levels 4-6 not detected — returns undefined, caller reports `unknowable`.
 */
function resolveVersion(
  cloneRoot: string,
  pluginEntry: MarketplacePluginEntry,
  remoteCliVersion: string | undefined,
): { version: string; source: ResolvedVersionSource } | undefined {
  // Step 1: plugin.json in the clone (only meaningful for string-source).
  if (pluginEntry.sourceKind === "string") {
    const sourcePath = resolvePluginSourcePath(cloneRoot, pluginEntry);
    if (sourcePath) {
      const v = readPluginJsonVersion(sourcePath);
      if (v) return { version: v, source: "plugin.json-in-clone" };
    }
  }
  // Step 2: remote-fetched plugin.json (object-source path; populated by
  // scan.ts's fetch_remote_versions phase). Preferred over marketplace.json
  // because it's what `claude plugin update` actually installs for these
  // plugins — the catalog entry's version may be stale (badge-only-needed).
  if (remoteCliVersion) {
    return { version: remoteCliVersion, source: "remote-plugin.json" };
  }
  // Step 3: marketplace.json#plugins[].version.
  if (pluginEntry.version) {
    return { version: pluginEntry.version, source: "marketplace.json" };
  }
  // Steps 4-6 deferred to v0.6.
  return undefined;
}

export function checkInstallSnapshot(args: CheckArgs): CheckResult {
  const { pluginsRoot, installed, cloneHeadSha } = args;
  const id = installed.id;
  const primary = preferredScope(installed);
  const installedSha = primary.gitCommitSha;
  const evidence: Record<string, unknown> = {
    installedVersion: primary.version,
    installPath: primary.installPath,
    ...(installedSha ? { installedGitCommitSha: installedSha } : {}),
    ...(cloneHeadSha ? { marketplaceCloneHead: cloneHeadSha } : {}),
  };

  if (!fs.existsSync(primary.installPath)) {
    return {
      plugin: id,
      layer: "install_snapshot",
      status: "missing",
      detail: `installPath ${primary.installPath} does not exist on disk.`,
      evidence,
      recommendation: {
        action: `claude plugin install ${id}`,
        reason: "install snapshot missing — reinstall to repopulate cache",
        risk: "safe",
        cmd: `claude plugin install ${id}`,
      },
    };
  }

  const mp = readMarketplaceJson(pluginsRoot, installed.marketplace);
  if (!mp.ok) {
    return {
      plugin: id,
      layer: "install_snapshot",
      status: "unknowable",
      detail: `Cannot read marketplace.json for "${installed.marketplace}": ${mp.reason}`,
      evidence,
    };
  }

  const entry = mp.plugins.find((p) => p.name === installed.pluginName);
  if (!entry) {
    return {
      plugin: id,
      layer: "install_snapshot",
      status: "missing",
      detail: `Plugin "${installed.pluginName}" not listed in ${installed.marketplace}/marketplace.json.`,
      evidence,
    };
  }

  evidence.pluginEntrySourceKind = entry.sourceKind;
  if (entry.version !== undefined) {
    evidence.marketplaceEntryVersion = entry.version;
  }
  if (args.remoteCliVersion !== undefined) {
    evidence.remoteCliVersion = args.remoteCliVersion;
  }

  // Source-kind-specific advisory branches.
  if (entry.sourceKind === "npm") {
    evidence.versionTrapKind = "npm-source-not-supported" satisfies VersionTrapKind;
    return {
      plugin: id,
      layer: "install_snapshot",
      status: "unknowable",
      detail:
        'Plugin source is "npm" — version resolution requires an npm registry fetch (not yet implemented in cpd).',
      evidence,
    };
  }
  if (entry.sourceKind === "unrecognized-source-kind") {
    // Genuine futuristic discriminator — emit the "Upgrade Claude Code" advisory.
    evidence.versionTrapKind = "unsupported-source" satisfies VersionTrapKind;
    return {
      plugin: id,
      layer: "install_snapshot",
      status: "unknowable",
      detail:
        "Plugin's source kind is one neither this Claude Code nor cpd recognizes — likely a marketplace authored against a newer Claude Code. Upgrade Claude Code.",
      evidence,
    };
  }
  if (entry.sourceKind === "not-probed-by-cpd") {
    // Source is recognized by Claude Code (directory/git/backend) but cpd's
    // tier-C taxonomy doesn't probe it. Stay quiet: no advisory, no drift.
    // The plugin is fine; cpd just can't validate its version.
    return {
      plugin: id,
      layer: "install_snapshot",
      status: "unknowable",
      detail:
        "Plugin's source kind is recognized by Claude Code but not yet probed by cpd. No advisory; cpd just can't validate the version.",
      evidence,
    };
  }
  if (entry.sourceKind === "clone-unreadable") {
    // Marketplace.json couldn't be read or the plugin entry isn't present.
    // The layer-1 marketplace_clone failure is the canonical signal here;
    // emitting a per-plugin advisory would double-count the same root cause.
    return {
      plugin: id,
      layer: "install_snapshot",
      status: "unknowable",
      detail:
        "Cannot determine plugin source kind — marketplace.json is unreadable or the entry is missing. See the marketplace_clone layer for the underlying failure.",
      evidence,
    };
  }

  // Run the shared resolver.
  const cloneRoot = path.join(pluginsRoot, "marketplaces", installed.marketplace);
  const resolved = resolveVersion(cloneRoot, entry, args.remoteCliVersion);
  if (resolved !== undefined) {
    evidence.resolvedVersion = resolved.version;
    evidence.resolvedVersionSource = resolved.source;
  }

  // Resolver couldn't produce a version (no plugin.json, no marketplace.json
  // version, levels 4-6 deferred).
  if (resolved === undefined) {
    const isOutOfClone = entry.sourceKind === "url" || entry.sourceKind === "git-subdir";
    if (isOutOfClone && !args.remoteCliVersion) {
      return {
        plugin: id,
        layer: "install_snapshot",
        status: "unknowable",
        detail: `Plugin source is "${entry.sourceKind}" — version resolution requires a network fetch (cpd doesn't yet probe non-github hosts; --no-network also suppresses any fetch).`,
        evidence,
      };
    }
    return {
      plugin: id,
      layer: "install_snapshot",
      status: "unknowable",
      detail:
        "Neither plugin.json nor marketplace.json carries a version — cannot compare. Git-SHA fallback resolution is not yet implemented.",
      evidence,
    };
  }

  // Version mismatch — `claude plugin update` would resolve.
  if (resolved.version !== primary.version) {
    return {
      plugin: id,
      layer: "install_snapshot",
      status: "stale",
      detail: [
        `Stale install — ${humanSourceLabel(resolved.source)} has ${resolved.version}, you have ${primary.version}`,
        `  installed       ${primary.version}  (commit ${installedSha?.slice(0, 7) ?? "(?)"})`,
        `  ${humanSourceLabel(resolved.source).padEnd(15)} ${resolved.version}`,
        "  fix             claude plugin update",
      ].join("\n"),
      evidence,
      recommendation: {
        action: `claude plugin update ${id}`,
        reason: `version mismatch: installed ${primary.version}, ${humanSourceLabel(resolved.source)} ${resolved.version}`,
        risk: "safe",
        cmd: `claude plugin update ${id}`,
      },
    };
  }

  // Source-dir drift detection — only for `directory`-source marketplaces.
  if (
    args.marketplaceSourceType === "directory" &&
    args.marketplaceSourceRoot &&
    fs.existsSync(args.marketplaceSourceRoot)
  ) {
    const sourcePath = resolvePluginSourcePath(args.marketplaceSourceRoot, entry);
    if (sourcePath && fs.existsSync(sourcePath)) {
      const sourceHash = hashSourceDir(sourcePath);
      const installHash = hashSourceDir(primary.installPath);
      evidence.sourcePluginPath = sourcePath;
      evidence.sourceDirHash = sourceHash;
      evidence.installDirHash = installHash;
      if (sourceHash && installHash && sourceHash !== installHash) {
        return {
          plugin: id,
          layer: "install_snapshot",
          status: "stale",
          detail: [
            "Source drift detected",
            "  cause       you edited the source but didn't reinstall",
            `  source      ${sourcePath}`,
            `  source-hash ${sourceHash.slice(7, 15)}`,
            `  installed   ${installHash.slice(7, 15)}`,
            "  fix         claude plugin update — re-syncs the cache from the source",
          ].join("\n"),
          evidence,
          recommendation: {
            action: `claude plugin update ${id}`,
            reason: "directory source diverged from cache",
            risk: "safe",
            cmd: `claude plugin update ${id}`,
          },
        };
      }
    }
  }

  // Resolved version matches installed. Two more checks before declaring fresh:
  // 1. Commit drift in the local clone (refresh-needed vs bump-needed)
  // 2. badge-only-needed for object-source plugins (cliVersion vs marketplaceEntryVersion)
  const commitsDiverged =
    installedSha !== undefined && cloneHeadSha !== undefined && installedSha !== cloneHeadSha;
  const layer1Status = args.marketplaceCloneStatus;

  if (commitsDiverged) {
    if (layer1Status === "stale") {
      // remoteCliVersion ≠ resolvedVersion → remote has a real bump (refresh-needed)
      // remoteCliVersion === resolvedVersion → remote and local clone agree; refresh
      //   alone won't help; bump-needed in disguise.
      if (args.remoteCliVersion !== undefined && args.remoteCliVersion !== resolved.version) {
        evidence.versionTrapKind = "refresh-needed" satisfies VersionTrapKind;
        return {
          plugin: id,
          layer: "install_snapshot",
          status: "stale",
          detail: [
            `Stale install — github has ${args.remoteCliVersion}, you have ${primary.version}`,
            `  installed       ${primary.version}  (commit ${installedSha?.slice(0, 7) ?? "(?)"})`,
            `  local clone     ${resolved.version}  (commit ${cloneHeadSha?.slice(0, 7) ?? "(?)"})`,
            `  github (remote) ${args.remoteCliVersion}`,
            "  fix             refresh marketplace + update plugin",
          ].join("\n"),
          evidence,
          recommendation: {
            action: `Refresh marketplace and update — github has ${args.remoteCliVersion}, you have ${primary.version}`,
            reason: `github plugin.json#version is ${args.remoteCliVersion}; local clone (and install) on ${primary.version}`,
            risk: "safe",
            cmd: `claude plugin marketplace update ${installed.marketplace} && claude plugin update ${id}`,
          },
        };
      }
      if (args.remoteCliVersion !== undefined && args.remoteCliVersion === resolved.version) {
        evidence.versionTrapKind = "bump-needed" satisfies VersionTrapKind;
        if (args.commitsBetween && args.commitsBetween.length > 0) {
          evidence.commitsBetween = args.commitsBetween;
          if (args.commitsBetweenTruncated === true) {
            evidence.commitsBetweenTruncated = true;
          }
        }
        const commitLines = formatCommitList(args.commitsBetween, args.commitsBetweenTruncated);
        return {
          plugin: id,
          layer: "install_snapshot",
          status: "stale",
          detail: [
            "Commits diverged but plugin.json#version unchanged — `claude plugin update` will be a no-op until the version bumps",
            `  installed       ${primary.version}  (commit ${installedSha?.slice(0, 7) ?? "(?)"})`,
            `  local clone     ${resolved.version}  (commit ${cloneHeadSha?.slice(0, 7) ?? "(?)"})`,
            `  github (remote) ${args.remoteCliVersion}  (same as local clone — refresh alone won't help)`,
            ...commitLines,
            "  fix             bump plugin.json#version in the source repo and republish, OR (if the new commits are docs/CI-only) ignore",
          ].join("\n"),
          evidence,
          recommendation: {
            action: "Bump plugin.json#version in the source repo, push, then refresh and update",
            reason:
              "remote and local clone both report the same version; only a version bump on remote will trigger the update",
            risk: "safe",
            cmd: `(cd <plugin-source> && <bump plugin.json#version> && git commit -am 'bump version' && git push) && claude plugin marketplace update ${installed.marketplace} && claude plugin update ${id}`,
          },
        };
      }
      // No remote info — fall back to refresh-needed advice (the simpler chain).
      evidence.versionTrapKind = "refresh-needed" satisfies VersionTrapKind;
      return {
        plugin: id,
        layer: "install_snapshot",
        status: "stale",
        detail: [
          "Marketplace clone behind remote — refresh first",
          `  cause      installed ${primary.version} matches local clone, but remote has newer commits`,
          `  installed  commit ${installedSha?.slice(0, 7) ?? "(?)"}`,
          `  clone      commit ${cloneHeadSha?.slice(0, 7) ?? "(?)"}  (marketplace clone is behind remote — remote may carry a version bump)`,
          "  fix        refresh first; if version is now different, the standard update will resolve",
        ].join("\n"),
        evidence,
        recommendation: {
          action:
            "Refresh the marketplace clone first, then update the plugin (remote may carry a version bump)",
          reason: "marketplace clone is behind remote — remote may already have the bump",
          risk: "safe",
          cmd: `claude plugin marketplace update ${installed.marketplace} && claude plugin update ${id}`,
        },
      };
    }
    if (layer1Status === "fresh") {
      evidence.versionTrapKind = "bump-needed" satisfies VersionTrapKind;
      if (args.commitsBetween && args.commitsBetween.length > 0) {
        evidence.commitsBetween = args.commitsBetween;
        if (args.commitsBetweenTruncated === true) {
          evidence.commitsBetweenTruncated = true;
        }
      }
      // Optional catalog version line — surface marketplaceEntryVersion if
      // we have it, even when it agrees, so consumers can see that the
      // badge-only-needed rule-out actually happened.
      const catalogVersionLine =
        typeof evidence.marketplaceEntryVersion === "string"
          ? `  catalog    marketplace.json reports ${evidence.marketplaceEntryVersion} (matches plugin.json — not a badge-only mismatch)`
          : undefined;
      const commitLines = formatCommitList(args.commitsBetween, args.commitsBetweenTruncated);
      const detail = [
        "Commits diverged but plugin.json#version unchanged — `claude plugin update` will be a no-op until the version bumps",
        `  installed  commit ${installedSha?.slice(0, 7) ?? "(?)"}`,
        `  clone      commit ${cloneHeadSha?.slice(0, 7) ?? "(?)"}  (marketplace clone matches remote — refresh won't help)`,
        `  versions   both report ${resolved.version} from ${humanSourceLabel(resolved.source)}`,
        ...(catalogVersionLine !== undefined ? [catalogVersionLine] : []),
        ...commitLines,
        "  fix        bump plugin.json#version in the source repo and republish, OR (if the new commits are docs/CI-only) ignore",
      ];
      return {
        plugin: id,
        layer: "install_snapshot",
        status: "stale",
        detail: detail.join("\n"),
        evidence,
        recommendation: {
          action: "Bump plugin.json#version in the source repo, push, then refresh and update",
          reason: "commits diverged, version unchanged → CLI update is silently a no-op",
          risk: "safe",
          cmd: `(cd <plugin-source> && <bump plugin.json#version> && git commit -am 'bump version' && git push) && claude plugin marketplace update ${installed.marketplace} && claude plugin update ${id}`,
        },
      };
    }
    // Layer 1 unknowable (--no-network) or status missing.
    return {
      plugin: id,
      layer: "install_snapshot",
      status: "unknowable",
      detail: [
        "Cannot determine cause without network",
        "  cause      marketplace clone status is unknown (likely --no-network)",
        `  installed  commit ${installedSha?.slice(0, 7) ?? "(?)"}`,
        `  clone      commit ${cloneHeadSha?.slice(0, 7) ?? "(?)"}`,
        "  fix        re-run without --no-network to distinguish 'needs refresh' from 'needs version bump'",
      ].join("\n"),
      evidence,
    };
  }

  // No commit drift. For object-source plugins, check for badge-only-needed:
  // remote plugin.json#version differs from marketplace.json#plugins[].version.
  // String-source plugins can't have this trap (both surfaces read the same
  // file).
  const isObjectSource =
    entry.sourceKind === "github" ||
    entry.sourceKind === "git-subdir" ||
    entry.sourceKind === "url";
  if (
    isObjectSource &&
    args.remoteCliVersion !== undefined &&
    entry.version !== undefined &&
    args.remoteCliVersion !== entry.version
  ) {
    evidence.versionTrapKind = "badge-only-needed" satisfies VersionTrapKind;
    return {
      plugin: id,
      layer: "install_snapshot",
      status: "stale",
      detail: [
        "Badge-only-needed (Desktop UI surface stale, object-source plugin)",
        `  cause                      plugin.json#version on remote: ${args.remoteCliVersion}`,
        `                             marketplace.json#plugins[].version: ${entry.version}`,
        "  effect                     `claude plugin update` works (it fetches fresh)",
        "                             Desktop UI's update-available badge stays silent",
        "                             (it only sees marketplace.json's catalog entry)",
        "  fix                        bump marketplace.json#plugins[].version to match plugin.json",
      ].join("\n"),
      evidence,
      recommendation: {
        action:
          "Edit marketplace.json#plugins[].version to match plugin.json#version, commit and push",
        reason:
          "badge-only-needed: object-source plugin where remote plugin.json is ahead of the catalog entry",
        risk: "safe",
      },
    };
  }

  // Both surfaces fresh, no commit drift.
  evidence.versionTrapKind = null;
  return {
    plugin: id,
    layer: "install_snapshot",
    status: "fresh",
    detail: `Installed ${primary.version} matches ${humanSourceLabel(resolved.source)} (resolvedVersion=${resolved.version}).`,
    evidence,
  };
}

/** Format the precomputed commit-range list as detail-string continuation
 *  lines. Returns an empty array when no commits are provided, so the caller
 *  can spread it unconditionally. The leading 2-space indent matches the
 *  surrounding template lines (the renderer adds another 5 spaces). */
function formatCommitList(
  commits: { sha: string; subject: string }[] | undefined,
  truncated: boolean | undefined,
): string[] {
  if (!commits || commits.length === 0) return [];
  const header = `  new commits ${commits.length} commits in this plugin's subdir:`;
  const rows = commits.map((c) => `              ${c.sha}  ${c.subject}`);
  const tail = truncated ? ["              (+more — passed cap)"] : [];
  return [header, ...rows, ...tail];
}

function humanSourceLabel(source: ResolvedVersionSource): string {
  if (source === "plugin.json-in-clone") return "plugin.json";
  if (source === "remote-plugin.json") return "github";
  if (source === "marketplace.json") return "marketplace.json";
  return source;
}

// ── v1.0 Tier C typed snapshot ───────────────────────────────────────────────

export type InstallSnapshotArgs = {
  /** The installed plugin record from installed_plugins.json. */
  installed: InstalledPlugin;
  /** Which root this install record belongs to. */
  rootRef: RootRef;
  /**
   * Root where marketplace clones live — used to look up the plugin's entry
   * source kind from marketplace.json. Optional: if absent (or marketplace.json
   * not readable), pluginEntrySourceKind defaults to "clone-unreadable".
   */
  pluginsRoot?: string;
};

/**
 * Maps from tier B's UpstreamSource.kind to tier C's PluginEntrySourceKind.
 *
 * Tier C's union narrows tier B's: it preserves the source kinds cpd
 * actively probes (string, github, git-subdir, url, npm) and folds the
 * remaining tier-B variants into one of three failure modes whose
 * user-facing semantics differ:
 *   - "git" / "directory" / "backend" → "not-probed-by-cpd"
 *       (Claude Code supports these; cpd's per-plugin taxonomy doesn't.
 *        Silent at the source-advisory level — no "Upgrade Claude Code".)
 *   - "unrecognized" → "unrecognized-source-kind"
 *       (genuine futuristic discriminator → emit the upgrade advisory)
 *   - default → "unrecognized-source-kind"
 *       (defensive: a tier-B variant we haven't seen yet is treated as
 *        unrecognized so the user gets the upgrade hint rather than
 *        silent breakage)
 */
function mapSourceKind(upstreamKind: string): TierCPluginEntrySourceKind {
  switch (upstreamKind) {
    case "string":
      return "string";
    case "github":
      return "github";
    case "url":
      return "url";
    case "git-subdir":
      return "git-subdir";
    case "npm":
      return "npm";
    case "git":
    case "directory":
    case "backend":
      return "not-probed-by-cpd";
    case "unrecognized":
      return "unrecognized-source-kind";
    default:
      return "unrecognized-source-kind";
  }
}

/**
 * Reads the plugin entry's raw source from marketplace.json for the given
 * marketplace, returning { sourceRaw, sourceKind } or null on failure.
 */
function readPluginEntrySource(
  pluginsRoot: string,
  marketplaceName: string,
  pluginName: string,
): { sourceRaw: unknown; sourceKind: TierCPluginEntrySourceKind } | null {
  const marketplaceJsonPath = path.join(
    pluginsRoot,
    "marketplaces",
    marketplaceName,
    ".claude-plugin",
    "marketplace.json",
  );
  if (!fs.existsSync(marketplaceJsonPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(marketplaceJsonPath, "utf8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const plugins = (raw as Record<string, unknown>).plugins;
    if (!Array.isArray(plugins)) return null;
    for (const entry of plugins) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const e = entry as Record<string, unknown>;
      if (e.name === pluginName) {
        const sourceRaw = e.source ?? null;
        const parsed = parsePluginEntrySource(sourceRaw);
        return { sourceRaw, sourceKind: mapSourceKind(parsed.kind) };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Returns a typed `CacheSnapshot` for the install_snapshot layer.
 *
 * CRITICAL: This function returns the on-disk install state ONLY. No resolver
 * logic, no trap detection, no upstream probing. Just what's recorded in
 * `installed_plugins.json` + the install path's existence + the plugin entry's
 * source kind from marketplace.json. Resolver logic moves to tier D in phase 4.
 */
export function snapshotInstallSnapshot(args: InstallSnapshotArgs): CacheSnapshot {
  const { installed, rootRef, pluginsRoot } = args;
  const primary = preferredScope(installed);

  const installPath = primary.installPath;
  const installPathExists = fs.existsSync(installPath);

  const pluginRef: PluginRef = {
    pluginName: installed.pluginName,
    marketplace: installed.marketplace,
    root: rootRef,
  };

  // Determine source kind from marketplace.json if pluginsRoot is available.
  // When marketplace.json is unreadable / parse-fails / entry is missing, the
  // sourceKind defaults to "clone-unreadable" — the layer-1 marketplace_clone
  // trap is the canonical signal in that case.
  let pluginEntrySourceKind: TierCPluginEntrySourceKind = "clone-unreadable";
  let pluginEntryRaw: unknown = null;
  if (pluginsRoot) {
    const entry = readPluginEntrySource(pluginsRoot, installed.marketplace, installed.pluginName);
    if (entry) {
      pluginEntrySourceKind = entry.sourceKind;
      pluginEntryRaw = entry.sourceRaw;
    }
  }

  const presence = installPathExists ? "present" : "absent";
  const evidencePaths: string[] = [installPath];

  const data: InstallSnapshotData = {
    kind: "install_snapshot",
    pluginRef,
    installPath,
    installPathExists,
    scopes: installed.scopes,
    pluginEntrySourceKind,
    pluginEntryRaw,
  };

  return {
    layer: "install_snapshot",
    rootRef,
    subject: { kind: "plugin", ref: pluginRef },
    presence,
    evidencePaths,
    parsedAt: new Date().toISOString(),
    data,
  };
}
