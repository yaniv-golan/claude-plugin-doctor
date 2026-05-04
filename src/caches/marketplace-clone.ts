import * as fs from "node:fs";
import * as path from "node:path";
import { gitLsRemote, gitRevParseHead, isGitRepo } from "../git.js";
import type { KnownMarketplace } from "../known-marketplaces.js";
import { shellQuote } from "../output/cmd-format.js";
import type {
  CacheSnapshot,
  CheckResult,
  MarketplaceCloneData,
  MarketplaceRef,
  RootRef,
} from "../types.js";

export type CheckArgs = {
  pluginsRoot: string;
  marketplace: KnownMarketplace;
  noNetwork: boolean;
};

function repoUrlForGithub(repo: string): string {
  return `https://github.com/${repo}.git`;
}

function repoUrlForGit(source: Record<string, unknown>): string | undefined {
  // SCHEMA-NOTE: zod schema is loose; the gist documents this as `url` for git source.
  const url = source.url ?? source.repo;
  return typeof url === "string" ? url : undefined;
}

export async function checkMarketplaceClone(args: CheckArgs): Promise<CheckResult> {
  const { pluginsRoot, marketplace, noNetwork } = args;
  const cloneDir = path.join(pluginsRoot, "marketplaces", marketplace.name);
  const evidence: Record<string, unknown> = {
    cloneDir,
    sourceType: marketplace.source.source,
  };

  if (!fs.existsSync(cloneDir)) {
    return {
      plugin: "",
      layer: "marketplace_clone",
      status: "missing",
      detail: `Marketplace "${marketplace.name}" registered but clone missing on disk.`,
      evidence,
      recommendation: {
        action: "Re-add the marketplace",
        reason: "clone missing — likely auth failure on add or partial install",
        risk: "safe",
        cmd: `claude plugin marketplace remove ${shellQuote(marketplace.name)} && claude plugin marketplace add <source>`,
      },
    };
  }

  const marketplaceJsonPath = path.join(cloneDir, ".claude-plugin", "marketplace.json");
  if (!fs.existsSync(marketplaceJsonPath)) {
    return {
      plugin: "",
      layer: "marketplace_clone",
      status: "missing",
      detail: "Clone dir exists but .claude-plugin/marketplace.json is absent.",
      evidence: { ...evidence, marketplaceJsonPath },
      recommendation: {
        action: `claude plugin marketplace update ${shellQuote(marketplace.name)}`,
        reason: "marketplace.json missing — re-pulling may restore it",
        risk: "safe",
        cmd: `claude plugin marketplace update ${shellQuote(marketplace.name)}`,
      },
    };
  }

  const sourceType = marketplace.source.source;

  if (sourceType === "github" || sourceType === "git") {
    // Build the `claude plugin marketplace add <arg>` argument from the
    // source object. Used by the not-a-repo / corrupt recovery paths.
    let addArg = "<source-url>";
    if (sourceType === "github") {
      const repo = (marketplace.source as { repo?: unknown }).repo;
      if (typeof repo === "string") addArg = `github:${repo}`;
    } else {
      const url = repoUrlForGit(marketplace.source as Record<string, unknown>);
      if (url) addArg = `git:${url}`;
    }

    const dirIsGitRepo = isGitRepo(cloneDir);
    const headLocal = gitRevParseHead(cloneDir);
    evidence.headLocal = headLocal;

    if (!dirIsGitRepo) {
      // Case γ.A — directory exists but `.git/` is missing entirely. Most
      // likely an interrupted install or a manually-edited dir. There's no
      // safe non-destructive fix: `claude plugin marketplace remove` will
      // unregister all plugins installed from this marketplace, but it's
      // the only way to get the install back into a known state.
      return {
        plugin: "",
        layer: "marketplace_clone",
        status: "stale",
        detail: `Source type is ${sourceType} but ${cloneDir} is not a git repo (.git/ missing).`,
        evidence: { ...evidence, versionTrapKind: "marketplace-clone-not-a-repo", addArg },
        recommendation: {
          action:
            "Reinstall the marketplace (destructive — removes all plugins installed from it).",
          reason: ".git/ missing; clone is not recoverable in place.",
          risk: "destructive",
          cmd: `claude plugin marketplace remove ${shellQuote(marketplace.name)} && claude plugin marketplace add ${shellQuote(addArg)}`,
        },
      };
    }

    if (headLocal === null) {
      // Case γ.B — `.git/` exists but `git rev-parse HEAD` failed. The repo
      // is corrupt: index corruption, broken pack files, or detached-HEAD
      // pointing to a missing object. The first-line response is `git fsck`
      // / `git repack` (non-destructive). Only if those fail should the
      // user fall back to remove+re-add (destructive).
      return {
        plugin: "",
        layer: "marketplace_clone",
        status: "stale",
        detail: `Source type is ${sourceType}, .git/ exists, but \`git rev-parse HEAD\` failed (corrupt repo).`,
        evidence: { ...evidence, versionTrapKind: "marketplace-clone-corrupt", addArg, cloneDir },
        recommendation: {
          action: "Run git fsck/repack first; fall back to remove+re-add only if unrecoverable.",
          reason: "repo metadata corrupt — try non-destructive recovery before reinstalling",
          risk: "safe",
          cmd: "git -C <clone-dir> fsck --full && git -C <clone-dir> repack -a -d",
        },
      };
    }

    if (noNetwork) {
      return {
        plugin: "",
        layer: "marketplace_clone",
        status: "unknowable",
        detail: "--no-network set; cannot compare local HEAD with remote.",
        evidence,
      };
    }

    let remoteUrl: string | undefined;
    if (sourceType === "github") {
      const repo = (marketplace.source as { repo?: unknown }).repo;
      if (typeof repo === "string") remoteUrl = repoUrlForGithub(repo);
    } else {
      remoteUrl = repoUrlForGit(marketplace.source as Record<string, unknown>);
    }
    if (!remoteUrl) {
      return {
        plugin: "",
        layer: "marketplace_clone",
        status: "unknowable",
        detail: `Source ${sourceType} has no recognizable repo URL field.`,
        evidence,
      };
    }
    evidence.remoteUrl = remoteUrl;

    const ls = await gitLsRemote(remoteUrl);
    if (!ls.ok) {
      return {
        plugin: "",
        layer: "marketplace_clone",
        status: "unknowable",
        detail: `git ls-remote failed: ${ls.error}`,
        evidence,
      };
    }
    evidence.headRemote = ls.defaultBranchSha;

    if (!ls.defaultBranchSha) {
      return {
        plugin: "",
        layer: "marketplace_clone",
        status: "unknowable",
        detail: "Remote returned no HEAD/main/master ref.",
        evidence,
      };
    }
    if (headLocal && headLocal === ls.defaultBranchSha) {
      return {
        plugin: "",
        layer: "marketplace_clone",
        status: "fresh",
        detail: `Local clone matches remote HEAD (${ls.defaultBranchSha.slice(0, 7)}).`,
        evidence,
      };
    }

    // marketplace-update-broken detection (v0.5, gist item #13). When
    // `known_marketplaces.json#lastUpdated` is recent but the clone HEAD
    // didn't actually advance, the user just ran `claude plugin marketplace
    // update` and Desktop's IPC handler claimed success without fetching.
    // The fix is `git fetch && git reset --hard origin/<branch>` (cpd
    // exposes this as `cpd refresh --force-fetch <mp>` in v0.5).
    const lastUpdated = (marketplace.raw as { lastUpdated?: unknown }).lastUpdated;
    let lastUpdatedDate: Date | undefined;
    if (typeof lastUpdated === "string") {
      const d = new Date(lastUpdated);
      if (!Number.isNaN(d.getTime())) {
        lastUpdatedDate = d;
        evidence.lastUpdated = lastUpdated;
      }
    } else if (typeof lastUpdated === "number") {
      const d = new Date(lastUpdated);
      if (!Number.isNaN(d.getTime())) {
        lastUpdatedDate = d;
        evidence.lastUpdated = d.toISOString();
      }
    }
    const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    const isRecent =
      lastUpdatedDate !== undefined && Date.now() - lastUpdatedDate.getTime() < RECENT_WINDOW_MS;
    if (isRecent && lastUpdatedDate) {
      const ageDays = Math.floor((Date.now() - lastUpdatedDate.getTime()) / (24 * 60 * 60 * 1000));
      evidence.versionTrapKind = "marketplace-update-broken";
      return {
        plugin: "",
        layer: "marketplace_clone",
        status: "stale",
        detail: [
          "Marketplace update is broken (claims success without advancing HEAD)",
          `  cause       claude plugin marketplace update ran ${ageDays === 0 ? "today" : `${ageDays}d ago`} (${lastUpdated}); local clone HEAD did not advance`,
          `  installed   commit ${headLocal?.slice(0, 7) ?? "?"} (local clone)`,
          `  remote      commit ${ls.defaultBranchSha.slice(0, 7)} (github HEAD)`,
          "  fix         bypass the broken CLI update with direct git fetch + reset",
        ].join("\n"),
        evidence,
        recommendation: {
          action: `Bypass the broken marketplace update with: cd ${shellQuote(cloneDir)} && git fetch origin && git reset --hard origin/$(git rev-parse --abbrev-ref origin/HEAD | sed 's@^origin/@@')`,
          reason:
            "marketplace-update-broken: known Anthropic issue #46081 (silent-cooldown / stale-cache absorbed)",
          risk: "destructive",
          cmd: `(cd ${shellQuote(cloneDir)} && BRANCH=$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's@^origin/@@') && git fetch origin && git reset --hard origin/$BRANCH)`,
        },
      };
    }

    return {
      plugin: "",
      layer: "marketplace_clone",
      status: "stale",
      detail: `Local HEAD ${headLocal?.slice(0, 7) ?? "?"} differs from remote ${ls.defaultBranchSha.slice(0, 7)}.`,
      evidence,
      recommendation: {
        action: `claude plugin marketplace update ${shellQuote(marketplace.name)}`,
        reason: "local clone behind remote",
        risk: "safe",
        cmd: `claude plugin marketplace update ${shellQuote(marketplace.name)}`,
      },
    };
  }

  if (sourceType === "directory") {
    const srcPath = (marketplace.source as { path?: unknown }).path;
    if (typeof srcPath !== "string") {
      return {
        plugin: "",
        layer: "marketplace_clone",
        status: "stale",
        detail: "directory source has no 'path' field.",
        evidence,
      };
    }
    if (!fs.existsSync(srcPath)) {
      return {
        plugin: "",
        layer: "marketplace_clone",
        status: "missing",
        detail: `directory source path ${srcPath} does not exist.`,
        evidence: { ...evidence, srcPath },
      };
    }
    return {
      plugin: "",
      layer: "marketplace_clone",
      status: "fresh",
      detail: `directory source present at ${srcPath}.`,
      evidence: { ...evidence, srcPath },
    };
  }

  if (sourceType === "remote") {
    return {
      plugin: "",
      layer: "marketplace_clone",
      status: "unknowable",
      detail:
        "Remote-source marketplace — local fingerprinting is not implemented yet (the backend marketplace catalog is the source of truth for these).",
      evidence,
    };
  }

  return {
    plugin: "",
    layer: "marketplace_clone",
    status: "unknowable",
    detail: `Unknown source type "${sourceType}".`,
    evidence,
  };
}

// ── v1.0 Tier C typed snapshot ───────────────────────────────────────────────

export type MarketplaceCloneSnapshotArgs = {
  /** Root where marketplace clones live (e.g. ~/.claude/plugins). */
  pluginsRoot: string;
  /** Marketplace name and source info from known_marketplaces. */
  marketplace: KnownMarketplace;
  /** Optional lastUpdated timestamp from the KnownMarketplaceEntry (ms epoch). */
  lastUpdatedAtMs?: number;
  /** Which root this snapshot belongs to (CCD or Cowork). */
  rootRef: RootRef;
};

/**
 * Returns a typed `CacheSnapshot` for the marketplace_clone layer.
 *
 * Pure file-system inspection — no network I/O. The caller is responsible for
 * providing `lastUpdatedAtMs` from tier A's `KnownMarketplaceEntry` if needed.
 *
 * This function does NOT run the v0.5 drift/trap classification — that logic
 * stays in `checkMarketplaceClone` (v0.5 path) and will move to tier E in
 * phase 5. This function only records what is on disk.
 */
export function snapshotMarketplaceClone(args: MarketplaceCloneSnapshotArgs): CacheSnapshot {
  const { pluginsRoot, marketplace, lastUpdatedAtMs, rootRef } = args;
  const cloneRoot = path.join(pluginsRoot, "marketplaces", marketplace.name);
  const marketplaceJsonPath = path.join(cloneRoot, ".claude-plugin", "marketplace.json");

  const cloneExists = fs.existsSync(cloneRoot);
  const marketplaceJsonExists = cloneExists && fs.existsSync(marketplaceJsonPath);

  const evidencePaths: string[] = [cloneRoot];
  if (marketplaceJsonExists) evidencePaths.push(marketplaceJsonPath);

  // Read headLocal from git if the clone exists (best-effort; undefined if not a git repo).
  let headLocal: string | undefined;
  if (cloneExists) {
    const h = gitRevParseHead(cloneRoot);
    if (h) headLocal = h;
  }

  // Parse marketplace.json if present (minimal projection for tier E).
  let parsedMarketplace: MarketplaceCloneData["parsedMarketplace"];
  if (marketplaceJsonExists) {
    try {
      const raw = JSON.parse(fs.readFileSync(marketplaceJsonPath, "utf8")) as Record<
        string,
        unknown
      >;
      const rawPlugins = Array.isArray(raw.plugins) ? (raw.plugins as unknown[]) : [];
      const plugins = rawPlugins
        .filter((p) => p !== null && typeof p === "object" && !Array.isArray(p))
        .map((p) => {
          const entry = p as Record<string, unknown>;
          return {
            name: typeof entry.name === "string" ? entry.name : "",
            sourceRaw: entry.source ?? null,
            ...(typeof entry.version === "string" ? { version: entry.version } : {}),
          };
        })
        .filter((p) => p.name !== "");
      parsedMarketplace = { plugins, raw };
    } catch {
      // Parse error — leave parsedMarketplace undefined; tier E will detect absence.
    }
  }

  const presence = marketplaceJsonExists ? "present" : "absent";

  const data: MarketplaceCloneData = {
    kind: "marketplace_clone",
    marketplace: marketplace.name,
    cloneRoot,
    marketplaceJsonPath,
    marketplaceJsonExists,
    ...(parsedMarketplace !== undefined ? { parsedMarketplace } : {}),
    ...(headLocal !== undefined ? { headLocal } : {}),
    ...(lastUpdatedAtMs !== undefined ? { lastUpdatedAtMs } : {}),
  };

  const marketplaceRef: MarketplaceRef = { marketplace: marketplace.name, root: rootRef };

  return {
    layer: "marketplace_clone",
    rootRef,
    subject: { kind: "marketplace", ref: marketplaceRef },
    presence,
    evidencePaths,
    parsedAt: new Date().toISOString(),
    data,
  };
}
