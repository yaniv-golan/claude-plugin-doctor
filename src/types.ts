// ───────── Core identifiers (SPEC-v1.0.md §2.1) ─────────
//
// Two type families coexist in this file:
//   - Below: the root-aware ref types (PluginRef, MarketplaceRef, …) and
//     the scan-report machinery built on top of them. This is the wire
//     shape `cpd scan --json` emits.
//   - Further down: a smaller set of types (Layer, CheckResult,
//     PluginReport, MarketplaceReport, RpmReport) used by the per-command
//     reporters for `refresh`, `list`, `watch`, and `check`. Those
//     commands still emit the older shape on the wire; the scan path
//     does not.

/** Where a piece of plugin/marketplace state lives. Discriminated. */
export type RootRef =
  | { kind: "ccd" }
  | { kind: "cowork"; accountId: string; orgId: string }
  | { kind: "skills-plugin-pair"; orgId: string; accountId: string };

/** A fully-qualified plugin location. Same `<plugin>@<marketplace>` can
 *  have distinct entries under different roots; this type disambiguates. */
export type PluginRef = {
  pluginName: string;
  marketplace: string;
  root: RootRef;
};

/** Display-only string form: "<plugin>@<marketplace>" (across roots). Used
 *  in human output and as map keys ONLY when the values are themselves
 *  per-root collections. Never use as a flat key in a multi-root scan. */
export type PluginIdString = string;

/** Stable, root-aware string form. Format: "<plugin>@<marketplace>#<rootKey>"
 *  where rootKey is "ccd", "cowork:<acc>:<org>", or "skp:<org>:<acc>".
 *  Use this as a map/record key in any per-root data structure (JSON output,
 *  drift composer inputs). */
export type PluginRefKey = string;

/** A registered marketplace at a specific root. */
export type MarketplaceRef = {
  marketplace: string;
  root: RootRef;
};

/** Stable, root-aware string form for marketplaces. Format:
 *  "<marketplace>#<rootKey>". Used wherever upstream probes or caches
 *  are keyed by marketplace rather than plugin. */
export type MarketplaceRefKey = string;

// ───────── Per-layer check types (used by tier C and the non-scan commands) ──
// These types are referenced by per-layer check functions
// (checkInstallSnapshot, checkMarketplaceClone, etc.) and by the report
// shapes for `refresh`, `list`, `watch`, and `check`. The aggregate
// `cpd scan --json` shape lives further down (`ScanReport`) and does not
// use these types directly.

export type Layer =
  | "marketplace_clone"
  | "install_snapshot"
  | "cowork_mirror"
  | "rpm_copy"
  | "ccd_remote_ssh";

export const ALL_LAYERS: readonly Layer[] = [
  "marketplace_clone",
  "install_snapshot",
  "cowork_mirror",
  "rpm_copy",
  "ccd_remote_ssh",
] as const;

export type CheckStatus = "fresh" | "stale" | "missing" | "skipped" | "unknowable";

export type Recommendation = {
  action: string;
  reason: string;
  risk: "safe" | "destructive";
  cmd?: string;
};

// Per-(plugin, layer) check record used by refresh.ts, check.ts, list.ts,
// watch.ts and their tests. The scan command does not emit these directly;
// it builds `Drift[]` and `RecommendedAction[]` instead. Both shapes are
// public on the wire; consumers should branch on which command they ran.
export type CheckResult = {
  plugin: string;
  layer: Layer;
  status: CheckStatus;
  detail: string;
  evidence: Record<string, unknown>;
  recommendation?: Recommendation;
};

export type Mode = "ccd" | "cowork";

export type CoworkRootInfo = {
  path: string;
  accountId: string;
  orgId: string;
  installedPluginsMtime?: number;
  /** mtime (ms epoch) of `rpm/manifest.json`. Considered alongside
   *  `installedPluginsMtime` when picking the active root — Personal-plugins
   *  installs touch only this file, not installed_plugins.json. */
  rpmManifestMtime?: number;
};

// MarketplaceReport / PluginReport / RpmReport — used by refresh, list,
// and watch commands and their tests. The scan command emits a different
// aggregate shape (`ScanReport`, defined further down).
export type MarketplaceReport = {
  name: string;
  sourceType: "github" | "git" | "directory" | "remote" | "unknown";
  sourceDetail: string;
  layer1: CheckResult;
  integrityIssues: string[];
  /** Multi-source declaration attribution. Populated when the marketplace
   *  was discovered via the merged inventory (known_marketplaces.json +
   *  extraKnownMarketplaces from settings sources, see
   *  `src/discovery/extra-known-marketplaces.ts`). Older code paths leave
   *  this undefined; consumers must treat undefined as "source unknown",
   *  not as "known_marketplaces only". */
  declaredIn?: SettingsSource[];
  /** True when this root has a materialized clone for the marketplace. False
   *  for settings-only declarations. When undefined, treat as "unknown" —
   *  callers that branch on `hasClone === false` (settings-only case) must
   *  use the literal-false comparison. */
  hasClone?: boolean;
};

/** Scope values from installed_plugins.json entries.
 *  `"managed"` is recognized by the CLI but silently dropped by Desktop's
 *  runtime — plugins with this scope will NOT be active in Claude Desktop.
 *  JSON-consumer note: this union widened from 4 values to 5;
 *  consumers that switch on the prior 4-value enum should add a "managed" branch. */
export type InstalledScope = "user" | "project" | "local" | "managed" | "unknown";

export type InstalledPluginScope = {
  scope: InstalledScope;
  version: string;
  installPath: string;
  gitCommitSha?: string;
  installedAt?: string;
  lastUpdated?: string;
  raw: Record<string, unknown>;
};

export type PluginReport = {
  id: string;
  marketplace: string;
  pluginName: string;
  installedVersion?: string;
  marketplaceVersion?: string;
  scopes: InstalledPluginScope[];
  checks: Record<Layer, CheckResult>;
  primaryRecommendation?: Recommendation;
};

export type RpmReport = {
  pluginId: string;
  /** Plugin name from rpm/manifest.json (the array form's `name` field).
   *  Surfaced so per-plugin lookups in `runV05Check` can match by name when
   *  the user types a CCD-style `<plugin>@<marketplace>` id but the plugin
   *  is RPM-installed in Cowork with a different marketplace alias. */
  name?: string;
  /** Marketplace name as recorded in rpm/manifest.json. May differ from the
   *  CCD `installed_plugins.json` id's marketplace component (the RPM install
   *  path uses the backend's marketplace alias, which can differ from the
   *  one a user added via `claude plugin marketplace add`). */
  marketplaceName?: string;
  /** Backend's opaque `marketplace_<id>` for the marketplace this plugin
   *  was installed from. The gist documents this as the most-stable
   *  cross-reference primitive. PRESENT only in array-form rpm/manifest.json
   *  (Cowork ≥1.x). Older object-keyed manifests don't carry it; this
   *  field stays undefined for those installs. */
  marketplaceId?: string;
  layer5: CheckResult;
};

// ───────── v1.0 Tier A — Topology (SPEC-v1.0.md §3.1) ─────────
//
// Tier A walks the user's machine once and emits a Topology. It parses
// registry/index files (known_marketplaces.json, installed_plugins.json,
// rpm/manifest.json) but NOT per-entry manifests (marketplace.json,
// plugin.json, skills-plugin per-skill manifests). See spec §3.4.

/** Where a marketplace entry was declared. `known_marketplaces.json` is the
 *  classic on-disk path; the rest are settings-side `extraKnownMarketplaces`
 *  declarations introduced in CLI 2.1.131 (gist revision 2026-05-06T11:45:05Z).
 *  A single entry can be declared in multiple sources at once (e.g. a managed
 *  policy that has been materialized into a local clone via `marketplace add`
 *  carries both `policySettings` and `known_marketplaces`). */
export type SettingsSource =
  | "known_marketplaces"
  | "userSettings"
  | "projectSettings"
  | "localSettings"
  | "coworkSettings"
  | "policySettings";

/** One entry from a parsed known_marketplaces.json. Tier A reads this index;
 *  tier C reads the per-marketplace marketplace.json files inside the clone. */
export type KnownMarketplaceEntry = {
  name: string;
  source: { kind: string; raw: unknown };
  installLocation?: string;
  /** ms epoch; needed for marketplace-update-broken trap detection. */
  lastUpdated?: number;
  raw: Record<string, unknown>;
  /** Multi-source attribution. Always non-empty when populated by the merge
   *  pass in `src/discovery/extra-known-marketplaces.ts`. Older code paths
   *  that haven't been migrated may leave this undefined; consumers must
   *  treat undefined as "unknown source" rather than "known_marketplaces only". */
  declaredIn?: SettingsSource[];
  /** True when this root has a materialized clone for the marketplace. False
   *  for settings-only declarations (no `installLocation` or no on-disk dir).
   *  Drift detection that compares against a clone (`marketplace-update-broken`,
   *  `refresh-needed`, missing-clone synthesis) MUST guard on this. */
  hasClone?: boolean;
};

export type CcdRoot = {
  pluginsRoot: string;
  knownMarketplacesPath: string;
  installedPluginsPath: string;
  installedPluginsMtime?: number;
  marketplacesDir: string;
  cacheDir: string;
  /** Parsed known_marketplaces.json index. Populated by tier A. */
  marketplaces: KnownMarketplaceEntry[];
};

export type CoworkRoot = {
  accountId: string;
  orgId: string;
  rootPath: string;
  hasCoworkPlugins: boolean;
  hasRpm: boolean;
  knownMarketplacesPath?: string;
  installedPluginsPath?: string;
  rpmManifestPath?: string;
  installedPluginsMtime?: number;
  /** mtime (ms epoch) of `rpm/manifest.json`. Considered alongside
   *  `installedPluginsMtime` when picking the active root — Personal-plugins
   *  installs touch only this file, not installed_plugins.json. */
  rpmManifestMtime?: number;
  /** mtime-based active-root flag — set per root rather than picking one.
   *  Computed from max(installedPluginsMtime, rpmManifestMtime). */
  isMostRecent: boolean;
  coworkSettingsPath?: string;
  /** Same parsed-index rationale as CcdRoot. Empty array when
   *  knownMarketplacesPath is undefined or absent. */
  marketplaces: KnownMarketplaceEntry[];
  /** Per-session feature-gate sidecars (`local_<UUID>.json`). Sparse:
   *  most session JSONs do not carry the gate fields. Empty array when
   *  none were found. Sorted by `lastActivityAt desc`. Capped at 2048
   *  per root; truncation surfaced via `sessionConfigsTruncated`. */
  sessionConfigs?: SessionConfig[];
  /** True when the 2048-file cap was hit while enumerating sessionConfigs.
   *  Caller emits a `session-config-enumeration-truncated` advisory. */
  sessionConfigsTruncated?: boolean;
  /** Number of `local_*.json` files seen (may exceed cap). */
  sessionConfigsTotalScanned?: number;
};

/** Per-session config sidecar at
 *  `<userData>/local-agent-mode-sessions/<acc>/<org>/local_<UUID>.json`.
 *  Carries top-level fields including the sparse-optional `pluginsEnabled` /
 *  `skillsEnabled` gates that turn whole subsystems off at session start.
 *  Per gist revision 2026-05-06T11:27:26Z §"Per-session feature gates". */
export type SessionConfig = {
  filePath: string;
  sessionId?: string;
  /** Sparse-optional: only present when the user toggled away from the
   *  default-true. Absent === default-on. */
  pluginsEnabled?: boolean;
  /** Same shape as pluginsEnabled. When false, the session manager logs
   *  `[LocalAgentModeSessionManager] skillsEnabled=false — skipping
   *  list_skills/save_skill/propose_skills`. */
  skillsEnabled?: boolean;
  isArchived?: boolean;
  lastActivityAt?: string;
  title?: string;
};

/** Tier A enumerates skill DIRS only — no manifest content parsing.
 *  Manifest-content fields (e.g. manifestUpdatedAt) are added by tier C. */
export type SkillsPluginSkill = {
  skillName: string;
  dirPath: string;
  hasSkillMd: boolean;
  dirMtime?: number;
  /** True when the skill is one of the three hard-coded built-in skills
   *  (`schedule`, `setup-cowork`, `consolidate-memory`) bundled into Desktop
   *  and rewritten on every sync via `_writeBuiltInSkillsTo`. These cannot go
   *  stuck via the API-download path. Populated by tier C's skills-plugin
   *  reader using BUILTIN_SKILLS. Additive: undefined is equivalent to
   *  false for consumers that haven't adopted the new field yet. */
  isBuiltIn?: boolean;
  /** True when the skill is a LOCAL-ONLY user-created skill — authored via
   *  Desktop's `saveLocalSkill` IPC's local-save branch and never uploaded.
   *  Manifest tags: `creatorType: "user"` AND **literal** `syncManaged: false`
   *  (conjunction; either alone does NOT qualify). These skills are
   *  renderer-owned and never go through the API-download/cleanup pass, so
   *  they're exempt from the stuck-failure trap analogously to built-ins.
   *
   *  **Note**: skills the user *uploaded* via `saveLocalSkill`'s upload branch
   *  (`save_skill` API) re-enter the regular sync cycle and ARE subject to
   *  the silent-stale bug — they retain `creatorType: "user"` but flip
   *  `syncManaged` to `true`, and therefore will NOT carry this flag.
   *
   *  Populated by tier C's skills-plugin reader; the v0.5 list path in
   *  `commands/scan.ts` mirrors the population so JSON output is correct on
   *  that path too. Additive: undefined is equivalent to false for older
   *  consumers. */
  isUserCreated?: boolean;
};

export type SkillsPluginPair = {
  orgId: string;
  accountId: string;
  rootPath: string;
  manifestPath?: string;
  manifestMtime?: number;
  skills: SkillsPluginSkill[];
};

export type SkillsPluginRoot = {
  rootPath: string;
  /** <orgId>/<accountId>/ pairs — INVERTED order vs cowork's <acc>/<org>. */
  pairs: SkillsPluginPair[];
};

export type SessionLocalDir = {
  kind: "session-local" | "ditto-bridge-history";
  pathOnDisk: string;
  /** Which (acc, org) it lives under. */
  parentRoot: string;
  uuid?: string;
  orgUuid?: string;
  /** Generation number for ditto _g<N> dirs. */
  generation?: number;
  lastModified: number;
  approxSizeBytes: number;
};

export type Topology = {
  ccd?: CcdRoot;
  cowork: CoworkRoot[];
  skillsPlugin?: SkillsPluginRoot;
  sessionLocals: SessionLocalDir[];
  scannedAt: string;
};

/** TopologyReport — JSON output for `cpd topology` debug subcommand.
 *  Carries `schemaVersion: "1.0"` like every other report.
 *  Future-additive only per §10.4 stability policy. */
export type TopologyReport = {
  schemaVersion: "1.0";
  runId: string;
  topology: Topology;
  exitCode: 0 | 1;
  logFile?: string;
};

// ───────── v1.0 Tier F — Recommendations (SPEC-v1.0.md §8) ─────────

export type DriftRef = {
  kind: Drift["kind"];
  pluginRefKey?: PluginRefKey;
  marketplaceRefKey?: MarketplaceRefKey;
  rootRefKey?: string;
};

export type PostActionAdvisory =
  | "new-task-required"
  | "ui-restart-required"
  | "verify-in-ui"
  | "manual-step";

/** Typed executor recipe — the fix runner switches on `recipe.kind` and
 *  constructs argv from typed fields. Never parsed from `cmd` (which stays
 *  a single executable command line per the existing CLI contract;
 *  `recipes` is the authoritative typed surface).
 *
 *  This union is part of the wire baseline so catalog fixtures don't have
 *  to be re-emitted when the runner consumes it. New kinds are additive. */
export type ActionRecipe =
  // claude plugin <verb> — official CLI delegations
  | {
      kind: "claude_plugin_install";
      plugin: string;
      marketplace: string;
      scope?: InstalledScope;
    }
  | {
      kind: "claude_plugin_update";
      plugin: string;
      marketplace: string;
      scope?: InstalledScope;
    }
  | {
      kind: "claude_plugin_uninstall";
      plugin: string;
      marketplace: string;
      scope?: InstalledScope;
    }
  | { kind: "claude_plugin_marketplace_update"; marketplace: string }
  | { kind: "claude_plugin_marketplace_remove"; marketplace: string }
  | {
      kind: "claude_plugin_marketplace_add";
      /** Source URL/path. Per gist revision 2026-05-06T11:45:05Z, the CLI
       *  takes `<source>` only — the registered marketplace name comes from
       *  `marketplace.json#name`. Free-form aliases are legacy/manual-edit
       *  territory only. */
      source: string;
      /** New `--scope` flag introduced in CLI 2.1.131. Defaults to `user`
       *  when omitted (matching CLI default). */
      scope?: "user" | "project" | "local";
    }
  // cpd self-invocations — share the runtime via in-process function call,
  // not a subprocess shell.
  | { kind: "cpd_refresh"; marketplace: string }
  | { kind: "cpd_refresh_force_fetch"; marketplace: string }
  | {
      kind: "cpd_cache_prune_cowork_sessions";
      olderThanDays: number;
      /** When provided, restrict pruning to this cowork root. Omitted means
       *  every cowork root the scan saw. */
      coworkRoot?: { accountId: string; orgId: string };
    }
  // direct filesystem mutation — only via the shared snapshot-deleter
  // primitive (lockfile + active-version guards).
  | {
      kind: "delete_orphan_snapshot";
      absPath: string;
      pluginRef: PluginRef;
      version: string;
    }
  // non-executable categories — emitted but never run by the runner.
  | { kind: "manual"; instructions: string }
  | { kind: "advisory"; instructions: string };

export type RecommendedAction = {
  /** UNIQUE per action instance in a scan run. Treat as opaque exact-match
   *  — consumers must NOT split or parse this field. Use `conditionId` and
   *  `refs[]` / `fixes[]` for structured lookup. */
  id: string;
  /** STABLE catalog identifier in the form `<layer>:<condition>` (e.g.
   *  `marketplace_clone:update_broken`, `install_snapshot:version_drift`).
   *  Append-only — never rename an emitted value; only add new ones.
   *  Many actions in one report can share a `conditionId`. */
  conditionId: string;
  /** Plugin/marketplace ref keys this action targets. Derived from
   *  `fixes[].subject.ref` so consumers can match by plugin without parsing
   *  the opaque `id` field. Aggregated actions list every targeted ref;
   *  single-target actions have length 1; root-scoped actions (e.g.
   *  `cowork_mirror:session_bloat_cleanup_eligible`) carry an empty array. */
  refs: string[];
  ordinal: number;
  description: string;
  /** Single executable command line. Per the CLI contract (see
   *  `docs/CLI-DESIGN.md` §Recommendations), this is a runnable string —
   *  agents pipe `.recommendations[].cmd | select(.)`. Omitted for manual /
   *  advisory / multi-step actions that can't be safely encoded as one
   *  line. The fix runner does NOT parse this field — it executes from
   *  `recipes[]` instead. `cmd` remains the user-facing pipeline. */
  cmd?: string;
  /** Typed multi-step executor plan. Always non-empty (always-array because
   *  real fixes are sometimes multi-step, e.g. refresh-then-update).
   *  Populated by the catalog and synthetic recommendations in `plan.ts`.
   *  The fix runner switches on `recipe.kind` per step; step argv is
   *  derived from typed fields, never from `cmd` parsing. */
  recipes: ActionRecipe[];
  fixes: DriftRef[];
  doesNotFix: DriftRef[];
  postActionAdvisory?: PostActionAdvisory;
  risk: "safe" | "destructive";
  requiresYes: boolean;
  requiresManualStep: boolean;
};

// ───────── ScanReport (SPEC-v1.0.md §10.2) ─────────

export type ScanReport = {
  schemaVersion: "1.0";
  runId: string;
  startedAt: string;
  finishedAt: string;
  topology: Topology;
  upstreams: Record<PluginRefKey | MarketplaceRefKey, UpstreamProbeResult>;
  caches: Record<PluginRefKey, CacheSnapshot[]>;
  marketplaceCaches: Record<MarketplaceRefKey, CacheSnapshot[]>;
  rpmCaches: Record<string, CacheSnapshot[]>;
  resolvers: Record<
    PluginRefKey,
    {
      cli: CliUpdateSim;
      badge: DesktopBadgeSim;
      sessionStart: SessionStartSim;
    }
  >;
  drifts: Drift[];
  recommendations: RecommendedAction[];
  /** Per-layer inventory roll-up (count + fresh/stale/missing/skipped/
   *  unknowable). Populated by every scan; lets consumers and the human
   *  renderer's green-run summary report "found N marketplaces, M install
   *  snapshots, all fresh" without reverse-engineering the topology and
   *  caches maps. Typed optional on the wire so future schema-additive
   *  evolutions don't require a major bump. */
  summary?: ScanSummary;
  // ScanReport only ever carries success-or-drift codes. Exit codes 1 (generic
  // error) and 64 (usage) are emitted by the CLI as ErrorEnvelope, never as a
  // ScanReport. Keeping this union tight catches mistakes at compile time.
  exitCode: 0 | 2 | 3;
  logFile?: string;
};

/** Per-layer inventory roll-up. Counts are derived from `caches`,
 *  `marketplaceCaches`, `rpmCaches`, and `topology` at the end of the scan. */
export type ScanSummary = {
  perLayer: Record<Layer, LayerSummary>;
  /** Free-form advisories surfaced to the user — typically on otherwise-clean
   *  scans where there is no drift to report but the user should still know
   *  about a structural blind spot or gotcha. Additive optional field; older
   *  consumers that don't read it remain compatible. Schema stays at 1.0. */
  advisories?: ScanAdvisory[];
};

/** A user-facing advisory tied to a `cpd scan` run. Distinct from a `Drift`
 *  (which represents an observed inconsistency cpd can recommend a fix for)
 *  and a `RecommendedAction` (which is the recommended fix). Advisories
 *  flag situations cpd cannot directly observe but the user should know
 *  about — e.g. plugin loads via `--plugin-dir` / `--plugin-url` that bypass
 *  every layer cpd walks.
 *
 *  Discriminated union by `id`. `id` values are append-only across versions;
 *  never rename an emitted value once shipped. New ids extend the union.
 *  Consumers that read only `message` are unaffected by id additions; those
 *  that switch on `id` should add a default case that surfaces the message
 *  even for unknown ids. */
export type ScanAdvisory =
  | {
      id: "clean-scan-runtime-blind-spots";
      severity: "info";
      message: string;
    }
  | {
      id: "session-plugins-disabled-detected";
      severity: "info";
      message: string;
      details: SessionGateAdvisoryDetails;
    }
  | {
      id: "session-skills-disabled-detected";
      severity: "info";
      message: string;
      details: SessionGateAdvisoryDetails;
    }
  | {
      id: "session-config-enumeration-truncated";
      severity: "info";
      message: string;
      details: { coworkRootPath: string; capacity: number };
    };

/** Structured detail for `session-plugins-disabled-detected` /
 *  `session-skills-disabled-detected` advisories. Numerator/denominator
 *  framing is critical: `pluginsEnabled` / `skillsEnabled` are sparse-
 *  optional fields on session JSONs (only written when toggled away from
 *  default-true), so reporting "N out of M total sessions" miscounts —
 *  the meaningful denominator is `sessionsWithFieldSet`. */
export type SessionGateAdvisoryDetails = {
  /** Total session JSONs scanned (capped at 2048 per cowork root). */
  totalScanned: number;
  /** Sessions where the gate field is present at all (the meaningful
   *  denominator — sessions without the field are default-on). */
  sessionsWithFieldSet: number;
  /** Sessions where the gate is `false` and `isArchived !== true`. */
  disabledSessions: number;
  /** Up to first 3 affected session IDs, ordered by `lastActivityAt desc`.
   *  Full UUIDs in JSON output; the human renderer truncates to first 8
   *  chars to avoid leaking full IDs into shared bug reports (reviewer #4). */
  exampleSessionIds: string[];
  /** Sessions with the gate `false` but `isArchived === true`. */
  archivedDisabledCount: number;
};

export type LayerSummary = {
  /** Number of distinct subjects observed at this layer (plugins for plugin
   *  layers, marketplaces for marketplace_clone, etc.). */
  count: number;
  /** Subset that resolved fresh. */
  fresh: number;
  /** Subset flagged stale. */
  stale: number;
  /** Subset flagged missing (expected but not on disk). */
  missing: number;
  /** Subset where the layer didn't apply or the check couldn't run. */
  skipped: number;
  /** Subset where status couldn't be determined (e.g. `--no-network`
   *  blocked the upstream probe). */
  unknowable: number;
};

// ───────── logging + progress + error types ─────────

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

// The terminal signal is the `scan_done` ProgressEvent (a different shape from
// `phase_end`). Don't add a `"done"` phase here — agents would wait forever for
// a `phase_end` they never receive.
export type ScanPhase =
  | "init"
  | "resolve_paths"
  | "detect_mode"
  | "parse_known_marketplaces"
  | "parse_installed_plugins"
  | "parse_rpm_manifest"
  | "check_marketplaces"
  | "fetch_remote_versions"
  | "check_plugins"
  | "check_rpm"
  | "render"
  // refresh-only stages emitted by `cpd refresh`. `cpd scan` never emits these,
  // and `cpd refresh` never emits the inner-scan phases (silentProgress suppresses them).
  | "refresh_before_scan"
  | "refresh_claude_update"
  | "refresh_after_scan"
  // Topology discovery (SPEC-v1.0.md §10.4.3)
  | "discover_topology"
  | "discover_skills_plugin"
  | "discover_session_locals"
  // Resolver simulation
  | "simulate_resolvers"
  // Drift composition (SPEC-v1.0.md §10.4.3)
  | "compose_drift"
  // Recommendation planning
  | "plan_recommendations"
  // Tier B/C — upstream probes and cache snapshots (SPEC-v1.0.md §10.4.3)
  | "probe_upstreams"
  | "snapshot_caches"
  // Reserved for verify-in-ui (SPEC-v1.0.md §10.4.3)
  | "verify_in_ui_capture"
  // `cpd topology` debug subcommand render phase
  | "topology_render";

export const ALL_PHASES: readonly ScanPhase[] = [
  "init",
  "resolve_paths",
  "detect_mode",
  "parse_known_marketplaces",
  "parse_installed_plugins",
  "parse_rpm_manifest",
  "check_marketplaces",
  "fetch_remote_versions",
  "check_plugins",
  "check_rpm",
  "render",
  "refresh_before_scan",
  "refresh_claude_update",
  "refresh_after_scan",
  // Topology discovery
  "discover_topology",
  "discover_skills_plugin",
  "discover_session_locals",
  // Resolver simulation
  "simulate_resolvers",
  // Drift composition
  "compose_drift",
  // Recommendation planning
  "plan_recommendations",
  // Tier B/C — upstream probes and cache snapshots
  "probe_upstreams",
  "snapshot_caches",
  // Reserved for verify-in-ui
  "verify_in_ui_capture",
  // `cpd topology` debug subcommand render phase
  "topology_render",
] as const;

export type ProgressEvent =
  | { type: "phase_start"; phase: ScanPhase; ts: string; total?: number }
  | {
      type: "phase_progress";
      phase: ScanPhase;
      ts: string;
      current: number;
      total: number;
      item?: string;
    }
  | { type: "phase_end"; phase: ScanPhase; ts: string; durationMs: number }
  | {
      type: "scan_done";
      ts: string;
      durationMs: number;
      exitCode: number;
      /** Optional summary stats — populated by `runScan` after counts are
       *  known. Additive; legacy NDJSON consumers ignore unknown fields.
       *  Includes `topologyRoots`, `driftCount`, `recommendationCount` per §10.4.3.
       *  Includes `versionTrapCount` and `staleCount`; `layersStale` is kept
       *  but is deprecated (see §10.4.3 deprecation note). */
      summary?: {
        marketplaces: number;
        plugins: number;
        /** @deprecated Counts only the version-trap drift kinds
         *  (refresh-needed, bump-needed, badge-only-needed). Use `versionTrapCount`
         *  (same semantics, clearer name) or `staleCount` (broader) instead. */
        layersStale: number;
        /** Replaces `layersStale` with a clearer name. Counts drifts where
         *  kind is refresh-needed | bump-needed | badge-only-needed. */
        versionTrapCount?: number;
        /** Count of all drift kinds that represent "something stale":
         *  marketplace-update-broken, refresh-needed, bump-needed, badge-only-needed,
         *  version-drift (where ahead === "upstream"), skills-plugin-stuck,
         *  session-bloat-cleanup-eligible. */
        staleCount?: number;
        /** v1.0: total discovered topology roots (ccd + cowork + skillsPlugin). */
        topologyRoots?: number;
        /** v1.0: total Drift objects emitted by tier E. */
        driftCount?: number;
        /** v1.0: total RecommendedAction objects emitted by tier F. */
        recommendationCount?: number;
      };
    };

// ───────── v1.0 Tier B — Sources of truth (SPEC-v1.0.md §4) ─────────

export type UpstreamSource =
  | { kind: "string"; path: string }
  | { kind: "github"; repo: string; ref?: string }
  | { kind: "git"; url: string; ref?: string }
  | { kind: "url"; url: string; ref?: string }
  | { kind: "git-subdir"; url: string; path: string; ref?: string }
  | { kind: "npm"; package: string; version?: string; registry?: string }
  | { kind: "directory"; path: string }
  | { kind: "backend" }
  // Renamed from "unsupported" (was overloaded; the parser uses this kind ONLY
  // for an unrecognized `source.source` discriminator value or a malformed
  // entry shape — not for "marketplace.json couldn't be read", which is a
  // higher-layer concern).
  | { kind: "unrecognized"; raw: unknown };

export type UpstreamProbeResult =
  | {
      status: "fresh";
      head: string;
      pluginJsonVersion?: string;
      fetchedAt: string;
    }
  | { status: "no-network"; reason: "--no-network" }
  | { status: "unreachable"; reason: string }
  | {
      status: "unknowable";
      reason: "backend" | "npm-not-implemented" | "url-not-implemented";
    };

export type UpstreamProbeOpts = {
  network: boolean;
  timeoutMs: number;
  abortSignal?: AbortSignal;
};

// ───────── v1.0 Tier C — Caches (SPEC-v1.0.md §5) ─────────

export type CacheLayerKind =
  | "marketplace_clone"
  | "install_snapshot"
  | "cowork_mirror"
  | "rpm_copy"
  | "skills_plugin"
  | "ccd_remote_ssh";

export type Presence = "present" | "absent" | "n/a-for-source";

export type PluginEntrySourceKind =
  // ── Source kinds cpd recognizes and probes ───────────────────────────────
  | "string"
  | "github"
  | "git-subdir"
  | "url"
  | "npm"
  // ── Failure-mode taxonomy. Each value names the actual condition so the
  //    source-advisory detector can produce the right user-facing message
  //    — or stay silent — instead of falling back to a single "unsupported"
  //    catchall that hides the real reason. ─────────
  /** Recognized by Claude Code (e.g., `source: "directory"`, `source: "git"`,
   *  `source: "backend"`) but cpd's tier-C taxonomy doesn't probe it yet.
   *  No user advisory: this is cpd's own limitation, not a problem with the
   *  install. The optional `pluginEntrySourceUnprobedReason` evidence field
   *  carries the specific reason ("directory" | "git" | "backend") for debug
   *  observability without bloating this discriminator. */
  | "not-probed-by-cpd"
  /** The genuine "Upgrade Claude Code" condition: `source.source` is a
   *  discriminator value that neither Claude Code nor cpd recognizes (e.g.,
   *  a future `"oci"`, `"wasm"`, etc.). The marketplace was authored against
   *  a newer Claude Code than the user has installed. */
  | "unrecognized-source-kind"
  /** marketplace.json is unreadable, the plugin entry isn't present in the
   *  catalog, or the source field is corrupt — cpd has no data to classify
   *  the source. Intentionally silent at the per-plugin layer: the layer-1
   *  `marketplace_clone` failure is the canonical signal in this case, and
   *  emitting a per-plugin advisory would double-count the same root cause. */
  | "clone-unreadable";

export type MarketplaceCloneData = {
  kind: "marketplace_clone";
  marketplace: string;
  cloneRoot: string;
  marketplaceJsonPath: string;
  marketplaceJsonExists: boolean;
  parsedMarketplace?: {
    plugins: Array<{ name: string; sourceRaw: unknown; version?: string }>;
    raw: Record<string, unknown>;
  };
  headLocal?: string;
  lastUpdatedAtMs?: number;
};

export type InstallSnapshotData = {
  kind: "install_snapshot";
  pluginRef: PluginRef;
  installPath: string;
  installPathExists: boolean;
  scopes: InstalledPluginScope[];
  pluginEntrySourceKind: PluginEntrySourceKind;
  pluginEntryRaw: unknown;
};

export type CoworkMirrorData = {
  kind: "cowork_mirror";
  cowork: { accountId: string; orgId: string; rootPath: string };
  marketplaceCloneHead?: string;
  installedHere?: InstalledPluginScope;
};

export type RpmCopyData = {
  kind: "rpm_copy";
  cowork: { accountId: string; orgId: string };
  pluginId: string;
  marketplaceId?: string;
  marketplaceName?: string;
  manifestEntry?: {
    installedBy: "auto" | "user" | "unknown";
    updatedAt?: string;
    raw: Record<string, unknown>;
  };
  pluginDirPath: string;
  pluginDirExists: boolean;
};

export type SkillsPluginData = {
  kind: "skills_plugin";
  pair: { orgId: string; accountId: string; rootPath: string };
  skill: {
    name: string;
    dirPath: string;
    hasSkillMd: boolean;
    dirMtime?: number;
    /** Parsed from skills-plugin manifest by tier C. */
    manifestUpdatedAt?: string;
    manifestEntryRaw?: Record<string, unknown>;
  };
  /** Documented stuck-failure pattern from the gist:
   *  manifest claims recent update but on-disk artifact missing or much older. */
  stuckFailureSignature: boolean;
};

export type CcdRemoteSshData = { kind: "ccd_remote_ssh"; reason: "out-of-band" };

export type CacheSnapshotBase = {
  rootRef: RootRef;
  subject:
    | { kind: "plugin"; ref: PluginRef }
    | { kind: "marketplace"; ref: MarketplaceRef }
    | { kind: "rpm-plugin"; pluginId: string }
    | { kind: "skill"; pair: { orgId: string; accountId: string }; skillName: string };
  presence: Presence;
  evidencePaths: string[];
  parsedAt: string;
};

export type CacheSnapshot =
  | (CacheSnapshotBase & { layer: "marketplace_clone"; data: MarketplaceCloneData })
  | (CacheSnapshotBase & { layer: "install_snapshot"; data: InstallSnapshotData })
  | (CacheSnapshotBase & { layer: "cowork_mirror"; data: CoworkMirrorData })
  | (CacheSnapshotBase & { layer: "rpm_copy"; data: RpmCopyData })
  | (CacheSnapshotBase & { layer: "skills_plugin"; data: SkillsPluginData })
  | (CacheSnapshotBase & { layer: "ccd_remote_ssh"; data: CcdRemoteSshData });

export type CacheData = CacheSnapshot["data"];

// Stable error codes — agents and scripts may branch on these.
// Add codes by appending; never reuse or rename.
export type CpdErrorCode =
  | "E_PLATFORM_UNSUPPORTED"
  | "E_PARSE_KNOWN_MARKETPLACES"
  | "E_PARSE_INSTALLED_PLUGINS"
  | "E_PARSE_RPM_MANIFEST"
  | "E_PARSE_MARKETPLACE_JSON"
  | "E_GIT_TIMEOUT"
  | "E_USAGE"
  // Network/fetch failures
  | "E_FETCH_TIMEOUT"
  | "E_FETCH_NETWORK"
  // Manifest parse failures
  | "E_PARSE_PLUGIN_JSON"
  | "E_PARSE_SKILLS_PLUGIN_MANIFEST"
  // verify-in-ui input/evidence
  | "E_VERIFY_IN_UI_INPUT"
  | "E_UI_EVIDENCE_SCHEMA"
  // refresh --force-fetch
  | "E_FORCE_FETCH_ABORTED";

export type ErrorEnvelope = {
  ok: false;
  code: CpdErrorCode;
  message: string;
  hint?: string;
  runId?: string;
  logFile?: string;
};

// ───────── v1.0 Tier D — Resolvers (SPEC-v1.0.md §6) ─────────
//
// Pure simulators. Three of them, one per consumer surface:
//   - CLI update sim: what `claude plugin update` would install
//   - Desktop badge sim: what the Settings UI badge displays
//   - Session start sim: what the next `+ new task` would load
// All three are pure functions over typed inputs. No fs, no fetch,
// no child_process. Unit-testable from synthetic objects.

export type ResolvedFrom =
  | "plugin.json-in-clone"
  | "marketplace.json"
  | "remote-plugin.json"
  | "git-sha-12"
  | "git-sha"
  | "unknown"
  | "n/a"
  | "indeterminate-no-network";

export type CliUpdateInput = {
  pluginRef: PluginRef;
  pluginEntrySourceKind: PluginEntrySourceKind;
  marketplaceClone?: MarketplaceCloneData;
  pluginEntry: {
    name: string;
    sourceRaw: unknown;
    versionInMarketplaceJson?: string;
    sourcePath?: string;
  };
  pluginJsonInClone?: { version?: string; raw: Record<string, unknown> };
  remotePluginJsonVersion?: string;
  upstreamStatus: UpstreamProbeResult["status"];
};

export type DesktopBadgeInput = {
  pluginRef: PluginRef;
  pluginEntrySourceKind: PluginEntrySourceKind;
  marketplaceClone?: MarketplaceCloneData;
  pluginEntry: CliUpdateInput["pluginEntry"];
  pluginJsonInClone?: CliUpdateInput["pluginJsonInClone"];
  // Note: no remotePluginJsonVersion — the badge does not remote-fetch.
};

export type SessionStartInput = {
  pluginRef: PluginRef;
  installedScopes: InstalledPluginScope[];
};

export type CliUpdateSim = {
  resolvedVersion?: string;
  resolvedFrom: ResolvedFrom;
  unknowable?: { reason: string };
  evidence: {
    pluginEntrySourceKind: PluginEntrySourceKind;
    cloneRoot?: string;
    pluginJsonInClone?: string;
    marketplaceJsonVersion?: string;
    remotePluginJsonVersion?: string;
  };
};

export type DesktopBadgeSim = {
  resolvedVersion?: string;
  resolvedFrom: ResolvedFrom;
  unknowable?: { reason: string };
  evidence: {
    pluginEntrySourceKind: PluginEntrySourceKind;
    cloneRoot?: string;
    pluginJsonInClone?: string;
    marketplaceJsonVersion?: string;
    /** Always undefined — badge never remote-fetches. */
    remotePluginJsonVersion?: undefined;
  };
};

export type SessionStartSim = {
  resolvedVersion?: string;
  installedPath?: string;
  unknowable?: { reason: string };
};

// ───────── v1.0 Tier E — Drift + traps (SPEC-v1.0.md §7) ─────────

export type SurfaceKind =
  | "skill"
  | "command"
  | "agent"
  | "hook"
  | "mcp"
  | "config"
  | "plugin-itself";

export type RefreshSemantics = "in-task" | "new-task" | "ui-restart";

export type RegistrationDrift = {
  kind: "registration-drift";
  scope: "plugin" | "marketplace";
  name: string;
  marketplace?: string;
  presentIn: RootRef[];
  absentIn: RootRef[];
};

export type VersionDrift = {
  kind: "version-drift";
  subject: { kind: "plugin"; ref: PluginRef };
  upstreamVersion?: string;
  installedVersion?: string;
  ahead: "upstream" | "installed" | "equal" | "incomparable";
};

export type ResolverDisagreement = {
  kind: "resolver-disagreement";
  subject: { kind: "plugin"; ref: PluginRef };
  cli: CliUpdateSim;
  badge: DesktopBadgeSim;
  sessionStart: SessionStartSim;
  pairs: {
    cliVsBadge: "agree" | "disagree" | "indeterminate";
    cliVsSession: "agree" | "disagree" | "indeterminate";
    badgeVsSession: "agree" | "disagree" | "indeterminate";
  };
};

export type RuntimeBoundary = {
  kind: "runtime-boundary";
  subject: { kind: "plugin"; ref: PluginRef };
  changedSurfaces: SurfaceKind[];
  changedSurfacesSource: "diff-installed-vs-resolved" | "conservative-all-surfaces";
  refreshBy: RefreshSemantics;
};

export type KnownTrap =
  | {
      kind: "marketplace-update-broken";
      subject: { kind: "marketplace"; ref: MarketplaceRef };
      lastUpdatedAtMs: number;
      headLocal: string;
      headRemote: string;
    }
  | { kind: "refresh-needed"; subject: { kind: "plugin"; ref: PluginRef } }
  | { kind: "bump-needed"; subject: { kind: "plugin"; ref: PluginRef } }
  | { kind: "badge-only-needed"; subject: { kind: "plugin"; ref: PluginRef } }
  | {
      kind: "skills-plugin-stuck";
      subject: { kind: "root"; ref: RootRef };
      skill: string;
    }
  | {
      kind: "session-bloat-cleanup-eligible";
      subject: { kind: "root"; ref: RootRef };
      bytesReclaimable: number;
      dirsCount: number;
    }
  | { kind: "unsupported-source"; subject: { kind: "plugin"; ref: PluginRef } }
  | { kind: "npm-source-not-supported"; subject: { kind: "plugin"; ref: PluginRef } };

export type BackendUiDrift = {
  kind: "backend-ui-drift";
  subject: { kind: "plugin"; ref: PluginRef };
  uiObserved: { version?: string; status?: string; updateAvailable?: boolean };
  uiObservedAt: string;
  uiObservedAge: "fresh" | "stale";
  cliResolverSays: { version?: string; resolvedFrom: ResolvedFrom };
  disagrees: boolean;
};

export type Drift =
  | RegistrationDrift
  | VersionDrift
  | ResolverDisagreement
  | RuntimeBoundary
  | KnownTrap
  | BackendUiDrift;

// ───────── VerifyInUiReport (SPEC-v1.0.md §10.4.6) ─────────

export type VerifyInUiReport = {
  schemaVersion: "1.0";
  runId: string;
  pluginRefKey: PluginRefKey;
  captured: {
    pluginListed: boolean;
    versionShown?: string;
    updateAvailable?: boolean;
    statusShown?: string;
    capturedAt: string;
  };
  persistedTo: string;
  exitCode: 0 | 1 | 64;
  logFile?: string;
};
