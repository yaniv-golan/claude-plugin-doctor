/**
 * `cpd check <plugin>@<marketplace>` — v1.0 implementation.
 *
 * Produces a CheckReport (v1.0 shape per SPEC-v1.0.md §10.2) scoped to one
 * plugin. Uses the v1.0 runScan pipeline and filters drift + recommendations
 * to the requested plugin.
 *
 * Also exports runCheck which returns the v1.0 CheckReport.
 * For backward-compat with human.ts renderHumanCheck (which uses v0.5 PluginReport
 * fields), we also export runV05Check that uses the v0.5 scan path.
 */

import { CpdError } from "../errors.js";
import { marketplaceRefKey, pluginRefKey } from "../refs.js";
import type {
  CacheSnapshot,
  CliUpdateSim,
  DesktopBadgeSim,
  Drift,
  MarketplaceReport,
  PluginRef,
  PluginRefKey,
  PluginReport,
  RecommendedAction,
  ScanReport,
  SessionStartSim,
} from "../types.js";
import { type RunScanOpts, type V05ScanResult, runScan, runV05Scan } from "./scan.js";

// Re-export CheckReport as the v1.0 shape.
// (The type is declared in types.ts)

/** Compute the per-plugin exit code from drift items scoped to one plugin.
 *
 *  - 0: no actionable drift
 *  - 2: drift detected, at least one auto-runnable cmd fix
 *  - 3: drift detected, only manual fixes (or plugin not installed)
 */
function computePluginExitCode(
  pluginDrifts: Drift[],
  pluginRecs: RecommendedAction[],
  installed: boolean,
): 0 | 2 | 3 {
  if (!installed) return 2;
  const actionable = pluginDrifts.filter(
    (d) =>
      d.kind === "refresh-needed" ||
      d.kind === "bump-needed" ||
      d.kind === "badge-only-needed" ||
      d.kind === "marketplace-update-broken" ||
      d.kind === "skills-plugin-stuck" ||
      d.kind === "unsupported-source",
  );
  if (actionable.length === 0) return 0;
  const hasCmd = pluginRecs.some((r) => r.cmd !== undefined);
  const hasManual = pluginRecs.some((r) => r.requiresManualStep && !r.cmd);
  if (hasManual) return 3;
  if (hasCmd) return 2;
  return 3;
}

export type RunCheckOpts = RunScanOpts & {
  pluginAtMarketplace: string;
};

/**
 * v1.0 CheckReport shape per SPEC-v1.0.md §10.2.
 *
 * Per-plugin focus: filters ScanReport's drifts and recommendations to
 * only those concerning the requested plugin.
 */
export type CheckReport = {
  schemaVersion: "1.0";
  runId: string;
  startedAt: string;
  finishedAt: string;
  pluginRef: PluginRef;
  /** All snapshots for this plugin across all roots. */
  caches: CacheSnapshot[];
  /** Resolver triple for the active root. */
  resolvers: { cli: CliUpdateSim; badge: DesktopBadgeSim; sessionStart: SessionStartSim };
  /** Drift items scoped to this plugin. */
  drifts: Drift[];
  recommendations: RecommendedAction[];
  exitCode: 0 | 2 | 3;
  logFile?: string;
};

export async function runCheck(opts: RunCheckOpts): Promise<CheckReport> {
  const { pluginAtMarketplace, ...scanOpts } = opts;
  const idx = pluginAtMarketplace.lastIndexOf("@");
  if (idx <= 0 || idx === pluginAtMarketplace.length - 1) {
    throw new CpdError(
      "E_USAGE",
      `Invalid plugin id "${pluginAtMarketplace}" — expected "<plugin>@<marketplace>"`,
    );
  }
  const pluginName = pluginAtMarketplace.slice(0, idx);
  const marketplace = pluginAtMarketplace.slice(idx + 1);

  const fullReport = await runScan(scanOpts);

  // Find the pluginRef in the report: look through caches for a matching plugin.
  // Since runScan uses the active rootRef, find the key containing this plugin.
  let matchedPluginRef: PluginRef | undefined;
  let matchedKey: PluginRefKey | undefined;
  for (const [key, snaps] of Object.entries(fullReport.caches)) {
    for (const snap of snaps) {
      if (
        snap.subject.kind === "plugin" &&
        snap.subject.ref.pluginName === pluginName &&
        snap.subject.ref.marketplace === marketplace
      ) {
        matchedPluginRef = snap.subject.ref;
        matchedKey = key;
        break;
      }
    }
    if (matchedPluginRef) break;
  }

  // If not found in caches, construct a synthetic PluginRef using CCD root
  // (the plugin isn't installed).
  if (!matchedPluginRef) {
    matchedPluginRef = {
      pluginName,
      marketplace,
      root: fullReport.topology.ccd
        ? { kind: "ccd" }
        : fullReport.topology.cowork[0]
          ? {
              kind: "cowork",
              accountId: fullReport.topology.cowork[0].accountId,
              orgId: fullReport.topology.cowork[0].orgId,
            }
          : { kind: "ccd" },
    };
  }

  const pkKey = matchedKey ?? pluginRefKey(matchedPluginRef);

  // Filter caches, resolvers, drifts, and recommendations to this plugin.
  const pluginCaches = fullReport.caches[pkKey] ?? [];
  const pluginResolvers = fullReport.resolvers[pkKey] ?? {
    cli: {
      resolvedFrom: "unknown" as const,
      evidence: { pluginEntrySourceKind: "clone-unreadable" as const },
    },
    badge: {
      resolvedFrom: "unknown" as const,
      evidence: { pluginEntrySourceKind: "clone-unreadable" as const },
    },
    sessionStart: { unknowable: { reason: "not-installed" } },
  };

  // Filter drifts to this plugin.
  const pluginDrifts = fullReport.drifts.filter((d) => {
    if (d.kind === "registration-drift") {
      return d.name === pluginName && d.marketplace === marketplace;
    }
    if ("subject" in d) {
      const subj = d.subject as {
        kind: string;
        ref: PluginRef | { marketplace: string; root: unknown };
      };
      if (subj.kind === "plugin") {
        const ref = subj.ref as PluginRef;
        return ref.pluginName === pluginName && ref.marketplace === marketplace;
      }
      if (subj.kind === "marketplace") {
        const ref = subj.ref as { marketplace: string };
        return ref.marketplace === marketplace;
      }
    }
    return false;
  });

  // Filter recommendations to those that fix drifts involving this plugin.
  const pluginDriftKeys = new Set(
    pluginDrifts
      .map((d) => {
        if ("subject" in d && d.subject.kind === "plugin") {
          return pluginRefKey(d.subject.ref as PluginRef);
        }
        return null;
      })
      .filter((k): k is string => k !== null),
  );

  const pluginRecs = fullReport.recommendations.filter((r) =>
    r.fixes.some((f) => f.pluginRefKey === pkKey || pluginDriftKeys.has(f.pluginRefKey ?? "")),
  );

  const installed = pluginCaches.some((s) => s.presence === "present");
  const exitCode = computePluginExitCode(
    pluginDrifts,
    pluginRecs,
    installed || pluginCaches.length > 0,
  );

  return {
    schemaVersion: "1.0",
    runId: fullReport.runId,
    startedAt: fullReport.startedAt,
    finishedAt: fullReport.finishedAt,
    pluginRef: matchedPluginRef,
    caches: pluginCaches,
    resolvers: {
      cli: pluginResolvers.cli,
      badge: pluginResolvers.badge,
      sessionStart: pluginResolvers.sessionStart,
    },
    drifts: pluginDrifts,
    recommendations: pluginRecs,
    exitCode,
    ...(fullReport.logFile ? { logFile: fullReport.logFile } : {}),
  };
}

// ── v0.5-compatible check for the human renderer (renderHumanCheck) ─────────
// The human renderer still uses v0.5 PluginReport/CheckResult fields.
// Phase 7 will rewrite the renderer; until then, export a v0.5 check result.

/** Slim shape for a single RPM disambiguation candidate.
 *  NOT the full RpmReport — embedding RpmReport here would make every future
 *  RpmReport addition a v1.0-lockdown ratchet. */
export type RpmCandidateForDisambiguation = {
  pluginId: string; // backend plugin_<id>
  name: string; // plugin name (always the same across candidates by definition)
  marketplaceName: string; // RPM-side backend marketplace name (the disambiguator)
  marketplaceId?: string; // when array-form manifest carries it
  /** The id the user should type in their follow-up `cpd check` command. */
  suggestedDisambiguatedId: string; // "<plugin>@<rpm-marketplaceName>"
};

export type V05CheckReport = {
  schemaVersion: "1.0";
  pluginId: string;
  plugin?: PluginReport;
  marketplace?: MarketplaceReport;
  /** Set when the lookup resolved to an RPM-managed install (Cowork's
   *  "Personal plugins" UI path) rather than a regular installed_plugins.json
   *  entry. The CCD-style `<plugin>@<marketplace>` id format does NOT apply
   *  to RPM installs (which use a backend-assigned `plugin_<id>` and may
   *  carry a different marketplace alias than the CCD-installed copy of the
   *  same plugin). The renderer should branch on this to show the RPM
   *  install path + marketplace-alias clarification rather than the
   *  layer-1-through-5 PluginReport shape. */
  rpmMatch?: {
    rpmPlugin: import("../types.js").RpmReport;
    /** Set when the user typed a `<plugin>@<marketplace>` id whose marketplace
     *  component does NOT match the RPM record's `marketplaceName`. The
     *  renderer surfaces a one-line clarification so the user understands
     *  that "founder-skills" is in cowork as `founder-skills@founder-skills`
     *  even though they typed `founder-skills@lool-founder-skills`. */
    marketplaceAliasDiffers?: { typedAs: string; actual: string };
  };
  /** Set when ≥2 RPM entries share the typed plugin name and no exact-id match
   *  exists. The renderer surfaces all candidates and exits 64 (E_USAGE).
   *  Only set when `rpmMatch` is NOT set (they are mutually exclusive). */
  rpmMatchAmbiguous?: {
    candidates: RpmCandidateForDisambiguation[];
  };
  fullReport: V05ScanResult;
  /** Exit code 64 (E_USAGE) is used for the ambiguous-RPM-match case.
   *  Note: sysexits.h strictly assigns EX_USAGE (64) to malformed CLI invocations
   *  and EX_DATAERR (65) to "incorrect input data", but cpd uses 64 for internal
   *  consistency with existing E_USAGE mapping throughout the codebase. */
  exitCode: 0 | 2 | 3 | 64;
  runId: string;
  startedAt: string;
  finishedAt: string;
  logFile?: string;
};

function computeV05PluginExitCode(
  plugin: PluginReport | undefined,
  marketplace: MarketplaceReport | undefined,
): 0 | 2 | 3 | 64 {
  if (!plugin) return 2;

  let hasManual = false;
  let hasFixable = false;
  const considerCheck = (status: string, hasCmd: boolean): void => {
    if (status === "stale" || status === "missing") {
      if (hasCmd) hasFixable = true;
      else hasManual = true;
    }
  };

  if (marketplace) {
    considerCheck(marketplace.layer1.status, marketplace.layer1.recommendation?.cmd !== undefined);
  }

  for (const layer of [
    "marketplace_clone",
    "install_snapshot",
    "cowork_mirror",
    "rpm_copy",
    "ccd_remote_ssh",
  ] as const) {
    const r = plugin.checks[layer];
    considerCheck(r.status, r.recommendation?.cmd !== undefined);
  }

  if (hasManual) return 3;
  if (hasFixable) return 2;
  return 0;
}

export async function runV05Check(opts: RunCheckOpts): Promise<V05CheckReport> {
  const { pluginAtMarketplace, ...scanOpts } = opts;
  const idx = pluginAtMarketplace.lastIndexOf("@");
  if (idx <= 0 || idx === pluginAtMarketplace.length - 1) {
    throw new CpdError(
      "E_USAGE",
      `Invalid plugin id "${pluginAtMarketplace}" — expected "<plugin>@<marketplace>"`,
    );
  }
  const pluginName = pluginAtMarketplace.slice(0, idx);
  const marketplaceName = pluginAtMarketplace.slice(idx + 1);

  // For per-plugin focus, mode is a HINT not a hard filter. The user's intent
  // with `cpd check <plugin>@<mp>` is "find this plugin and tell me about it"
  // — they don't care which mode it lives in. If the requested mode doesn't
  // have the plugin, fall through to the other mode rather than report
  // "not installed". The mode hint is preserved when the plugin IS in that
  // mode (e.g. for plugins installed in both, the requested mode wins).
  const requestedMode = (scanOpts.mode ?? "all") as "all" | "ccd" | "cowork" | "auto" | undefined;

  // Find a plugin in a V05ScanResult by either:
  //   - exact id match in `plugins[]` (CCD-style installed_plugins.json id), OR
  //   - plugin-name match in `rpmPlugins[]` (Cowork's "Personal plugins" UI path,
  //     which uses RPM and may record a different marketplace alias than CCD).
  function findInReport(r: V05ScanResult): {
    plugin?: PluginReport;
    rpm?: import("../types.js").RpmReport;
  } {
    const plugin = r.plugins.find((p) => p.id === pluginAtMarketplace);
    if (plugin) return { plugin };
    const rpm = r.rpmPlugins.find((p) => p.name === pluginName);
    if (rpm) return { rpm };
    return {};
  }

  // B1: suppress human done line for the primary scan — the CLI wrapper emits
  // a consolidated check-specific done line (no marketplace/plugin/stale counts).
  let fullReport = await runV05Scan({ ...scanOpts, suppressHumanDone: true });
  let plugin = fullReport.plugins.find((p) => p.id === pluginAtMarketplace);
  let marketplace = fullReport.marketplaces.find((m) => m.name === marketplaceName);
  let rpmMatch: V05CheckReport["rpmMatch"];

  // Build an RpmCandidateForDisambiguation from an RpmReport.
  function makeRpmCandidate(rpm: import("../types.js").RpmReport): RpmCandidateForDisambiguation {
    return {
      pluginId: rpm.pluginId,
      name: rpm.name ?? pluginName,
      marketplaceName: rpm.marketplaceName ?? "(unknown)",
      ...(rpm.marketplaceId !== undefined ? { marketplaceId: rpm.marketplaceId } : {}),
      suggestedDisambiguatedId: `${rpm.name ?? pluginName}@${rpm.marketplaceName ?? "(unknown)"}`,
    };
  }

  // Check RPM-name match in the primary scan. If found, the plugin IS installed
  // in the requested mode (just via RPM), so we should NOT fall back.
  // Change: use filter instead of find to detect multi-match (item 4.1).
  let rpmMatchAmbiguous: V05CheckReport["rpmMatchAmbiguous"];
  if (!plugin) {
    const rpmMatches = fullReport.rpmPlugins.filter((p) => p.name === pluginName);
    if (rpmMatches.length === 1) {
      const rpm = rpmMatches[0] as import("../types.js").RpmReport;
      rpmMatch = {
        rpmPlugin: rpm,
        ...(rpm.marketplaceName !== undefined && rpm.marketplaceName !== marketplaceName
          ? { marketplaceAliasDiffers: { typedAs: marketplaceName, actual: rpm.marketplaceName } }
          : {}),
      };
    } else if (rpmMatches.length >= 2) {
      // Primary mode has ≥2 matches — ambiguous; emit disambiguation block.
      rpmMatchAmbiguous = { candidates: rpmMatches.map(makeRpmCandidate) };
    }
  }

  // Fallback: if not found in EITHER plugins[] OR rpmPlugins[] AND the user
  // explicitly scoped to one mode, try the other mode.
  if (
    !plugin &&
    !rpmMatch &&
    !rpmMatchAmbiguous &&
    (requestedMode === "ccd" || requestedMode === "cowork")
  ) {
    const fallbackMode = requestedMode === "ccd" ? "cowork" : "ccd";
    // B1: fallback scan suppresses NDJSON (one-event-per-cpd-check-invocation contract)
    // and the human done line (CLI wrapper consolidates).
    const fallbackReport = await runV05Scan({
      ...scanOpts,
      mode: fallbackMode,
      silentNdjson: true,
      suppressHumanDone: true,
    });
    const found = findInReport(fallbackReport);
    if (found.plugin || found.rpm) {
      // Found in the other mode — use that report. Annotate the implicit fallback
      // for the renderer to surface as a hint.
      fullReport = fallbackReport;
      plugin = found.plugin;
      marketplace = fallbackReport.marketplaces.find((m) => m.name === marketplaceName);
      if (found.rpm) {
        rpmMatch = {
          rpmPlugin: found.rpm,
          ...(found.rpm.marketplaceName !== undefined &&
          found.rpm.marketplaceName !== marketplaceName
            ? {
                marketplaceAliasDiffers: {
                  typedAs: marketplaceName,
                  actual: found.rpm.marketplaceName,
                },
              }
            : {}),
        };
      }
      // Stash the original requested mode so the renderer can surface
      // "you asked for X but it's installed in Y" as a hint.
      (
        fullReport as V05ScanResult & { _modeFallback?: { requested: string; foundIn: string } }
      )._modeFallback = {
        requested: requestedMode,
        foundIn: fallbackMode,
      };
    } else {
      // Not found in primary; check fallback for ≥2 RPM matches (item 4.1 fallback case).
      const fallbackRpmMatches = fallbackReport.rpmPlugins.filter((p) => p.name === pluginName);
      if (fallbackRpmMatches.length >= 2) {
        // Fallback has ≥2 RPM matches — emit both _modeFallback and disambiguation.
        fullReport = fallbackReport;
        rpmMatchAmbiguous = { candidates: fallbackRpmMatches.map(makeRpmCandidate) };
        (
          fullReport as V05ScanResult & { _modeFallback?: { requested: string; foundIn: string } }
        )._modeFallback = {
          requested: requestedMode,
          foundIn: fallbackMode,
        };
      }
    }
  }

  // Exit code: RPM-only matches use rpm_copy layer status from layer5.
  // Ambiguous RPM match → 64 (E_USAGE — multiple matches; pick one).
  let exitCode: 0 | 2 | 3 | 64;
  if (rpmMatchAmbiguous) {
    exitCode = 64;
  } else if (plugin) {
    exitCode = computeV05PluginExitCode(plugin, marketplace);
  } else if (rpmMatch) {
    const rpmStatus = rpmMatch.rpmPlugin.layer5.status;
    const hasCmd = rpmMatch.rpmPlugin.layer5.recommendation?.cmd !== undefined;
    if (rpmStatus === "stale" || rpmStatus === "missing") {
      exitCode = hasCmd ? 2 : 3;
    } else {
      exitCode = 0;
    }
  } else {
    exitCode = 2; // not installed anywhere
  }

  return {
    schemaVersion: "1.0",
    pluginId: pluginAtMarketplace,
    ...(plugin ? { plugin } : {}),
    ...(marketplace ? { marketplace } : {}),
    ...(rpmMatch ? { rpmMatch } : {}),
    ...(rpmMatchAmbiguous ? { rpmMatchAmbiguous } : {}),
    fullReport,
    exitCode,
    runId: fullReport.runId,
    startedAt: fullReport.startedAt,
    finishedAt: fullReport.finishedAt,
    ...(fullReport.logFile ? { logFile: fullReport.logFile } : {}),
  };
}
