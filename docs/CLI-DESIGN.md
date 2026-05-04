# `claude-plugin-doctor` — CLI Design Contract

This is the **stable, versioned contract** that scripts and AI agents may rely on. Anything not documented here is implementation detail and may change without notice.

## Streams

| Stream | Content | Stable? |
|---|---|---|
| stdout | The scan report (human or JSON). Nothing else. | Yes |
| stderr | Progress, log mirror, errors. | Format: stable for `--ndjson-events`; freeform otherwise. |
| Default log file | NDJSON, one JSON object per line. | Yes — schema in [§ Log file (NDJSON)](#log-file-ndjson). |

The split lets you do `cpd --json | jq …` cleanly: `jq` only sees the report.

## Exit codes (stable, append-only)

### Global (every command)

| Code | Meaning |
|---|---|
| 0 | Everything fresh, no drift detected |
| 1 | Generic error (file not found, malformed JSON, etc.) — emitted as `ErrorEnvelope`, never as a normal report |
| 2 | Drift detected (any layer stale) — fixes available |
| 3 | Drift detected, manual / destructive fix required |
| 64 | Usage error (bad flags) — emitted as `ErrorEnvelope` |

The 0/1/2/3/64 codes are **frozen**. New codes are only ever appended; existing codes never change meaning.

### Per-command extensions (reserved)

These codes are reserved for future per-command use so consumers don't see them appear out of nowhere. Each is scoped to a specific command — other commands never emit it.

| Code | Reserved for | Emitted when |
|---|---|---|
| 4 | A future `fix` command | A destructive action was requested without explicit consent. |
| 5 | A future `fix` command | An input report was rejected as stale. |

Consumers should treat unknown exit codes from a `cpd` invocation as a generic non-zero condition; matching against the global table is the safe default.

## `--json` schema (stable, versioned)

`--json` produces exactly one JSON document on stdout, terminated by a single newline. The top-level `schemaVersion` field gates breaking changes — bumps follow semver. The current schema is **`1.0`**.

Each command emits its own document shape — discriminate by which command you ran, not by the version field:
- `cpd scan --json` → `ScanReport` (six-tier model: topology → upstreams → caches → resolvers → drifts → recommendations).
- `cpd check --json` → `CheckReport` (single-plugin per-layer evidence).
- `cpd list --json` → `ListReport` (flat inventory).
- `cpd refresh --json` → `RefreshReport` (before/after diff).
- `cpd topology --json` → `TopologyReport` (discovered installation layout).
- `cpd cache --orphans --json` → `CacheOrphansReport`.

### `cpd scan --json` / default invocation

The `ScanReport` envelope:

```json
{
  "schemaVersion": "1.0",
  "runId": "<uuid>",
  "startedAt": "<iso8601>",
  "finishedAt": "<iso8601>",
  "topology": { /* discovered roots, skills-plugin pairs, session-locals */ },
  "upstreams":         { "<pluginRefKey|marketplaceRefKey>": <UpstreamProbeResult> },
  "caches":            { "<pluginRefKey>": [<CacheSnapshot>, …] },
  "marketplaceCaches": { "<marketplaceRefKey>": [<CacheSnapshot>, …] },
  "rpmCaches":         { "<rpmKey>": [<CacheSnapshot>, …] },
  "resolvers": {
    "<pluginRefKey>": { "cli": <CliUpdateSim>, "badge": <DesktopBadgeSim>, "sessionStart": <SessionStartSim> }
  },
  "drifts":          [ /* Drift[] — see §"Drift kinds" */ ],
  "recommendations": [ /* RecommendedAction[] — see §"Recommendations" */ ],
  "summary"?: {
    "perLayer": {
      "marketplace_clone": { "count": <n>, "fresh": <n>, "stale": <n>, "missing": <n>, "skipped": <n>, "unknowable": <n> },
      "install_snapshot":  { /* same shape */ },
      "cowork_mirror":     { /* same shape */ },
      "rpm_copy":          { /* same shape */ },
      "ccd_remote_ssh":    { /* same shape */ }
    }
  },
  "exitCode": 0 | 2 | 3,
  "logFile"?: "<absolute path>"
}
```

The `summary` field is an inventory roll-up — per-layer counts derived from the snapshot maps. Typed optional on the wire so future schema-additive evolutions don't require a major bump, but every `cpd scan` emits it. Counts on a single layer always satisfy `count >= fresh + stale + missing + skipped + unknowable` (the buckets are not strictly partitioning when subjects appear in multiple snapshots, so the lower bound holds while equality is best-effort).

A successful `ScanReport` only carries `exitCode` 0, 2, or 3. Codes 1 (generic error) and 64 (usage) are emitted as the `ErrorEnvelope` shape below — never as a `ScanReport`. **Always branch on `ok === false` first, then `schemaVersion`.**

Error envelope (when `--json` is set and the run fails):

```json
{
  "ok": false,
  "code": "E_PARSE_INSTALLED_PLUGINS",
  "message": "...",
  "hint"?: "...",
  "runId"?: "<uuid>",
  "logFile"?: "<absolute path>"
}
```

The `ok: false` discriminator lets agents distinguish errors from reports without reading `schemaVersion`.

### Drift kinds

`drifts[]` is the canonical place to read what's wrong. Each entry has a `kind` discriminator:

| `kind` | What it means |
|---|---|
| `registration-drift` | A plugin entry exists in `installed_plugins.json` but its on-disk install is missing or vice-versa. |
| `version-drift` | Resolved version disagrees with the installed snapshot. When `ahead === "upstream"` (catalog newer than installed), this is actionable and lifts `exitCode` to ≥ 2; the other `ahead` values are advisory-only. |
| `resolver-disagreement` | The CLI resolver and the Desktop "Update available" badge resolver would resolve different versions. |
| `runtime-boundary` | A change has landed on disk that requires a fresh task or Claude restart to take effect. Only emitted when the composer can perform a structured plugin.json diff (provenance `diff-installed-vs-resolved`); the conservative `all-surfaces` fallback is suppressed to avoid telling the user to restart Claude on every plugin every scan. |
| `backend-ui-drift` | What `cpd verify-in-ui` captured from the Settings UI disagrees with the CLI resolver's view. |
| `refresh-needed`, `bump-needed`, `badge-only-needed`, `marketplace-update-broken`, `skills-plugin-stuck`, `session-bloat-cleanup-eligible`, `unsupported-source`, `npm-source-not-supported` | Known traps — see `cpd explain` for the full taxonomy. |

### Recommendations

`recommendations[]` carries the planned, ordered fixes. Each entry:

```json
{
  "id": "<opaque per-run id>",
  "conditionId": "<layer>:<condition>",
  "refs": ["<pluginRefKey | marketplaceRefKey>", …],
  "ordinal": 1,
  "description": "Update plugin foo@bar",
  "cmd": "claude plugin update foo@bar",
  "recipes":    [ <ActionRecipe>, … ],
  "fixes":      [ <DriftRef>, … ],
  "doesNotFix": [ <DriftRef>, … ],
  "postActionAdvisory": "verify-in-ui" | "ui-restart-required" | "new-task-required" | "manual-step",
  "risk": "safe" | "destructive",
  "requiresYes": false,
  "requiresManualStep": false
}
```

- `id` is **unique per action instance in a single scan run** and **opaque** — consumers must not split or parse it. Use `conditionId` + `refs[]` for structured lookup.
- `conditionId` is the **stable catalog identifier** in the form `<layer>:<condition>` (e.g. `marketplace_clone:update_broken`, `install_snapshot:version_drift`). Append-only — never renamed once emitted. Many actions in a single report can share a `conditionId`.
- `refs[]` lists every plugin/marketplace ref the action targets (length ≥ 1 for plugin/marketplace-scoped actions; empty for root-scoped actions like `cowork_mirror:session_bloat_cleanup_eligible`). Filter by plugin without parsing `id`.
- `recipes[]` is the **typed multi-step executor plan** — a discriminated union (`claude_plugin_install` / `claude_plugin_update` / `claude_plugin_uninstall` / `claude_plugin_marketplace_update` / `claude_plugin_marketplace_remove` / `cpd_refresh` / `cpd_refresh_force_fetch` / `cpd_cache_prune_cowork_sessions` / `delete_orphan_snapshot` / `manual` / `advisory`). Always non-empty. Reserved for a future fix runner; current commands do not parse it. New `kind` values are additive.
- Iterate `fixes[]` to know which drifts a single recommendation resolves. Identical actions across multiple plugins are aggregated into one entry with a longer `fixes[]` array.
- `cmd` is omitted when the fix requires manual steps (e.g. `bump-needed`). The fix runner does not parse `cmd`; `recipes[]` is the authoritative typed surface.
- Do not assume a fixed count of recommendations — aggregation makes the count content-dependent.

### `cpd check <plugin>@<mp> --json` schema

```json
{
  "schemaVersion": "1.0",
  "runId": "<uuid>",
  "startedAt": "<iso8601>",
  "finishedAt": "<iso8601>",
  "pluginId": "<plugin>@<mp>",
  "plugin":      { /* PluginReport — omitted if plugin not installed */ },
  "marketplace": { /* MarketplaceReport — omitted if mp not registered */ },
  "rpmMatch"?: {
    "rpmPlugin": { /* RpmReport */ },
    "marketplaceAliasDiffers"?: { "typedAs": "<typed>", "actual": "<actual>" }
  },
  "rpmMatchAmbiguous"?: { "candidates": [ /* RpmCandidateForDisambiguation[] */ ] },
  "fullReport":  { /* full ScanReport */ },
  "exitCode": 0 | 2 | 3 | 64,
  "logFile"?: "<absolute path>"
}
```

`PluginReport.scopes[]` is an array of one or more installation scopes (`user`, `project`, `local`, `managed`, `unknown`); each scope carries `version`, `installPath`, `gitCommitSha`, `installedAt`, `lastUpdated`. The primary (first) scope's `version` is mirrored to `PluginReport.installedVersion` for display convenience.

For `bump-needed` (and `refresh-needed` when commits diverged), `plugin.checks.install_snapshot.evidence` may include:

- `commitsBetween: { sha: string; subject: string }[]` — abbreviated SHA + commit subject of the commits between the user's installed SHA and the marketplace clone HEAD, scoped to that plugin's subdir. Up to 10 entries. Computed via local `git log` against the marketplace clone — no network. Absent when either SHA is missing, the clone isn't a git repo, or git wasn't reachable.
- `commitsBetweenTruncated: true` — present and `true` when the actual range exceeded the cap; the array contains the most recent N entries.

Consumers and agents should read `commitsBetween[].subject` to decide whether the divergence reflects real plugin code changes (true `bump-needed`) or docs/CI-only commits (silent no-op is correct, no action). Treat the list as informational; `cpd` does NOT classify the commits automatically.

`scope` may be `"managed"`: managed-scoped installs are loaded by the CLI but silently dropped by Desktop's runtime. `scope` of `"unknown"` indicates an entry whose scope field couldn't be resolved (corrupt or partial `installed_plugins.json`).

`rpmMatch` / `rpmMatchAmbiguous` (mutually exclusive) appear when the lookup resolved into Cowork's "Personal plugins" (RPM) install path instead of a regular `installed_plugins.json` entry. `rpmMatchAmbiguous` triggers `exitCode: 64` (E_USAGE) and lists candidates the user must disambiguate by `<plugin>@<marketplace>`.

### `cpd refresh <mp> --json` schema

```json
{
  "schemaVersion": "1.0",
  "runId": "<uuid>",
  "startedAt": "<iso8601>",
  "finishedAt": "<iso8601>",
  "marketplace": "<mp>",
  "refreshMethod": "claude-cli" | "force-fetch",
  "before": { "layer1": <CheckResult>, "plugins": [<PluginReport>, …] },
  "claudeUpdate": { "ok": true, "exitCode": 0, "stderr": "..." },
  "after":  { "layer1": <CheckResult>, "plugins": [<PluginReport>, …] },
  "chainedUpdates"?: [ { "id": "...", "ok": true, "exitCode": 0, "stderr": "..." } ],
  "exitCode": 0 | 2 | 3,
  "logFile"?: "<absolute path>"
}
```

`refreshMethod === "force-fetch"` indicates the bypass path was taken (`cpd refresh --force-fetch --yes`); `claude-cli` is the default `claude plugin marketplace update <mp>` path.

The `exitCode` reflects the worst of three signals: the post-mutation scan's exit code, whether the marketplace update itself succeeded (`claudeUpdate.ok`), and whether any chained `claude plugin update` failed. A successful post-scan with a failed marketplace update or chained update lifts `exitCode` to 3 — automation should not gate solely on `claudeUpdate.exitCode`. With `--auto-update`, the `after.plugins` snapshot is captured *after* the chained updates run, not before, so it reflects the final mutated state.

### `cpd list --json` schema

```json
{
  "schemaVersion": "1.0",
  "runId": "<uuid>",
  "startedAt": "<iso8601>",
  "finishedAt": "<iso8601>",
  "marketplaces": [<MarketplaceReport>, …],
  "plugins":      [<PluginReport>, …],
  "rpmPlugins":   [<RpmReport>, …],
  "coworkRoots":  [<CoworkRootInfo>, …],
  "skillsPlugin"?: <SkillsPluginRoot>,
  "nameCollisions"?: [
    { "pluginName": "...", "entries": [<NameCollisionEntry>, …] }
  ],
  "exitCode": 0 | 2 | 3,
  "logFile"?: "<absolute path>"
}
```

`skillsPlugin` is optional — older consumers can ignore it. Each `SkillsPluginSkill` carries an additive optional `isBuiltIn?: boolean`.

`nameCollisions` is the canonical place to read same-plugin-name conflicts (across CCD ↔ RPM or within either store). Clients should use this field rather than recomputing collisions from `plugins[]` + `rpmPlugins[]`. Absent when no collisions exist.

`RpmReport.marketplaceId` is exposed for cross-referencing against the backend.

### `cpd topology --json` schema

```json
{
  "schemaVersion": "1.0",
  "runId": "<uuid>",
  "topology": <Topology>,
  "exitCode": 0 | 1,
  "logFile"?: "<absolute path>"
}
```

### `cpd verify-in-ui --json` schema

Reads observation JSON from stdin; emits a `VerifyInUiReport`:

```json
{
  "schemaVersion": "1.0",
  "runId": "<uuid>",
  "pluginRefKey": "<plugin>@<mp>",
  "captured": {
    "pluginListed": true,
    "versionShown"?: "0.4.1",
    "updateAvailable"?: false,
    "statusShown"?: "...",
    "capturedAt": "<iso8601>"
  },
  "persistedTo": "<absolute path>",
  "exitCode": 0 | 1 | 64,
  "logFile"?: "<absolute path>"
}
```

## Error codes (stable, append-only)

| Code | Meaning | Exit |
|---|---|---|
| `E_PLATFORM_UNSUPPORTED` | Running on a platform not yet supported (macOS-only) | 64 |
| `E_PARSE_KNOWN_MARKETPLACES` | `known_marketplaces.json` malformed | 1 |
| `E_PARSE_INSTALLED_PLUGINS` | `installed_plugins.json` malformed | 1 |
| `E_PARSE_RPM_MANIFEST` | `rpm/manifest.json` malformed | 1 |
| `E_PARSE_MARKETPLACE_JSON` | A marketplace's `marketplace.json` failed schema | 1 |
| `E_PARSE_PLUGIN_JSON` | A plugin's `plugin.json` failed schema | 1 |
| `E_PARSE_SKILLS_PLUGIN_MANIFEST` | A skills-plugin manifest failed schema | 1 |
| `E_GIT_TIMEOUT` | `git ls-remote` exceeded the timeout | 1 |
| `E_FETCH_TIMEOUT` | HTTP fetch (e.g. `raw.githubusercontent.com`) timed out | 1 |
| `E_FETCH_NETWORK` | HTTP fetch failed (DNS, non-200, etc.) | 1 |
| `E_FORCE_FETCH_ABORTED` | `cpd refresh --force-fetch` declined or aborted | 64 |
| `E_VERIFY_IN_UI_INPUT` | `cpd verify-in-ui` got malformed input | 64 |
| `E_UI_EVIDENCE_SCHEMA` | `ui-evidence.json` on disk has unsupported schema | 64 |
| `E_USAGE` | Bad CLI invocation | 64 |

Codes are append-only — never reused, never renamed. The `Exit` column is part of the contract; it will not change for an existing code.

## NDJSON event stream (`--ndjson-events`)

Stream one JSON object per line to stderr (or to `--events-file <path>`). Each event has a `type` field:

```json
{"type":"phase_start","phase":"check_marketplaces","ts":"...","total":12}
{"type":"phase_progress","phase":"check_marketplaces","ts":"...","current":3,"total":12,"item":"acme"}
{"type":"phase_end","phase":"check_marketplaces","ts":"...","durationMs":420}
{"type":"scan_done","ts":"...","durationMs":1380,"exitCode":2,
 "summary":{"topologyRoots":3,"driftCount":7,"recommendationCount":4,"versionTrapCount":2,"staleCount":5}}
```

### Phase names (stable, append-only)

Phases the binary may emit. Order within a single subcommand invocation is the source-of-truth order — agents that need to render progress should consume `phase_start`/`phase_end` events rather than hard-coding the order.

**Pre-`scan` setup phases** (always emitted, in this order): `init`, `resolve_paths`, `detect_mode`, `discover_topology`, `discover_skills_plugin`, `discover_session_locals`.

**Parse phases:** `parse_known_marketplaces`, `parse_installed_plugins`, `parse_rpm_manifest`.

**Probe / snapshot / resolve phases:** `probe_upstreams`, `snapshot_caches`, `check_marketplaces`, `fetch_remote_versions`, `check_plugins`, `check_rpm`, `simulate_resolvers`.

**Synthesis / render phases:** `compose_drift`, `plan_recommendations`, `render`.

**`cpd refresh`-only phases:** `refresh_before_scan`, `refresh_claude_update`, `refresh_after_scan`. Inner scans use a silent progress reporter so they don't double-emit phase events.

**`cpd topology`-only phase:** `topology_render`.

**`cpd verify-in-ui`-only phase:** `verify_in_ui_capture`.

**`cpd watch`** doesn't emit phase events itself; each re-check internally runs the scan pipeline (which does emit), but the watcher loop is silent.

The terminal signal in all cases is the `scan_done` event — there is no `phase_end` for a `done` phase. Agents should dispatch on phase names alone (no need to inspect argv).

`scan_done.summary` fields (additive, 1.0):

| Field | Meaning |
|---|---|
| `topologyRoots` | Number of discovered (CCD/Cowork) root contexts walked. |
| `driftCount` | Length of `drifts[]` in the report. |
| `recommendationCount` | Length of `recommendations[]` in the report. |
| `versionTrapCount` | Number of plugins with a known version-trap (refresh-needed, bump-needed, badge-only-needed). |
| `staleCount` | Broader "things needing attention" count: marketplace-update-broken, version-traps, version-drift, skills-plugin-stuck, session-bloat-cleanup-eligible. |

## Log file (NDJSON)

Default path: `~/.claude-plugin-doctor/logs/cpd-<ISO-timestamp>.log`. One file per run. Synchronous unbuffered writes — `tail -f <path>` shows progress in real time.

Each line is a JSON object with at least `{ts, level, msg, runId}`. Levels: `trace | debug | info | warn | error`.

## Bash patterns

```bash
# Boolean — does drift exist?
cpd --quiet --no-progress --no-log-file; case $? in
  0) echo "fresh" ;;
  2|3) echo "drift" ;;
  *) echo "error" ;;
esac

# Get the list of recommended commands
cpd --json --no-progress --no-log-file | jq -r '.recommendations[].cmd | select(.)'

# Iterate drifts by kind
cpd --json --no-progress --no-log-file | jq '.drifts[] | {kind, subject}'

# Real-time event stream into a file for later analysis
cpd --ndjson-events --events-file run.ndjson
```

## AI-agent patterns

Agents should:

1. **Always pass `--json --no-progress`** — clean stdout, no spinner mess.
2. **Branch on `ok === false` first**, then on `schemaVersion`, then on `exitCode`.
3. **Read `recommendations[]`** for the planned action set; iterate each entry's `fixes[]` for which drifts it resolves.
4. **Do not assume fixed counts** — recommendations are aggregated, NDJSON event counts vary correspondingly.
5. **Read `runId`** to correlate with the log file when something goes wrong.
6. **Use `--ndjson-events --events-file <p>`** when monitoring a long run.
7. **Pass `--no-log-file`** to avoid leaving artifacts on disk.
8. **Tolerate unknown fields** — `1.0` is locked, but additive fields (e.g. `skillsPlugin`, `isBuiltIn`, future summary keys) will continue to land in minor updates.

## Stability policy

- **Schema version** (`schemaVersion: "1.0"`): locked. Additive-only changes through every 1.x release. Removing or renaming fields requires a `2.0` bump.
- **Error codes**: append-only. Existing codes never change meaning, and the `Exit` mapping for a given code is part of the contract.
- **Exit codes**: append-only. The 0/1/2/3/64 codes are frozen.
- **Phase names**: append-only. Existing phases never renamed; new phases appended within their command's pipeline.
- **NDJSON event types**: append-only. `scan_done.summary` may grow new keys.
