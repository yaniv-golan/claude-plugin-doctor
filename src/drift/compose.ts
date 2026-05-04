/**
 * Drift composer — tier E, phase 5.
 *
 * Aggregates inputs from tiers A-D into a flat list of Drift items. This is
 * the single entry point for drift detection in the v1.0 architecture.
 *
 * Source of truth: SPEC-v1.0.md §7.4 + §7.4.1.
 */

import { preferredScope } from "../installed-plugins.js";
import { marketplaceRefKey, pluginRefKey, rootRefKey, rpmKey, stripRootSuffix } from "../refs.js";
import type { UiEvidence } from "../state/verify-in-ui-state.js";
import type {
  BackendUiDrift,
  CacheSnapshot,
  CliUpdateSim,
  DesktopBadgeSim,
  Drift,
  MarketplaceRef,
  MarketplaceRefKey,
  PluginRef,
  PluginRefKey,
  RuntimeBoundary,
  SessionStartSim,
  Topology,
  UpstreamProbeResult,
  VersionDrift,
} from "../types.js";
import { detectBackendUiDrift } from "./backend-ui.js";
import { deriveChangedSurfaces } from "./changed-surfaces.js";
import { detectResolverDisagreement } from "./disagreement.js";
import { detectRegistrationDrift } from "./registration.js";
import { computeRuntimeBoundary } from "./runtime-refresh-table.js";
import { detectMarketplaceUpdateBroken } from "./traps/marketplace-update-broken.js";
import { detectSessionBloat } from "./traps/session-bloat.js";
import { detectSkillsPluginStuck } from "./traps/skills-plugin-stuck.js";
import { detectSourceAdvisory } from "./traps/source-advisory.js";
import { detectVersionTraps } from "./traps/version-traps.js";

export type ComposerInput = {
  topology: Topology;
  cacheSnapshots: CacheSnapshot[];
  upstreams: Record<PluginRefKey | MarketplaceRefKey, UpstreamProbeResult>;
  resolvers: Record<
    PluginRefKey,
    {
      cli: CliUpdateSim;
      badge: DesktopBadgeSim;
      session: SessionStartSim;
    }
  >;
  /** Optional: injected UI evidence for backend-ui-drift detection (phase 8). */
  uiEvidence?: UiEvidence;
  /** Max age in days for UI evidence before flagging as stale (default: 7). */
  uiEvidenceMaxAgeDays?: number;
};

/** Stable dedup key per drift. Used internally and exported for tests. */
export function dedupKey(d: Drift): string {
  switch (d.kind) {
    case "registration-drift":
      return `${d.kind}:${d.scope}:${d.name}${d.marketplace ? `@${d.marketplace}` : ""}`;
    case "marketplace-update-broken":
      return `${d.kind}:${marketplaceRefKey(d.subject.ref)}`;
    case "session-bloat-cleanup-eligible":
    case "skills-plugin-stuck":
      return `${d.kind}:${rootRefKey(d.subject.ref)}${"skill" in d ? `:${d.skill}` : ""}`;
    case "backend-ui-drift":
      return `${d.kind}:${pluginRefKey((d as BackendUiDrift).subject.ref)}`;
    default:
      return `${d.kind}:${pluginRefKey((d.subject as { ref: PluginRef }).ref)}`;
  }
}

/**
 * Composes all drift items from tier A-D inputs.
 *
 * Steps (per §7.4):
 *   1. Partition cacheSnapshots by subject kind.
 *   2. For each marketplace → detectMarketplaceUpdateBroken.
 *   3. For each plugin → detectVersionTraps, detectSourceAdvisory,
 *      detectResolverDisagreement, RuntimeBoundary.
 *   4. For each skill snapshot → detectSkillsPluginStuck.
 *   5. detectSessionBloat from topology.sessionLocals.
 *   6. detectRegistrationDrift from topology.
 *   7. Flatten, deduplicate, return.
 *
 * Empty topology (no roots) yields [].
 * Missing upstreams entries treated as unreachable.
 * Missing resolvers entries suppress resolver-disagreement for that plugin.
 */
export function composeDrift(input: ComposerInput): Drift[] {
  const { topology, cacheSnapshots, upstreams, resolvers, uiEvidence, uiEvidenceMaxAgeDays } =
    input;

  // ── 1. Partition snapshots by subject kind ───────────────────────────────

  const byMarketplaceRefKey = new Map<MarketplaceRefKey, CacheSnapshot[]>();
  const byPluginRefKey = new Map<PluginRefKey, CacheSnapshot[]>();
  // rpm key: `rpm:<rootRefKey>:<pluginId>`
  const byRpm = new Map<string, CacheSnapshot[]>();
  // skill snapshots handled separately
  const skillSnapshots: Extract<CacheSnapshot, { layer: "skills_plugin" }>[] = [];

  for (const snap of cacheSnapshots) {
    const { subject } = snap;
    if (subject.kind === "marketplace") {
      const key = marketplaceRefKey(subject.ref);
      const list = byMarketplaceRefKey.get(key) ?? [];
      list.push(snap);
      byMarketplaceRefKey.set(key, list);
    } else if (subject.kind === "plugin") {
      const key = pluginRefKey(subject.ref);
      const list = byPluginRefKey.get(key) ?? [];
      list.push(snap);
      byPluginRefKey.set(key, list);
    } else if (subject.kind === "rpm-plugin") {
      const rootSnap = snap.rootRef;
      const key = rpmKey(rootSnap, subject.pluginId);
      const list = byRpm.get(key) ?? [];
      list.push(snap);
      byRpm.set(key, list);
    } else if (subject.kind === "skill") {
      if (snap.layer === "skills_plugin") {
        skillSnapshots.push(snap as Extract<CacheSnapshot, { layer: "skills_plugin" }>);
      }
    }
  }

  const allDrifts: Drift[] = [];

  // ── 2. Marketplace traps ─────────────────────────────────────────────────

  for (const [mpKey, snaps] of byMarketplaceRefKey) {
    const cloneSnap = snaps.find((s) => s.layer === "marketplace_clone");
    if (!cloneSnap || cloneSnap.layer !== "marketplace_clone") continue;

    const mpRef: MarketplaceRef = (
      cloneSnap.subject as { kind: "marketplace"; ref: MarketplaceRef }
    ).ref;
    const upstream = upstreams[mpKey] ?? { status: "unreachable", reason: "no-probe" };

    const mpTrap = detectMarketplaceUpdateBroken({
      marketplaceRef: mpRef,
      cloneSnapshot: cloneSnap.data,
      upstream,
    });
    if (mpTrap) allDrifts.push(mpTrap);
  }

  // ── 3. Plugin traps ──────────────────────────────────────────────────────

  for (const [pkKey, snaps] of byPluginRefKey) {
    const installSnap = snaps.find((s) => s.layer === "install_snapshot");
    if (!installSnap || installSnap.layer !== "install_snapshot") continue;

    const pluginRef: PluginRef = (installSnap.subject as { kind: "plugin"; ref: PluginRef }).ref;
    const installData = installSnap.data;

    // Find marketplace clone for this plugin's marketplace.
    const mpRef: MarketplaceRef = { marketplace: pluginRef.marketplace, root: pluginRef.root };
    const mpKey = marketplaceRefKey(mpRef);
    const mpSnaps = byMarketplaceRefKey.get(mpKey);
    const cloneSnap = mpSnaps?.find((s) => s.layer === "marketplace_clone");
    const cloneData = cloneSnap?.layer === "marketplace_clone" ? cloneSnap.data : undefined;

    // Bug fix: marketplace upstream probes are keyed by marketplaceRefKey,
    // not pluginRefKey. The previous lookup `upstreams[pkKey]` always missed
    // and `upstream.status` stayed "unreachable" — which meant
    // `marketplaceCloneStatus` was never "fresh"/"stale" and the version-trap
    // detector (refresh-needed / bump-needed / badge-only-needed) silently
    // never fired. Symptom in user-facing output: `cpd scan` produced 3
    // recommendations for a machine where `cpd list` (which uses a separate
    // detection path) produced 11. Use mpKey to look up the correct probe.
    const upstream = upstreams[mpKey] ?? { status: "unreachable", reason: "no-probe" };

    // Determine marketplace clone status for version traps.
    let marketplaceCloneStatus: "fresh" | "stale" | "unknown" = "unknown";
    if (cloneData) {
      if (upstream.status === "fresh" && cloneData.headLocal !== undefined) {
        marketplaceCloneStatus = cloneData.headLocal === upstream.head ? "fresh" : "stale";
      }
    }

    // Pull the canonical installed scope (audit issue #12). Unified through
    // the shared helper so the v0.5 and v1.0 paths can't drift apart.
    const canonical =
      installData.scopes.length > 0 ? preferredScope({ scopes: installData.scopes }) : undefined;

    const installedVersion = canonical?.version;
    const installedGitCommitSha = canonical?.gitCommitSha;

    const resolverEntry = resolvers[pkKey];

    if (resolverEntry) {
      const { cli, badge, session } = resolverEntry;

      // Source advisories (npm / unsupported).
      const advisories = detectSourceAdvisory({
        pluginRef,
        pluginEntrySourceKind: installData.pluginEntrySourceKind,
      });
      allDrifts.push(...advisories);

      // Version traps (only when source is not advisory-only).
      // Only run version-trap detection on source kinds where we actually
      // have a comparable upstream + installed git-commit pair. The failure
      // modes ("npm", "not-probed-by-cpd", "unrecognized-source-kind",
      // "clone-unreadable") all lack at least one of those signals, so
      // the trap detector would either no-op or produce nonsense.
      // Enumerated positively (rather than the previous exclusion list) so
      // future additions to PluginEntrySourceKind have to be classified
      // explicitly — no silent default-on for new kinds.
      const probedKind = installData.pluginEntrySourceKind;
      const isProbedKind =
        probedKind === "string" ||
        probedKind === "github" ||
        probedKind === "git-subdir" ||
        probedKind === "url";
      if (isProbedKind) {
        const versionTraps = detectVersionTraps({
          pluginRef,
          cli,
          badge,
          ...(cloneData !== undefined && { marketplaceClone: cloneData }),
          marketplaceCloneStatus,
          ...(installedVersion !== undefined && { installedVersion }),
          ...(installedGitCommitSha !== undefined && { installedGitCommitSha }),
        });
        allDrifts.push(...versionTraps);
      }

      // Resolver disagreement.
      const disagreement = detectResolverDisagreement({
        pluginRef,
        cli,
        badge,
        sessionStart: session,
      });
      if (disagreement) allDrifts.push(disagreement);

      // VersionDrift — emit when installed and resolved versions differ or are
      // incomparable (one defined, other not). Uses Intl.Collator with
      // numeric:true for natural semver ordering ("1.10" > "1.9"). No semver dep.
      {
        const cliResolved = cli.resolvedVersion;
        if (cliResolved !== undefined && installedVersion !== undefined) {
          if (cliResolved !== installedVersion) {
            const cmp = new Intl.Collator(undefined, {
              numeric: true,
              sensitivity: "base",
            }).compare(cliResolved, installedVersion);
            const ahead: VersionDrift["ahead"] = cmp > 0 ? "upstream" : "installed";
            allDrifts.push({
              kind: "version-drift",
              subject: { kind: "plugin", ref: pluginRef },
              upstreamVersion: cliResolved,
              installedVersion,
              ahead,
            });
          }
          // equal → no version-drift emitted (ahead: "equal" case suppressed per spec)
        } else if (cliResolved !== undefined || installedVersion !== undefined) {
          // One is defined, the other isn't — incomparable.
          allDrifts.push({
            kind: "version-drift",
            subject: { kind: "plugin", ref: pluginRef },
            ...(cliResolved !== undefined ? { upstreamVersion: cliResolved } : {}),
            ...(installedVersion !== undefined ? { installedVersion } : {}),
            ahead: "incomparable",
          });
        }
      }

      // Runtime boundary — derive changed surfaces. We currently lack structured
      // installed vs. resolved plugin.json in the compose input, so the helper
      // returns the conservative `all-surfaces` fallback every time. Emitting
      // `runtime-boundary` from that fallback would tell the user to restart
      // Claude Desktop on every plugin every scan, which is noise. Suppress
      // the emission until tier D can plumb real plugin.json snapshots through;
      // when that lands, `provenance === "diff-installed-vs-resolved"` and this
      // guard becomes a no-op.
      const { surfaces, provenance } = deriveChangedSurfaces({});
      if (provenance === "diff-installed-vs-resolved") {
        const refreshBy = computeRuntimeBoundary(surfaces);
        if (refreshBy !== null) {
          const boundary: RuntimeBoundary = {
            kind: "runtime-boundary",
            subject: { kind: "plugin", ref: pluginRef },
            changedSurfaces: surfaces,
            changedSurfacesSource: provenance,
            refreshBy,
          };
          allDrifts.push(boundary);
        }
      }
    } else {
      // No resolver entry — still emit source advisories.
      const advisories = detectSourceAdvisory({
        pluginRef,
        pluginEntrySourceKind: installData.pluginEntrySourceKind,
      });
      allDrifts.push(...advisories);
    }
  }

  // ── 4. Skills-plugin-stuck ───────────────────────────────────────────────

  for (const snap of skillSnapshots) {
    const trap = detectSkillsPluginStuck(snap);
    if (trap) allDrifts.push(trap);
  }

  // ── 5. Session bloat ─────────────────────────────────────────────────────

  const bloatTraps = detectSessionBloat({ sessionLocals: topology.sessionLocals });
  allDrifts.push(...bloatTraps);

  // ── 6. Registration drift ────────────────────────────────────────────────

  const regDrifts = detectRegistrationDrift(topology);
  allDrifts.push(...regDrifts);

  // ── 7. Backend-ui-drift (phase 8) ───────────────────────────────────────

  if (uiEvidence) {
    for (const [pkKey, resolverEntry] of Object.entries(resolvers)) {
      // verify-in-ui is cross-root by design — its CLI persists evidence
      // under the root-less form `<plugin>@<marketplace>` so a single
      // observation can serve every root the plugin appears in. Resolver
      // keys here are the root-aware `<plugin>@<marketplace>#<rootKey>`
      // form; fall back to the unqualified key when the root-aware lookup
      // misses (audit issue #6).
      const observation =
        uiEvidence.observations[pkKey] ?? uiEvidence.observations[stripRootSuffix(pkKey)];
      if (!observation) continue;

      // Find the plugin ref from the snapshots for this key.
      const snaps = byPluginRefKey.get(pkKey);
      const installSnap = snaps?.find((s) => s.layer === "install_snapshot");
      if (!installSnap || installSnap.layer !== "install_snapshot") continue;

      const pluginRef = (installSnap.subject as { kind: "plugin"; ref: PluginRef }).ref;
      const drift = detectBackendUiDrift({
        pluginRef,
        observation,
        cliResolved: resolverEntry.cli,
        ...(uiEvidenceMaxAgeDays !== undefined ? { maxAgeDays: uiEvidenceMaxAgeDays } : {}),
      });
      if (drift) allDrifts.push(drift);
    }
  }

  // ── 8. Deduplicate ───────────────────────────────────────────────────────

  const seen = new Set<string>();
  const result: Drift[] = [];
  for (const d of allDrifts) {
    const key = dedupKey(d);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(d);
    }
  }

  return result;
}
