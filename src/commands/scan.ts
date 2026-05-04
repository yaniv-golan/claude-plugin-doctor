/**
 * `cpd scan` — v1.0 implementation.
 *
 * Orchestrates tiers A-F in order:
 *   A → discoverTopology
 *   B → probeUpstreams (per-marketplace and per-plugin upstream sources)
 *   C → snapshotCaches (marketplace_clone, install_snapshot, cowork_mirror, rpm_copy, skills_plugin)
 *   D → simulateResolvers (cli-update, desktop-badge, session-start per plugin)
 *   E → composeDrift
 *   F → planRecommendations
 *
 * Also exports runV05Scan for the v0.5-compatible commands (list, refresh, watch, check).
 * Those commands still need MarketplaceReport / PluginReport / RpmReport from the
 * v0.5 layer functions — they're preserved for those use cases.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { checkCcdRemoteSsh } from "../caches/ccd-remote-ssh.js";
import { checkCoworkMirror, snapshotCoworkMirror } from "../caches/cowork-mirror.js";
import {
  checkInstallSnapshot,
  readPluginSubdir,
  snapshotInstallSnapshot,
} from "../caches/install-snapshot.js";
import { checkMarketplaceClone, snapshotMarketplaceClone } from "../caches/marketplace-clone.js";
import { checkRpmCopy, snapshotRpmCopy } from "../caches/rpm-copy.js";
import { BUILTIN_SKILLS, snapshotSkillsPluginPair } from "../caches/skills-plugin.js";
import { pLimited } from "../concurrency.js";
import { discoverTopology } from "../discovery/topology.js";
import { composeDrift } from "../drift/compose.js";
import { gitLogBetween } from "../git.js";
import {
  type InstalledPlugin,
  parseInstalledPlugins,
  preferredScope,
} from "../installed-plugins.js";
import { parseKnownMarketplaces } from "../known-marketplaces.js";
import { Logger } from "../logger.js";
import {
  coworkPluginsRootFor,
  enumerateCoworkRoots,
  resolveCcdPluginsRoot,
  resolveUserDataDir,
  rpmRootFor,
} from "../paths.js";
import { Progress } from "../progress.js";
import { planRecommendations } from "../recommendations/plan.js";
import {
  marketplaceRefKey,
  nowIso,
  pluginRefKey,
  rootRefKey as rootRefKeyOf,
  rpmKey,
} from "../refs.js";
import { buildRemoteSourceRef, fetchRemotePluginVersion, parseGithubUrl } from "../remote-fetch.js";
import { simulateCliUpdate } from "../resolvers/cli-update.js";
import { simulateDesktopBadge } from "../resolvers/desktop-badge.js";
import { simulateSessionStart } from "../resolvers/session-start.js";
import { parseRpmManifest, type RpmEntry } from "../rpm-manifest.js";
import { parsePluginEntrySource } from "../sources/source-kind.js";
import { probeUpstream } from "../sources/upstream.js";
import { readEvidence } from "../state/verify-in-ui-state.js";
import type {
  CacheSnapshot,
  CheckResult,
  CliUpdateInput,
  CliUpdateSim,
  CoworkRootInfo,
  DesktopBadgeSim,
  Layer,
  MarketplaceRef,
  MarketplaceRefKey,
  MarketplaceReport,
  Mode,
  PluginRef,
  PluginRefKey,
  PluginReport,
  RpmReport,
  ScanPhase,
  ScanReport,
  ScanSummary,
  SessionStartSim,
  Topology,
  UpstreamProbeResult,
} from "../types.js";

export type RunScanOpts = {
  home: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** "all" (default) walks every (mode, org, role) tuple. "auto" is an alias for "all".
   *  "ccd" or "cowork" forces a single-mode scan (backward-compat). */
  mode: "all" | "auto" | "ccd" | "cowork";
  noNetwork: boolean;
  coworkAccount?: string;
  coworkOrg?: string;
  /** Filter multi-root scan to a single cowork root. Only meaningful with mode "all". */
  rootFilter?: { accountId: string; orgId: string };
  /** Maximum parallel upstream probes (default: 8). */
  maxConcurrency?: number;
  logger?: Logger;
  progress?: Progress;
  /** Max age in days for UI evidence before flagging as stale (default: 7). */
  uiEvidenceMaxAgeDays?: number;
  /** When false, exclude the skills-plugin layer from the snapshot loop (--no-skills-plugin flag).
   *  Defaults to true (include). */
  includeSkillsPlugin?: boolean;
  /** When true, always show the runtime-boundary advisory section in human output,
   *  even when no changed surfaces are present (--show-runtime-boundary flag). */
  showRuntimeBoundary?: boolean;
  /** B1: When true, suppress the NDJSON scan_done event from this scan invocation.
   *  Used by the check command's fallback scan — only the primary scan emits the
   *  NDJSON scan_done event (one event per `cpd check` cli invocation). */
  silentNdjson?: boolean;
  /** B1: When true, suppress the human TTY done line from this scan invocation.
   *  The caller (e.g. runCheckCommand) is responsible for emitting a consolidated
   *  done line with check-appropriate formatting (no marketplace/plugin/stale counts). */
  suppressHumanDone?: boolean;
};

function nullLogger(): Logger {
  return new Logger({});
}

function nullProgress(): Progress {
  return new Progress({ enabled: false, isTty: false });
}

function emptyChecks(pluginId: string): Record<Layer, CheckResult> {
  const out = {} as Record<Layer, CheckResult>;
  const ALL_LAYERS_LIST: readonly Layer[] = [
    "marketplace_clone",
    "install_snapshot",
    "cowork_mirror",
    "rpm_copy",
    "ccd_remote_ssh",
  ];
  for (const layer of ALL_LAYERS_LIST) {
    out[layer] = {
      plugin: pluginId,
      layer,
      status: "skipped",
      detail: "not run",
      evidence: { kind: "not-run" },
    };
  }
  return out;
}

function pickActiveCoworkRoot(
  roots: CoworkRootInfo[],
  forcedAccount?: string,
  forcedOrg?: string,
): CoworkRootInfo | undefined {
  if (forcedAccount && forcedOrg) {
    return roots.find((r) => r.accountId === forcedAccount && r.orgId === forcedOrg);
  }
  let best: CoworkRootInfo | undefined;
  for (const r of roots) {
    if (r.installedPluginsMtime === undefined) continue;
    if (!best || (best.installedPluginsMtime ?? 0) < r.installedPluginsMtime) best = r;
  }
  return best ?? roots[0];
}

function detectMode(
  optsMode: RunScanOpts["mode"],
  ccdMtime: number | undefined,
  coworkMtime: number | undefined,
): Mode {
  if (optsMode === "ccd") return "ccd";
  if (optsMode === "cowork") return "cowork";
  if (coworkMtime === undefined) return "ccd";
  if (ccdMtime === undefined) return "cowork";
  return coworkMtime > ccdMtime ? "cowork" : "ccd";
}

// ── ScanSummary derivation ──────────────────────────────────────────────────
//
// Per-layer roll-up of the inventory observed during the scan. Counts come
// from the snapshot maps (one entry per subject per layer); fresh/stale/etc.
// classification is conservative — a subject is "stale" only when at least
// one drift names it. Refinement (more granular taxonomy per drift kind) is
// a v0.2 follow-up; the wire shape is locked in 0.1.
function emptyLayerSummary(): import("../types.js").LayerSummary {
  return { count: 0, fresh: 0, stale: 0, missing: 0, skipped: 0, unknowable: 0 };
}

function deriveScanSummary(
  caches: Record<PluginRefKey, import("../types.js").CacheSnapshot[]>,
  marketplaceCaches: Record<MarketplaceRefKey, import("../types.js").CacheSnapshot[]>,
  rpmCaches: Record<string, import("../types.js").CacheSnapshot[]>,
  drifts: import("../types.js").Drift[],
  upstreams: Record<PluginRefKey | MarketplaceRefKey, import("../types.js").UpstreamProbeResult>,
): ScanSummary {
  // Upstream probe results determine whether a snapshot's freshness can be
  // verified. When `--no-network` blocks the probe (status "no-network") or
  // the source is unprobable (status "unknowable"), counting the snapshot as
  // "fresh" would overstate certainty. Mark these `unknowable` instead.
  const isUnknowableStatus = (s?: string): boolean => s === "no-network" || s === "unknowable";
  const perLayer: Record<Layer, import("../types.js").LayerSummary> = {
    marketplace_clone: emptyLayerSummary(),
    install_snapshot: emptyLayerSummary(),
    cowork_mirror: emptyLayerSummary(),
    rpm_copy: emptyLayerSummary(),
    ccd_remote_ssh: emptyLayerSummary(),
  };

  // Subject keys that have at least one drift, per layer. A drift indicates
  // the subject is not "fresh" at that layer; we mark it "stale" rather than
  // attempting per-drift-kind layer attribution (deferred).
  const driftedByLayer: Record<Layer, Set<string>> = {
    marketplace_clone: new Set(),
    install_snapshot: new Set(),
    cowork_mirror: new Set(),
    rpm_copy: new Set(),
    ccd_remote_ssh: new Set(),
  };
  for (const d of drifts) {
    // Map drift to a ROOT-AWARE string key. Without the root component, a
    // drift in CCD would mark the same plugin/marketplace stale in Cowork
    // (and vice versa). Use pluginRefKey/marketplaceRefKey directly so both
    // the drift side and the snapshot side speak the same key space.
    // RegistrationDrift carries `scope`+`name`+`presentIn[]`+`absentIn[]`
    // instead of a single subject; emit one key per affected root so the
    // attribution stays root-precise.
    const subjKeys: string[] = [];
    if (d.kind === "registration-drift") {
      const roots = [...d.presentIn, ...d.absentIn];
      for (const root of roots) {
        if (d.scope === "plugin") {
          subjKeys.push(`plugin:${d.name}@${d.marketplace ?? ""}#${rootRefKeyOf(root)}`);
        } else {
          subjKeys.push(`mp:${d.name}#${rootRefKeyOf(root)}`);
        }
      }
    } else {
      const subj = d.subject;
      switch (subj.kind) {
        case "plugin":
          subjKeys.push(`plugin:${pluginRefKey(subj.ref)}`);
          break;
        case "marketplace":
          subjKeys.push(`mp:${marketplaceRefKey(subj.ref)}`);
          break;
        case "root":
          subjKeys.push(`root:${rootRefKeyOf(subj.ref)}`);
          break;
      }
    }
    // Best-effort layer attribution by drift kind. Keep conservative — when
    // unsure, attribute to install_snapshot (the most common drift surface).
    const layer: Layer =
      d.kind === "marketplace-update-broken" || d.kind === "registration-drift"
        ? "marketplace_clone"
        : d.kind === "session-bloat-cleanup-eligible"
          ? "cowork_mirror"
          : "install_snapshot";
    for (const k of subjKeys) driftedByLayer[layer].add(k);
  }

  const tallySnapshot = (
    snap: import("../types.js").CacheSnapshot,
    subjKey: string,
    upstreamKey: string | undefined,
  ): void => {
    // skills_plugin is not in the Layer union exposed in `ScanSummary`; fold
    // under install_snapshot for summary purposes (skills-plugin pairs are a
    // sub-component of install state).
    const layer: Layer = snap.layer === "skills_plugin" ? "install_snapshot" : snap.layer;
    const bucket = perLayer[layer];
    bucket.count++;
    if (snap.presence === "absent") {
      bucket.missing++;
      return;
    }
    if (snap.presence === "n/a-for-source") {
      bucket.skipped++;
      return;
    }
    if (driftedByLayer[layer].has(subjKey)) {
      bucket.stale++;
      return;
    }
    // No drift attached. Decide between `fresh` and `unknowable` based on
    // whether the upstream probe could actually verify freshness. Only the
    // marketplace_clone and install_snapshot layers have an upstream probe;
    // the others (cowork_mirror, rpm_copy, ccd_remote_ssh) don't depend on
    // network state in current implementations.
    if (upstreamKey !== undefined) {
      const probe = upstreams[upstreamKey];
      if (probe && isUnknowableStatus(probe.status)) {
        bucket.unknowable++;
        return;
      }
    }
    bucket.fresh++;
  };

  // Snapshot-side keys are full (root-aware) `pluginRefKey` / `marketplaceRefKey`
  // strings. Use them verbatim so they match the drift side built above.
  for (const [pluginKey, snaps] of Object.entries(caches)) {
    const subj = `plugin:${pluginKey}`;
    for (const snap of snaps) tallySnapshot(snap, subj, pluginKey);
  }
  for (const [mpKey, snaps] of Object.entries(marketplaceCaches)) {
    const subj = `mp:${mpKey}`;
    for (const snap of snaps) tallySnapshot(snap, subj, mpKey);
  }
  for (const [rpmK, snaps] of Object.entries(rpmCaches)) {
    // rpm_copy doesn't have a network-bound freshness probe; pass undefined
    // so the tally never marks rpm snapshots `unknowable` for that reason.
    for (const snap of snaps) tallySnapshot(snap, `rpm:${rpmK}`, undefined);
  }

  return { perLayer };
}

// ── v1.0 ScanReport builder ──────────────────────────────────────────────────

/**
 * Run the per-root pipeline for a single plugins-root (CCD or one Cowork root).
 * Returns per-root artefacts that are merged into the aggregate ScanReport.
 */
async function runRootPipeline(opts: {
  activePluginsRoot: string;
  activeRootRef: import("../types.js").RootRef;
  allCoworkRoots: CoworkRootInfo[];
  activeCw: CoworkRootInfo | undefined;
  noNetwork: boolean;
  maxConcurrency: number;
  upstreams: Record<PluginRefKey | MarketplaceRefKey, UpstreamProbeResult>;
  marketplaceCaches: Record<MarketplaceRefKey, CacheSnapshot[]>;
  caches: Record<PluginRefKey, CacheSnapshot[]>;
  rpmCaches: Record<string, CacheSnapshot[]>;
  resolvers: Record<
    PluginRefKey,
    { cli: CliUpdateSim; badge: DesktopBadgeSim; sessionStart: SessionStartSim }
  >;
  logger: Logger;
  progress: Progress;
}): Promise<{ knownMpCount: number; installedPluginCount: number }> {
  const {
    activePluginsRoot,
    activeRootRef,
    allCoworkRoots,
    activeCw,
    noNetwork,
    maxConcurrency,
    upstreams,
    marketplaceCaches,
    caches,
    rpmCaches,
    resolvers,
    logger,
    progress,
  } = opts;

  // Determine mode from the rootRef (used for cowork_mirror snapshots).
  const isCoworkRoot = activeRootRef.kind === "cowork";

  const knownMps = parseKnownMarketplaces(path.join(activePluginsRoot, "known_marketplaces.json"));
  logger.debug("known_marketplaces_parsed", {
    root: activeRootRef.kind,
    count: knownMps.marketplaces.length,
  });

  const installed = parseInstalledPlugins(path.join(activePluginsRoot, "installed_plugins.json"));
  logger.debug("installed_plugins_parsed", {
    root: activeRootRef.kind,
    count: installed.plugins.length,
    fileVersion: installed.fileVersion,
  });
  if (installed.unknownFileVersion) {
    logger.warn("unknown_installed_plugins_file_version", {
      fileVersion: installed.fileVersion,
    });
  }

  // RPM manifest (cowork roots only).
  let rpmRoot: string | undefined;
  let rpmManifestEntries: RpmEntry[] = [];
  if (isCoworkRoot && activeCw) {
    rpmRoot = rpmRootFor(activeCw);
    const manifest = parseRpmManifest(path.join(rpmRoot, "manifest.json"));
    rpmManifestEntries = manifest.entries;
    logger.debug("rpm_manifest_parsed", { count: rpmManifestEntries.length });
  }

  // Track clone data keyed by marketplace name for resolver building.
  const cloneDataByMp = new Map<string, import("../types.js").MarketplaceCloneData>();

  // ── Tier B + C: Upstream probes + marketplace clone snapshots ─────────────
  let mpDone = 0;
  const mpTotal = knownMps.marketplaces.length;
  await pLimited(knownMps.marketplaces, maxConcurrency, async (mp) => {
    const mpRef: MarketplaceRef = { marketplace: mp.name, root: activeRootRef };
    const mpKey = marketplaceRefKey(mpRef);

    const lastUpdatedAtMs = typeof mp.raw.lastUpdated === "number" ? mp.raw.lastUpdated : undefined;
    const cloneSnap = snapshotMarketplaceClone({
      pluginsRoot: activePluginsRoot,
      marketplace: mp,
      rootRef: activeRootRef,
      ...(lastUpdatedAtMs !== undefined ? { lastUpdatedAtMs } : {}),
    });
    marketplaceCaches[mpKey] = [cloneSnap];
    if (cloneSnap.layer === "marketplace_clone") {
      cloneDataByMp.set(mp.name, cloneSnap.data);
    }

    const upstreamSource = parsePluginEntrySource(mp.source as unknown);
    const probeT0 = Date.now();
    const probeResult = await probeUpstream(upstreamSource, {
      network: !noNetwork,
      timeoutMs: 15000,
    });
    upstreams[mpKey] = probeResult;
    // upstream_probe structured log record (§10.4.4)
    logger.info("upstream_probe", {
      runId: logger.getRunId(),
      subject: mpKey,
      source: upstreamSource.kind,
      status: probeResult.status,
      durationMs: Date.now() - probeT0,
    });
    // cache_snapshot per marketplace clone (§10.4.4)
    logger.debug("cache_snapshot", {
      runId: logger.getRunId(),
      layer: cloneSnap.layer,
      subject: mpKey,
      presence: cloneSnap.presence,
    });

    mpDone++;
    progress.update("probe_upstreams", mpDone, mpTotal, mp.name);
  });

  // ── Tier C: install_snapshot, cowork_mirror, rpm_copy ────────────────────
  const snapTotal = installed.plugins.length + rpmManifestEntries.length;
  let snapIdx = 0;
  for (const ip of installed.plugins) {
    progress.update("snapshot_caches", ++snapIdx, snapTotal, ip.id);
    const pluginRef: PluginRef = {
      pluginName: ip.pluginName,
      marketplace: ip.marketplace,
      root: activeRootRef,
    };
    const pkKey = pluginRefKey(pluginRef);
    const snapshots: CacheSnapshot[] = [];

    const installSnap = snapshotInstallSnapshot({
      installed: ip,
      rootRef: activeRootRef,
      pluginsRoot: activePluginsRoot,
    });
    snapshots.push(installSnap);
    logger.debug("cache_snapshot", {
      layer: installSnap.layer,
      subject: pkKey,
      presence: installSnap.presence,
    });

    if (isCoworkRoot) {
      for (const cw of allCoworkRoots) {
        const cwSnap = snapshotCoworkMirror({
          cowork: { accountId: cw.accountId, orgId: cw.orgId, rootPath: cw.path },
          pluginId: ip.id,
        });
        snapshots.push(cwSnap);
        logger.debug("cache_snapshot", {
          layer: cwSnap.layer,
          subject: pkKey,
          presence: cwSnap.presence,
        });
      }
    }

    caches[pkKey] = snapshots;
  }

  if (rpmRoot && activeCw) {
    for (const e of rpmManifestEntries) {
      progress.update("snapshot_caches", ++snapIdx, snapTotal, e.pluginId);
      const rpmSnap = snapshotRpmCopy({
        rpmRoot,
        entry: e,
        cowork: { accountId: activeCw.accountId, orgId: activeCw.orgId },
      });
      const key = rpmKey(activeRootRef, e.pluginId);
      rpmCaches[key] = [rpmSnap];
      logger.debug("cache_snapshot", {
        layer: rpmSnap.layer,
        subject: e.pluginId,
        presence: rpmSnap.presence,
      });
    }
  }

  // ── Tier B: Plugin-level remote plugin.json fetch ────────────────────────
  const remoteCliVersionByPlugin = new Map<string, string>();
  if (!noNetwork) {
    const entryByPlugin = new Map<string, { name: string; source?: string; path?: string }>();
    for (const ip of installed.plugins) {
      const mpPath = path.join(
        activePluginsRoot,
        "marketplaces",
        ip.marketplace,
        ".claude-plugin",
        "marketplace.json",
      );
      if (!fs.existsSync(mpPath)) continue;
      try {
        const json = JSON.parse(fs.readFileSync(mpPath, "utf8")) as {
          plugins?: { name: string; source?: unknown; path?: string }[];
        };
        const entry = json.plugins?.find((p) => p.name === ip.pluginName);
        if (!entry) continue;
        let source: string | undefined;
        if (typeof entry.source === "string") source = entry.source;
        else if (entry.source && typeof entry.source === "object") {
          const s = entry.source as { path?: unknown };
          if (typeof s.path === "string") source = s.path;
        }
        entryByPlugin.set(ip.id, {
          name: entry.name,
          ...(source !== undefined ? { source } : {}),
          ...(entry.path !== undefined ? { path: entry.path } : {}),
        });
      } catch {
        // skip
      }
    }

    const remoteUrlByMarketplace = new Map<string, string>();
    const remoteHeadByMarketplace = new Map<string, string>();
    for (const mp of knownMps.marketplaces) {
      const mpRef: MarketplaceRef = { marketplace: mp.name, root: activeRootRef };
      const mpKey = marketplaceRefKey(mpRef);
      const probe = upstreams[mpKey];
      if (probe && probe.status === "fresh") {
        remoteHeadByMarketplace.set(mp.name, probe.head);
        if (mp.source.source === "github" && typeof mp.source.repo === "string") {
          remoteUrlByMarketplace.set(mp.name, `https://github.com/${mp.source.repo}.git`);
        } else if (mp.source.source === "git" && typeof mp.source.url === "string") {
          remoteUrlByMarketplace.set(mp.name, mp.source.url as string);
        }
      }
    }

    let fIdx = 0;
    await pLimited(installed.plugins, maxConcurrency, async (ip) => {
      const remoteUrl = remoteUrlByMarketplace.get(ip.marketplace);
      const remoteHead = remoteHeadByMarketplace.get(ip.marketplace);
      const entry = entryByPlugin.get(ip.id);
      fIdx++;
      progress.update("fetch_remote_versions", fIdx, installed.plugins.length, ip.id);
      if (!remoteUrl || !remoteHead || !entry || !parseGithubUrl(remoteUrl)) return;
      const ref = buildRemoteSourceRef({
        remoteUrl,
        ref: remoteHead,
        pluginSourcePath: entry.source ?? entry.path,
      });
      if (!ref) return;
      const result = await fetchRemotePluginVersion(ref);
      if (result.ok && result.version !== undefined) {
        remoteCliVersionByPlugin.set(ip.id, result.version);
        logger.debug("remote_version_fetched", { id: ip.id, version: result.version });
      } else if (!result.ok) {
        logger.debug("remote_version_fetch_failed", { id: ip.id, reason: result.reason });
      }
    });
  }

  // ── Tier D: Resolver simulation ───────────────────────────────────────────
  for (const ip of installed.plugins) {
    const pluginRef: PluginRef = {
      pluginName: ip.pluginName,
      marketplace: ip.marketplace,
      root: activeRootRef,
    };
    const pkKey = pluginRefKey(pluginRef);
    const cloneData = cloneDataByMp.get(ip.marketplace);

    let pluginEntry: CliUpdateInput["pluginEntry"] = { name: ip.pluginName, sourceRaw: null };
    let pluginJsonInClone: CliUpdateInput["pluginJsonInClone"] | undefined;
    // Default reflects the absent/unreadable case: cloneData.parsedMarketplace
    // missing OR plugin entry not found in the catalog → "clone-unreadable".
    // (The layer-1 marketplace_clone failure is the canonical signal here;
    //  per-plugin source-advisory stays silent.)
    let pluginEntrySourceKind: import("../types.js").PluginEntrySourceKind = "clone-unreadable";

    if (cloneData?.parsedMarketplace) {
      const mpEntry = cloneData.parsedMarketplace.plugins.find((p) => p.name === ip.pluginName);
      if (mpEntry) {
        const parsed = parsePluginEntrySource(mpEntry.sourceRaw);
        switch (parsed.kind) {
          case "string":
            pluginEntrySourceKind = "string";
            break;
          case "github":
            pluginEntrySourceKind = "github";
            break;
          case "git-subdir":
            pluginEntrySourceKind = "git-subdir";
            break;
          case "url":
            pluginEntrySourceKind = "url";
            break;
          case "npm":
            pluginEntrySourceKind = "npm";
            break;
          // tier-B kinds Claude Code recognizes but cpd doesn't yet probe.
          case "git":
          case "directory":
          case "backend":
            pluginEntrySourceKind = "not-probed-by-cpd";
            break;
          // Unknown discriminator value — the genuine "Upgrade Claude Code"
          // sentinel. Note that this is fundamentally distinct from the
          // default initialization above ("clone-unreadable"): here we
          // successfully read marketplace.json AND found the plugin entry,
          // so the underlying `source.source` field's discriminator just
          // isn't one we recognize.
          case "unrecognized":
            pluginEntrySourceKind = "unrecognized-source-kind";
            break;
        }
        pluginEntry = {
          name: mpEntry.name,
          sourceRaw: mpEntry.sourceRaw,
          ...(mpEntry.version !== undefined ? { versionInMarketplaceJson: mpEntry.version } : {}),
          ...(parsed.kind === "string" ? { sourcePath: parsed.path } : {}),
        };
        if (parsed.kind === "string" && cloneData.cloneRoot) {
          const pjPath = path.join(
            cloneData.cloneRoot,
            parsed.path,
            ".claude-plugin",
            "plugin.json",
          );
          if (fs.existsSync(pjPath)) {
            try {
              const pjRaw = JSON.parse(fs.readFileSync(pjPath, "utf8")) as Record<string, unknown>;
              const version = typeof pjRaw.version === "string" ? pjRaw.version : undefined;
              pluginJsonInClone = { ...(version !== undefined ? { version } : {}), raw: pjRaw };
            } catch {
              /* ignore */
            }
          }
        }
      }
    }

    const mpRef: MarketplaceRef = { marketplace: ip.marketplace, root: activeRootRef };
    const mpKey = marketplaceRefKey(mpRef);
    const upstreamResult = upstreams[mpKey] ?? {
      status: "unreachable" as const,
      reason: "no-probe",
    };
    const remotePluginJsonVersion = remoteCliVersionByPlugin.get(ip.id);

    const cli = simulateCliUpdate({
      pluginRef,
      pluginEntrySourceKind,
      ...(cloneData !== undefined ? { marketplaceClone: cloneData } : {}),
      pluginEntry,
      ...(pluginJsonInClone !== undefined ? { pluginJsonInClone } : {}),
      ...(remotePluginJsonVersion !== undefined ? { remotePluginJsonVersion } : {}),
      upstreamStatus: upstreamResult.status,
    });
    const badge = simulateDesktopBadge({
      pluginRef,
      pluginEntrySourceKind,
      ...(cloneData !== undefined ? { marketplaceClone: cloneData } : {}),
      pluginEntry,
      ...(pluginJsonInClone !== undefined ? { pluginJsonInClone } : {}),
    });
    const sessionStart = simulateSessionStart({ pluginRef, installedScopes: ip.scopes });

    resolvers[pkKey] = { cli, badge, sessionStart };
    logger.debug("resolver_sim", {
      pluginRefKey: pkKey,
      cliFrom: cli.resolvedFrom,
      badgeFrom: badge.resolvedFrom,
    });
  }

  return {
    knownMpCount: knownMps.marketplaces.length,
    installedPluginCount: installed.plugins.length,
  };
}

export async function runScan(opts: RunScanOpts): Promise<ScanReport> {
  const logger = opts.logger ?? nullLogger();
  const progress = opts.progress ?? nullProgress();
  const startedAt = nowIso();
  const startMs = Date.now();
  const maxConcurrency = Math.max(1, opts.maxConcurrency ?? 8);
  logger.info("scan_start", { mode: opts.mode, noNetwork: opts.noNetwork });

  const phaseStart = (phase: ScanPhase, total?: number): number => {
    progress.start(phase, total);
    logger.debug("phase_start", { phase, ...(total !== undefined ? { total } : {}) });
    return Date.now();
  };
  const phaseEnd = (phase: ScanPhase, t0: number): void => {
    const d = Date.now() - t0;
    progress.end(phase, d);
    logger.debug("phase_end", { phase, durationMs: d });
  };

  let t = phaseStart("init");
  phaseEnd("init", t);

  // ── Tier A: Discovery ────────────────────────────────────────────────────────
  t = phaseStart("discover_topology");
  const topology: Topology = discoverTopology({
    platform: opts.platform,
    home: opts.home,
    env: opts.env,
  });
  logger.info("topology_summary", {
    hasCcd: topology.ccd !== undefined,
    coworkRoots: topology.cowork.length,
    sessionLocals: topology.sessionLocals.length,
  });
  phaseEnd("discover_topology", t);

  // ── Tier A: Session-locals discovery phase event ─────────────────────────────
  t = phaseStart("discover_session_locals");
  logger.debug("discover_session_locals", { count: topology.sessionLocals.length });
  phaseEnd("discover_session_locals", t);

  // Also resolve legacy path-resolution for v0.5 layer functions still in use.
  t = phaseStart("resolve_paths");
  const ccdPluginsRoot = resolveCcdPluginsRoot({
    platform: opts.platform,
    home: opts.home,
    env: opts.env,
  });
  const userData = resolveUserDataDir({ platform: opts.platform, home: opts.home });
  const coworkRoots = enumerateCoworkRoots(userData);
  phaseEnd("resolve_paths", t);

  // ── Determine which roots to scan ────────────────────────────────────────────
  // mode "all" or "auto": scan CCD root + every cowork root (filtered by rootFilter if set).
  // mode "ccd": CCD root only.
  // mode "cowork": single active cowork root (legacy behavior).
  const effectiveMode = opts.mode === "auto" ? "all" : opts.mode;

  const upstreams: Record<PluginRefKey | MarketplaceRefKey, UpstreamProbeResult> = {};
  const marketplaceCaches: Record<MarketplaceRefKey, CacheSnapshot[]> = {};
  const caches: Record<PluginRefKey, CacheSnapshot[]> = {};
  const rpmCaches: Record<string, CacheSnapshot[]> = {};
  const resolvers: Record<
    PluginRefKey,
    { cli: CliUpdateSim; badge: DesktopBadgeSim; sessionStart: SessionStartSim }
  > = {};

  let totalKnownMpCount = 0;
  let totalInstalledPluginCount = 0;

  if (effectiveMode === "all") {
    // ── "all" mode: walk every root in the topology ─────────────────────────
    // Apply rootFilter if provided
    let coworkRootsToScan = topology.cowork;
    if (opts.rootFilter) {
      const { accountId, orgId } = opts.rootFilter;
      coworkRootsToScan = topology.cowork.filter(
        (r) => r.accountId === accountId && r.orgId === orgId,
      );
    }

    // Helper to get a v0.5-compatible CoworkRootInfo from CoworkRoot.
    const toCoworkRootInfo = (cr: import("../types.js").CoworkRoot): CoworkRootInfo => ({
      path: cr.rootPath,
      accountId: cr.accountId,
      orgId: cr.orgId,
      ...(cr.installedPluginsMtime !== undefined
        ? { installedPluginsMtime: cr.installedPluginsMtime }
        : {}),
    });

    // Emit phase events once for all roots combined.
    const tProbe = phaseStart("probe_upstreams");
    const tSnap = phaseStart("snapshot_caches");
    const tFetch = phaseStart("fetch_remote_versions");
    const tSim = phaseStart("simulate_resolvers");

    // Build the full cowork roster once and pass it to every per-root
    // pipeline invocation (audit issue #8). Previously each per-root call
    // received `allCoworkRoots: [cwInfo]` — only the current root — which
    // meant `runRootPipeline`'s cowork-mirror snapshot loop only saw a single
    // root, so cross-root mirror drift was invisible in all-mode. Passing
    // the full roster to the CCD branch is harmless: the cowork-mirror loop
    // is gated on `isCoworkRoot` (line ~460).
    const allCoworkRoots: CoworkRootInfo[] = coworkRootsToScan.map(toCoworkRootInfo);

    // CCD root
    if (topology.ccd && !opts.rootFilter) {
      const activeRootRef: { kind: "ccd" } = { kind: "ccd" };
      const result = await runRootPipeline({
        activePluginsRoot: topology.ccd.pluginsRoot,
        activeRootRef,
        allCoworkRoots,
        activeCw: undefined,
        noNetwork: opts.noNetwork,
        maxConcurrency,
        upstreams,
        marketplaceCaches,
        caches,
        rpmCaches,
        resolvers,
        logger,
        progress,
      });
      totalKnownMpCount += result.knownMpCount;
      totalInstalledPluginCount += result.installedPluginCount;
    }

    // Cowork roots
    for (const cwRoot of coworkRootsToScan) {
      const cwInfo = toCoworkRootInfo(cwRoot);
      const activeRootRef = {
        kind: "cowork" as const,
        accountId: cwRoot.accountId,
        orgId: cwRoot.orgId,
      };
      const result = await runRootPipeline({
        activePluginsRoot: path.join(cwRoot.rootPath, "cowork_plugins"),
        activeRootRef,
        allCoworkRoots,
        activeCw: cwInfo,
        noNetwork: opts.noNetwork,
        maxConcurrency,
        upstreams,
        marketplaceCaches,
        caches,
        rpmCaches,
        resolvers,
        logger,
        progress,
      });
      totalKnownMpCount += result.knownMpCount;
      totalInstalledPluginCount += result.installedPluginCount;
    }

    phaseEnd("probe_upstreams", tProbe);
    phaseEnd("snapshot_caches", tSnap);
    phaseEnd("fetch_remote_versions", tFetch);
    phaseEnd("simulate_resolvers", tSim);
  } else {
    // ── "ccd" / "cowork" single-mode scan (legacy) ──────────────────────────
    t = phaseStart("detect_mode");
    const ccdInstalledPath = path.join(ccdPluginsRoot, "installed_plugins.json");
    const ccdMtime = fs.existsSync(ccdInstalledPath)
      ? fs.statSync(ccdInstalledPath).mtimeMs
      : undefined;
    const activeCw = pickActiveCoworkRoot(coworkRoots, opts.coworkAccount, opts.coworkOrg);
    const cwMtime = activeCw?.installedPluginsMtime;
    const mode = detectMode(opts.mode as "ccd" | "cowork" | "auto", ccdMtime, cwMtime);
    logger.info("mode_detected", { mode, ccdMtime, cwMtime });
    phaseEnd("detect_mode", t);

    const activePluginsRoot =
      mode === "ccd" ? ccdPluginsRoot : activeCw ? coworkPluginsRootFor(activeCw) : ccdPluginsRoot;
    const activeRootRef: import("../types.js").RootRef =
      mode === "cowork" && activeCw
        ? { kind: "cowork", accountId: activeCw.accountId, orgId: activeCw.orgId }
        : { kind: "ccd" };
    const otherCwRoots =
      mode === "cowork" && activeCw ? coworkRoots.filter((r) => r.path !== activeCw.path) : [];
    const allCoworkRoots = mode === "cowork" && activeCw ? [activeCw, ...otherCwRoots] : [];

    const tProbe = phaseStart("probe_upstreams");
    const tSnap = phaseStart("snapshot_caches");
    const tFetch = phaseStart("fetch_remote_versions");
    const tSim = phaseStart("simulate_resolvers");

    const result = await runRootPipeline({
      activePluginsRoot,
      activeRootRef,
      allCoworkRoots,
      activeCw: mode === "cowork" ? activeCw : undefined,
      noNetwork: opts.noNetwork,
      maxConcurrency,
      upstreams,
      marketplaceCaches,
      caches,
      rpmCaches,
      resolvers,
      logger,
      progress,
    });
    totalKnownMpCount += result.knownMpCount;
    totalInstalledPluginCount += result.installedPluginCount;

    phaseEnd("probe_upstreams", tProbe);
    phaseEnd("snapshot_caches", tSnap);
    phaseEnd("fetch_remote_versions", tFetch);
    phaseEnd("simulate_resolvers", tSim);
  }

  // ── Tier A: Skills-plugin discovery + Tier C: Skills-plugin snapshots ────────
  t = phaseStart("discover_skills_plugin");
  const allCacheSnapshots: CacheSnapshot[] = [];
  for (const snaps of Object.values(caches)) allCacheSnapshots.push(...snaps);
  for (const snaps of Object.values(marketplaceCaches)) allCacheSnapshots.push(...snaps);
  for (const snaps of Object.values(rpmCaches)) allCacheSnapshots.push(...snaps);

  // --no-skills-plugin flag: skip skills-plugin snapshot loop (spec §9.2).
  const includeSkillsPlugin = opts.includeSkillsPlugin !== false;
  if (includeSkillsPlugin && topology.skillsPlugin) {
    const spRoot = topology.skillsPlugin;
    for (const pair of spRoot.pairs) {
      const spSnaps = snapshotSkillsPluginPair({
        pair,
        skillsPluginRootPath: spRoot.rootPath,
      });
      for (const s of spSnaps) allCacheSnapshots.push(s);
    }
    logger.debug("skills_plugin_snapshots", {
      pairs: spRoot.pairs.length,
      snapshots: allCacheSnapshots.filter((s) => s.layer === "skills_plugin").length,
    });
  } else if (!includeSkillsPlugin) {
    logger.debug("skills_plugin_snapshots_skipped", { reason: "--no-skills-plugin" });
  }
  phaseEnd("discover_skills_plugin", t);

  // ── Tier E: Drift composition ─────────────────────────────────────────────────
  t = phaseStart("compose_drift");

  const resolversForComposer: Record<
    PluginRefKey,
    { cli: CliUpdateSim; badge: DesktopBadgeSim; session: SessionStartSim }
  > = {};
  for (const [key, val] of Object.entries(resolvers)) {
    resolversForComposer[key] = { cli: val.cli, badge: val.badge, session: val.sessionStart };
  }

  const uiEvidence = readEvidence();
  // ui_evidence_read structured log record (§10.4.4) — one per observation found.
  if (uiEvidence) {
    for (const [refKey, obs] of Object.entries(uiEvidence.observations)) {
      logger.info("ui_evidence_read", {
        pluginRefKey: refKey,
        capturedAt: obs.capturedAt,
        pluginListed: obs.pluginListed,
      });
    }
  }

  const drifts = composeDrift({
    topology,
    cacheSnapshots: allCacheSnapshots,
    upstreams,
    resolvers: resolversForComposer,
    ...(uiEvidence ? { uiEvidence } : {}),
    ...(opts.uiEvidenceMaxAgeDays !== undefined
      ? { uiEvidenceMaxAgeDays: opts.uiEvidenceMaxAgeDays }
      : {}),
  });
  // drift_emitted structured log records (§10.4.4) — one per drift item.
  for (const d of drifts) {
    logger.info("drift_emitted", {
      kind: d.kind,
      ...("subject" in d && d.subject && typeof d.subject === "object" && "ref" in d.subject
        ? {
            subject:
              (d.subject as { kind: string }).kind === "plugin"
                ? `${(d.subject as { ref: { pluginName: string; marketplace: string } }).ref.pluginName}@${(d.subject as { ref: { pluginName: string; marketplace: string } }).ref.marketplace}`
                : (d.subject as { ref: { marketplace: string } }).ref.marketplace,
          }
        : {}),
    });
  }
  logger.debug("compose_drift_done", { driftCount: drifts.length });
  phaseEnd("compose_drift", t);

  // ── Tier F: Recommendation planning ──────────────────────────────────────────
  t = phaseStart("plan_recommendations");
  const recommendations = planRecommendations(drifts, { resolvers });
  // action_planned structured log records (§10.4.4) — one per action.
  for (const action of recommendations) {
    logger.info("action_planned", { id: action.id, ordinal: action.ordinal, risk: action.risk });
  }
  // runtime_boundary structured log record (§10.4.4) — when advisory included.
  const runtimeBoundaryAction = recommendations.find((r) => r.id === "advisory:runtime-boundary");
  if (runtimeBoundaryAction) {
    logger.info("runtime_boundary", {
      postActionAdvisory: runtimeBoundaryAction.postActionAdvisory,
      description: runtimeBoundaryAction.description,
    });
  }
  logger.debug("plan_recommendations_done", { recommendationCount: recommendations.length });
  phaseEnd("plan_recommendations", t);

  // ── Render / exit code ────────────────────────────────────────────────────────
  t = phaseStart("render");
  const exitCode = computeExitCode(drifts, recommendations);
  phaseEnd("render", t);

  const finishedAt = nowIso();
  const totalMs = Date.now() - startMs;

  const topologyRoots =
    (topology.ccd ? 1 : 0) + topology.cowork.length + (topology.skillsPlugin ? 1 : 0);
  const versionTrapCount = drifts.filter(
    (d) =>
      d.kind === "refresh-needed" || d.kind === "bump-needed" || d.kind === "badge-only-needed",
  ).length;
  const staleCount = drifts.filter(
    (d) =>
      d.kind === "marketplace-update-broken" ||
      d.kind === "refresh-needed" ||
      d.kind === "bump-needed" ||
      d.kind === "badge-only-needed" ||
      (d.kind === "version-drift" && d.ahead === "upstream") ||
      d.kind === "skills-plugin-stuck" ||
      d.kind === "session-bloat-cleanup-eligible",
  ).length;
  const summary = {
    marketplaces: totalKnownMpCount,
    plugins: totalInstalledPluginCount,
    // Deprecated; kept for back-compat. Use versionTrapCount instead.
    layersStale: versionTrapCount,
    versionTrapCount,
    staleCount,
    topologyRoots,
    driftCount: drifts.length,
    recommendationCount: recommendations.length,
  };
  logger.info("scan_done", { exitCode, durationMs: totalMs, summary });
  progress.emitDone(totalMs, exitCode, summary);

  const logFile = logger.getFilePath();
  const scanSummary = deriveScanSummary(caches, marketplaceCaches, rpmCaches, drifts, upstreams);
  return {
    schemaVersion: "1.0",
    runId: logger.getRunId(),
    startedAt,
    finishedAt,
    topology,
    upstreams,
    caches,
    marketplaceCaches,
    rpmCaches,
    resolvers,
    drifts,
    recommendations,
    summary: scanSummary,
    exitCode,
    ...(logFile !== undefined ? { logFile } : {}),
  };
}

// Exported for unit tests. Exit-code policy is small enough to test directly
// rather than constructing a full scan fixture. See audit issue #1.
export function computeExitCode(
  drifts: import("../types.js").Drift[],
  recommendations: import("../types.js").RecommendedAction[],
): 0 | 2 | 3 {
  // version-drift with `ahead === "upstream"` (catalog newer than installed)
  // produces a runnable `claude plugin update <id>` recommendation in the
  // planner. It was previously absent from this set, so a scan whose only
  // finding was a stale install exited 0 — automation could miss the update
  // (audit issue #1). The planner subsumes version-drift when a higher-
  // fidelity refresh-needed/bump-needed/badge-only-needed trap covers the
  // same plugin (`recommendations/plan.ts:122-132`); for those cases the
  // surviving trap drives the exit code on its own.
  const actionableDrifts = drifts.filter(
    (d) =>
      d.kind === "refresh-needed" ||
      d.kind === "bump-needed" ||
      d.kind === "badge-only-needed" ||
      d.kind === "marketplace-update-broken" ||
      d.kind === "skills-plugin-stuck" ||
      d.kind === "unsupported-source" ||
      (d.kind === "version-drift" && d.ahead === "upstream"),
  );
  if (actionableDrifts.length === 0) return 0;
  const hasDestructive = recommendations.some((r) => r.risk === "destructive");
  const hasManual = recommendations.some((r) => r.requiresManualStep && !r.cmd);
  if (hasDestructive || hasManual) return 3;
  return 2;
}

// ── v0.5-compatible scan for list/refresh/watch/check commands ──────────────
// These commands still produce the v0.5 MarketplaceReport / PluginReport /
// RpmReport shapes. Phase 6 keeps them internally; phase 7+ will migrate them.

export type V05ScanResult = {
  mode: Mode;
  roots: {
    ccdPlugins?: string;
    coworkActive?: string;
    coworkOther: string[];
  };
  marketplaces: MarketplaceReport[];
  plugins: PluginReport[];
  rpmPlugins: RpmReport[];
  coworkRoots: CoworkRootInfo[];
  recommendedActions: string[];
  exitCode: 0 | 2 | 3;
  runId: string;
  startedAt: string;
  finishedAt: string;
  logFile?: string;
  /** Topology discovered during this scan. Additive: consumers that
   *  only use the v0.5 fields can safely ignore this. Populated from the
   *  same discoverTopology call that backs the v1.0 ScanReport. */
  topology?: import("../types.js").Topology;
  /** Cross-mode marketplaces: when mode is "cowork", this carries the CCD-side
   *  MarketplaceReport[] for cross-reference (e.g. source-URL lookup in the
   *  alias-differs note). Absent when mode is "ccd" or when CCD has no
   *  known_marketplaces.json. Additive. */
  crossModeMarketplaces?: MarketplaceReport[];
};

export async function runV05Scan(opts: RunScanOpts): Promise<V05ScanResult> {
  const logger = opts.logger ?? nullLogger();
  let progress = opts.progress ?? nullProgress();
  // B1: apply NDJSON and human-done suppression flags.
  // Order matters: apply silentNdjson BEFORE suppressHumanDone so withSuppressedHumanDone
  // operates on the already-stripped progress.
  if (opts.silentNdjson) progress = progress.withoutNdjson();
  if (opts.suppressHumanDone) progress = progress.withSuppressedHumanDone();
  const startedAt = nowIso();
  const startMs = Date.now();
  logger.info("scan_start", { mode: opts.mode, noNetwork: opts.noNetwork });

  const phaseStart = (phase: ScanPhase, total?: number): number => {
    progress.start(phase, total);
    logger.debug("phase_start", { phase, ...(total !== undefined ? { total } : {}) });
    return Date.now();
  };
  const phaseEnd = (phase: ScanPhase, t0: number): void => {
    const d = Date.now() - t0;
    progress.end(phase, d);
    logger.debug("phase_end", { phase, durationMs: d });
  };

  let t = phaseStart("init");
  phaseEnd("init", t);

  t = phaseStart("resolve_paths");
  const ccdPluginsRoot = resolveCcdPluginsRoot({
    platform: opts.platform,
    home: opts.home,
    env: opts.env,
  });
  const userData = resolveUserDataDir({ platform: opts.platform, home: opts.home });
  const coworkRoots = enumerateCoworkRoots(userData);
  phaseEnd("resolve_paths", t);

  // Discover topology — needed by runList for skillsPlugin data.
  const topology: import("../types.js").Topology = discoverTopology({
    platform: opts.platform,
    home: opts.home,
    env: opts.env,
  });

  // Bug 3 fix: populate isBuiltIn on topology skills so JSON output carries
  // correct values. snapshotSkillsPluginPair (the only caller that sets
  // skill.isBuiltIn) is NOT called in the v0.5 path, leaving it undefined/null.
  // Inline the same BUILTIN_SKILLS.has() logic here so JSON output is correct.
  if (topology.skillsPlugin) {
    for (const pair of topology.skillsPlugin.pairs) {
      for (const skill of pair.skills) {
        skill.isBuiltIn = BUILTIN_SKILLS.has(skill.skillName);
      }
    }
  }

  t = phaseStart("detect_mode");
  const ccdInstalledPath = path.join(ccdPluginsRoot, "installed_plugins.json");
  const ccdMtime = fs.existsSync(ccdInstalledPath)
    ? fs.statSync(ccdInstalledPath).mtimeMs
    : undefined;
  const activeCw = pickActiveCoworkRoot(coworkRoots, opts.coworkAccount, opts.coworkOrg);
  const cwMtime = activeCw?.installedPluginsMtime;
  const mode = detectMode(opts.mode, ccdMtime, cwMtime);
  logger.info("mode_detected", { mode, ccdMtime, cwMtime });
  phaseEnd("detect_mode", t);

  const activePluginsRoot =
    mode === "ccd" ? ccdPluginsRoot : activeCw ? coworkPluginsRootFor(activeCw) : ccdPluginsRoot;

  t = phaseStart("parse_known_marketplaces");
  const knownMps = parseKnownMarketplaces(path.join(activePluginsRoot, "known_marketplaces.json"));
  // Surface for --verbose: tells users how many marketplaces were discovered
  // for the active root before the per-marketplace probes start. Mirrors
  // what runScan emits in its corresponding phase.
  logger.debug("known_marketplaces_parsed", {
    root: mode === "cowork" ? "cowork" : "ccd",
    count: knownMps.marketplaces.length,
  });
  phaseEnd("parse_known_marketplaces", t);

  t = phaseStart("parse_installed_plugins");
  const installed = parseInstalledPlugins(path.join(activePluginsRoot, "installed_plugins.json"));
  if (installed.unknownFileVersion) {
    logger.warn("unknown_installed_plugins_file_version", { fileVersion: installed.fileVersion });
  }
  logger.debug("installed_plugins_parsed", {
    root: mode === "cowork" ? "cowork" : "ccd",
    count: installed.plugins.length,
    fileVersion: installed.fileVersion,
  });
  phaseEnd("parse_installed_plugins", t);

  t = phaseStart("parse_rpm_manifest");
  let rpmRoot: string | undefined;
  let rpmManifestEntries: RpmEntry[] = [];
  // Bug 1 fix: RPM data is cowork-side and orthogonal to which installed_plugins.json
  // is more recently touched. When opts.mode is "all"/"auto" and detectMode() collapsed
  // it to "ccd" (because CCD mtime is newer), we still need to parse RPM manifests —
  // RPM plugins exist regardless of which installed_plugins.json was touched last.
  // Exception: when the user EXPLICITLY requested --mode ccd (not auto-detected), we
  // honour that intent and skip RPM (the check fallback path handles cross-mode lookup).
  const requestedModeIsExplicitCcd = opts.mode === "ccd";
  if (activeCw && (mode === "cowork" || !requestedModeIsExplicitCcd)) {
    rpmRoot = rpmRootFor(activeCw);
    const manifest = parseRpmManifest(path.join(rpmRoot, "manifest.json"));
    rpmManifestEntries = manifest.entries;
    logger.debug("rpm_manifest_parsed", { count: rpmManifestEntries.length });
  }
  phaseEnd("parse_rpm_manifest", t);

  const otherCwRoots =
    mode === "cowork" && activeCw ? coworkRoots.filter((r) => r.path !== activeCw.path) : [];

  t = phaseStart("check_marketplaces", knownMps.marketplaces.length);
  const marketplaces: MarketplaceReport[] = new Array(knownMps.marketplaces.length);
  let mpDone = 0;
  await Promise.all(
    knownMps.marketplaces.map(async (mp, idx) => {
      const probeStart = Date.now();
      const layer1 = await checkMarketplaceClone({
        pluginsRoot: activePluginsRoot,
        marketplace: mp,
        noNetwork: opts.noNetwork,
      });
      const probeDuration = Date.now() - probeStart;
      mpDone++;
      progress.update("check_marketplaces", mpDone, knownMps.marketplaces.length, mp.name);
      const sourceType =
        mp.source.source === "github" ||
        mp.source.source === "git" ||
        mp.source.source === "directory" ||
        mp.source.source === "remote"
          ? mp.source.source
          : "unknown";
      const sourceDetail = formatSourceDetail(mp.source);
      // Surface for --verbose: same `upstream_probe` shape that runScan emits.
      // Includes the layer-1 status so users see WHY a marketplace was flagged
      // (or `no-network` when --no-network was passed). Subject form mirrors
      // runScan: "<marketplaceName>#<rootKey>".
      const rootKey =
        mode === "cowork" && activeCw ? `cowork:${activeCw.accountId}:${activeCw.orgId}` : "ccd";
      logger.info("upstream_probe", {
        subject: `${mp.name}#${rootKey}`,
        source: sourceType,
        status: layer1.status,
        durationMs: probeDuration,
      });
      marketplaces[idx] = {
        name: mp.name,
        sourceType,
        sourceDetail,
        layer1,
        integrityIssues: integrityCheck(activePluginsRoot, mp.name),
      };
    }),
  );
  phaseEnd("check_marketplaces", t);

  // Bug 4 fix: when mode is cowork, also load CCD's known_marketplaces.json
  // so the renderer can look up source URLs for CCD aliases (e.g. for the
  // alias-differs note in renderHumanCheckRpmOnly). Cross-mode lookup.
  let crossModeMarketplaces: MarketplaceReport[] | undefined;
  if (mode !== "ccd" && ccdPluginsRoot !== activePluginsRoot) {
    const ccdKnownMps = parseKnownMarketplaces(
      path.join(ccdPluginsRoot, "known_marketplaces.json"),
    );
    if (ccdKnownMps.marketplaces.length > 0) {
      crossModeMarketplaces = await Promise.all(
        ccdKnownMps.marketplaces.map(async (mp) => {
          const layer1 = await checkMarketplaceClone({
            pluginsRoot: ccdPluginsRoot,
            marketplace: mp,
            noNetwork: true, // cross-mode lookup: skip network for perf
          });
          const sourceType =
            mp.source.source === "github" ||
            mp.source.source === "git" ||
            mp.source.source === "directory" ||
            mp.source.source === "remote"
              ? mp.source.source
              : "unknown";
          return {
            name: mp.name,
            sourceType,
            sourceDetail: formatSourceDetail(mp.source),
            layer1,
            integrityIssues: integrityCheck(ccdPluginsRoot, mp.name),
          } satisfies MarketplaceReport;
        }),
      );
    }
  }

  const cloneHeadByMarketplace = new Map<string, string>();
  const remoteHeadByMarketplace = new Map<string, string>();
  const remoteUrlByMarketplace = new Map<string, string>();
  const sourceTypeByMarketplace = new Map<string, MarketplaceReport["sourceType"]>();
  const sourceRootByMarketplace = new Map<string, string>();
  for (const m of marketplaces) {
    const head = m.layer1.evidence.headLocal;
    if (typeof head === "string") cloneHeadByMarketplace.set(m.name, head);
    const remoteHead = m.layer1.evidence.headRemote;
    if (typeof remoteHead === "string") remoteHeadByMarketplace.set(m.name, remoteHead);
    const remoteUrl = m.layer1.evidence.remoteUrl;
    if (typeof remoteUrl === "string") remoteUrlByMarketplace.set(m.name, remoteUrl);
    sourceTypeByMarketplace.set(m.name, m.sourceType);
    if (m.sourceType === "directory") {
      const srcPath = m.layer1.evidence.srcPath;
      if (typeof srcPath === "string") sourceRootByMarketplace.set(m.name, srcPath);
    }
  }

  t = phaseStart("fetch_remote_versions", installed.plugins.length);
  const remoteCliVersionByPlugin = new Map<string, string>();
  if (!opts.noNetwork) {
    const entryByPlugin = new Map<string, { name: string; source?: string; path?: string }>();
    for (const ip of installed.plugins) {
      const mpPath = path.join(
        activePluginsRoot,
        "marketplaces",
        ip.marketplace,
        ".claude-plugin",
        "marketplace.json",
      );
      if (!fs.existsSync(mpPath)) continue;
      try {
        const json = JSON.parse(fs.readFileSync(mpPath, "utf8")) as {
          plugins?: { name: string; source?: unknown; path?: string }[];
        };
        const entry = json.plugins?.find((p) => p.name === ip.pluginName);
        if (!entry) continue;
        let source: string | undefined;
        if (typeof entry.source === "string") source = entry.source;
        else if (entry.source && typeof entry.source === "object") {
          const s = entry.source as { path?: unknown };
          if (typeof s.path === "string") source = s.path;
        }
        entryByPlugin.set(ip.id, {
          name: entry.name,
          ...(source !== undefined ? { source } : {}),
          ...(entry.path !== undefined ? { path: entry.path } : {}),
        });
      } catch {
        /* skip */
      }
    }

    let fIdx = 0;
    await Promise.all(
      installed.plugins.map(async (ip) => {
        const remoteUrl = remoteUrlByMarketplace.get(ip.marketplace);
        const remoteHead = remoteHeadByMarketplace.get(ip.marketplace);
        const entry = entryByPlugin.get(ip.id);
        if (!remoteUrl || !remoteHead || !entry || !parseGithubUrl(remoteUrl)) {
          fIdx++;
          progress.update("fetch_remote_versions", fIdx, installed.plugins.length, ip.id);
          return;
        }
        const ref = buildRemoteSourceRef({
          remoteUrl,
          ref: remoteHead,
          pluginSourcePath: entry.source ?? entry.path,
        });
        if (!ref) {
          fIdx++;
          progress.update("fetch_remote_versions", fIdx, installed.plugins.length, ip.id);
          return;
        }
        const result = await fetchRemotePluginVersion(ref);
        fIdx++;
        progress.update("fetch_remote_versions", fIdx, installed.plugins.length, ip.id);
        if (result.ok && result.version !== undefined) {
          remoteCliVersionByPlugin.set(ip.id, result.version);
        }
      }),
    );
  }
  phaseEnd("fetch_remote_versions", t);

  const ALL_LAYERS_LIST: readonly Layer[] = [
    "marketplace_clone",
    "install_snapshot",
    "cowork_mirror",
    "rpm_copy",
    "ccd_remote_ssh",
  ];

  t = phaseStart("check_plugins", installed.plugins.length);
  const plugins: PluginReport[] = [];
  let pIdx = 0;
  for (const ip of installed.plugins) {
    progress.update("check_plugins", ++pIdx, installed.plugins.length, ip.id);
    const checks = emptyChecks(ip.id);
    const mp = knownMps.marketplaces.find((m) => m.name === ip.marketplace);
    if (mp) {
      const matched = marketplaces.find((m) => m.name === ip.marketplace);
      checks.marketplace_clone = matched?.layer1 ?? checks.marketplace_clone;
    } else {
      checks.marketplace_clone = {
        plugin: ip.id,
        layer: "marketplace_clone",
        status: "missing",
        detail: `Marketplace "${ip.marketplace}" referenced by ${ip.id} is not in known_marketplaces.json.`,
        evidence: {},
      };
    }

    const cloneHeadSha = cloneHeadByMarketplace.get(ip.marketplace);
    const marketplaceSourceType = sourceTypeByMarketplace.get(ip.marketplace);
    const marketplaceSourceRoot = sourceRootByMarketplace.get(ip.marketplace);
    const remoteCliVersion = remoteCliVersionByPlugin.get(ip.id);

    // Pre-compute the commit-range diff for the bump-needed/refresh-needed
    // detail. Only meaningful when both SHAs are known and they differ.
    // No network, no external cost beyond one local `git log`. Skip silently
    // on any error (the renderer hides the section when commitsBetween is
    // empty / undefined).
    let commitsBetween: { sha: string; subject: string }[] | undefined;
    let commitsBetweenTruncated: boolean | undefined;
    const installedSha = preferredScope(ip).gitCommitSha;
    if (
      typeof installedSha === "string" &&
      typeof cloneHeadSha === "string" &&
      installedSha !== cloneHeadSha
    ) {
      const cloneDir = path.join(activePluginsRoot, "marketplaces", ip.marketplace);
      const subdir = readPluginSubdir(activePluginsRoot, ip.marketplace, ip.pluginName);
      const result = await gitLogBetween(cloneDir, installedSha, cloneHeadSha, {
        max: 10,
        ...(subdir !== undefined ? { subdir } : {}),
      });
      if (result.ok && result.commits.length > 0) {
        commitsBetween = result.commits;
        if (result.truncated) commitsBetweenTruncated = true;
      }
    }

    checks.install_snapshot = checkInstallSnapshot({
      pluginsRoot: activePluginsRoot,
      installed: ip,
      ...(cloneHeadSha ? { cloneHeadSha } : {}),
      ...(marketplaceSourceType ? { marketplaceSourceType } : {}),
      ...(marketplaceSourceRoot ? { marketplaceSourceRoot } : {}),
      marketplaceCloneStatus: checks.marketplace_clone.status,
      ...(remoteCliVersion !== undefined ? { remoteCliVersion } : {}),
      ...(commitsBetween !== undefined ? { commitsBetween } : {}),
      ...(commitsBetweenTruncated !== undefined ? { commitsBetweenTruncated } : {}),
    });

    checks.cowork_mirror = checkCoworkMirror({
      mode,
      pluginId: ip.id,
      pluginName: ip.pluginName,
      marketplace: ip.marketplace,
      activeRoot:
        mode === "cowork" && activeCw
          ? { path: activeCw.path, accountId: activeCw.accountId, orgId: activeCw.orgId }
          : undefined,
      otherRoots: otherCwRoots.map((r) => ({
        path: r.path,
        accountId: r.accountId,
        orgId: r.orgId,
      })),
    });

    checks.rpm_copy = {
      plugin: ip.id,
      layer: "rpm_copy",
      status: "skipped",
      detail:
        "Plugin is not registered as a Claude Cowork in-app install (Personal plugins) — that surface is checked separately.",
      evidence: { kind: "inapplicable" },
    };

    checks.ccd_remote_ssh = checkCcdRemoteSsh({ pluginId: ip.id });

    const mpVersion = matchedMpVersion(activePluginsRoot, ip);
    const recommendation = extractRecommendation(checks, ALL_LAYERS_LIST);
    plugins.push({
      id: ip.id,
      marketplace: ip.marketplace,
      pluginName: ip.pluginName,
      ...(preferredScope(ip).version !== undefined
        ? { installedVersion: preferredScope(ip).version }
        : {}),
      ...(mpVersion !== undefined ? { marketplaceVersion: mpVersion } : {}),
      scopes: ip.scopes,
      checks,
      ...(recommendation !== undefined ? { primaryRecommendation: recommendation } : {}),
    });
  }
  phaseEnd("check_plugins", t);

  t = phaseStart("check_rpm", rpmManifestEntries.length);
  const rpmPlugins: RpmReport[] = [];
  if (rpmRoot) {
    let rpmIdx = 0;
    for (const e of rpmManifestEntries) {
      progress.update("check_rpm", ++rpmIdx, rpmManifestEntries.length, e.pluginId);
      rpmPlugins.push({
        pluginId: e.pluginId,
        ...(typeof e.raw.name === "string" ? { name: e.raw.name } : {}),
        ...(typeof e.raw.marketplaceName === "string"
          ? { marketplaceName: e.raw.marketplaceName }
          : {}),
        ...(typeof e.raw.marketplaceId === "string" ? { marketplaceId: e.raw.marketplaceId } : {}),
        layer5: checkRpmCopy({ rpmRoot, entry: e }),
      });
    }
  }
  phaseEnd("check_rpm", t);

  t = phaseStart("render");
  const recommendedActions = collectRecommendations(marketplaces, plugins, rpmPlugins);
  const exitCode = computeV05ExitCode(marketplaces, plugins, rpmPlugins, ALL_LAYERS_LIST);
  phaseEnd("render", t);

  const finishedAt = nowIso();
  const totalMs = Date.now() - startMs;
  const layersStale = plugins.filter((p) =>
    (["marketplace_clone", "install_snapshot", "cowork_mirror"] as const).some(
      (k) => p.checks[k].status === "stale" || p.checks[k].status === "missing",
    ),
  ).length;
  // 1.1: unknownCount is distinct from layersStale — it counts plugins whose
  // install_snapshot is "unknowable" (version not in marketplace.json). The two
  // counts can overlap: a plugin can be unknowable AND have a stale clone.
  const unknownCount = plugins.filter(
    (p) => p.checks.install_snapshot.status === "unknowable",
  ).length;
  const summary = {
    marketplaces: marketplaces.length,
    plugins: plugins.length,
    layersStale,
    unknownCount,
  };
  logger.info("scan_done", { exitCode, durationMs: totalMs, summary });
  progress.emitDone(totalMs, exitCode, summary);

  const logFile = logger.getFilePath();
  return {
    mode,
    roots: {
      ccdPlugins: ccdPluginsRoot,
      ...(activeCw ? { coworkActive: activeCw.path } : {}),
      coworkOther: otherCwRoots.map((r) => r.path),
    },
    marketplaces,
    plugins,
    rpmPlugins,
    coworkRoots,
    recommendedActions,
    exitCode,
    runId: logger.getRunId(),
    startedAt,
    finishedAt,
    ...(logFile !== undefined ? { logFile } : {}),
    topology,
    ...(crossModeMarketplaces !== undefined ? { crossModeMarketplaces } : {}),
  };
}

function formatSourceDetail(src: { source: string } & Record<string, unknown>): string {
  if (src.source === "github" && typeof src.repo === "string") return src.repo;
  if (src.source === "git" && typeof src.url === "string") return src.url;
  if (src.source === "directory" && typeof src.path === "string") return src.path;
  if (src.source === "remote") return "(backend-managed)";
  return "(unknown)";
}

function integrityCheck(pluginsRoot: string, mpName: string): string[] {
  const issues: string[] = [];
  const mpJson = path.join(
    pluginsRoot,
    "marketplaces",
    mpName,
    ".claude-plugin",
    "marketplace.json",
  );
  if (!fs.existsSync(mpJson)) return issues;
  try {
    const data = JSON.parse(fs.readFileSync(mpJson, "utf8")) as { plugins?: unknown };
    if (!Array.isArray(data.plugins)) {
      issues.push("marketplace.json: missing or non-array 'plugins' field");
    }
  } catch (e) {
    issues.push(`marketplace.json parse error: ${(e as Error).message}`);
  }
  return issues;
}

function matchedMpVersion(pluginsRoot: string, ip: InstalledPlugin): string | undefined {
  const p = path.join(
    pluginsRoot,
    "marketplaces",
    ip.marketplace,
    ".claude-plugin",
    "marketplace.json",
  );
  if (!fs.existsSync(p)) return undefined;
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8")) as {
      plugins?: { name: string; version?: string }[];
    };
    return data.plugins?.find((pl) => pl.name === ip.pluginName)?.version;
  } catch {
    return undefined;
  }
}

function extractRecommendation(checks: Record<Layer, CheckResult>, _layerList: readonly Layer[]) {
  const priority: Layer[] = ["install_snapshot", "marketplace_clone", "rpm_copy", "cowork_mirror"];
  for (const layer of priority) {
    const rec = checks[layer]?.recommendation;
    if (rec) return rec;
  }
  return undefined;
}

function collectRecommendations(
  marketplaces: MarketplaceReport[],
  plugins: PluginReport[],
  rpmPlugins: RpmReport[],
): string[] {
  const out: string[] = [];
  for (const m of marketplaces) {
    const cmd = m.layer1.recommendation?.cmd;
    if (cmd && !out.includes(cmd)) out.push(cmd);
  }
  for (const p of plugins) {
    const cmd = p.primaryRecommendation?.cmd;
    if (cmd && !out.includes(cmd)) out.push(cmd);
  }
  for (const r of rpmPlugins) {
    const action = r.layer5.recommendation?.action;
    if (action && !out.includes(action)) out.push(action);
  }
  return out;
}

function computeV05ExitCode(
  marketplaces: MarketplaceReport[],
  plugins: PluginReport[],
  rpmPlugins: RpmReport[],
  layerList: readonly Layer[],
): 0 | 2 | 3 {
  let drift = false;
  let destructive = false;
  const collect = (cr: CheckResult) => {
    if (cr.status === "stale" || cr.status === "missing") drift = true;
    if (cr.recommendation?.risk === "destructive") destructive = true;
  };
  for (const m of marketplaces) collect(m.layer1);
  for (const p of plugins) for (const layer of layerList) collect(p.checks[layer]);
  for (const r of rpmPlugins) collect(r.layer5);
  if (!drift) return 0;
  return destructive ? 3 : 2;
}
