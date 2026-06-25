# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Discovery no longer aborts on one bad Cowork root: a malformed or locked `known_marketplaces.json` in any single Cowork root previously threw and failed `scan`/`refresh`/`list` for every marketplace. The bad root is now skipped.
- `refresh <marketplace>` resolved the active plugins root by `installed_plugins.json` mtime, so a CCD marketplace could not be refreshed while a Cowork root had a newer mtime — `cpd refresh` reported "is not registered" or "no local clone" for a marketplace that `cpd scan` listed normally. `refresh` now resolves the root that owns the named marketplace and operates there.
- `refresh --force-fetch <mp>` refused with "no local clone (it must be a github/git source…)" whenever the scan could not resolve the clone's `headLocal`, even though the clone was present and a valid git repo. The gate now checks that the clone dir exists and is a git repo (what `git fetch && git reset --hard` needs) and gives a distinct, path-specific error per case.

(See `docs/internal/PLAN-refresh-reliability.md`.)

## [0.3.0] - 2026-05-21

This release closes the "Personal-plugins drift goes undetected" hole described in `docs/internal/SPEC.md` §3.3 Layer 3 / Layer 5 and §15. Concrete repro: a plugin installed via Claude Desktop → Settings → Plugins shows the previous version (e.g. `proof-engine 1.41`) while upstream is at the new one (`1.42`), and prior `cpd check` reported "everything fresh, exit 0". Three compounding gaps were responsible — all fixed in this release.

### Fixed

- **Stale Personal-plugins installs no longer reported as fresh.** Three compounding gaps were hiding the case where Claude Desktop's Personal-plugins panel installs a plugin at an older version than upstream (concrete repro: `proof-engine 1.42` upstream, `1.41` in Claude Desktop, `cpd check` reported exit 0):
  1. **Active-Cowork-session pick** now considers `max(installed_plugins.json mtime, rpm/manifest.json mtime)`. Personal-plugins installs touch only `rpm/manifest.json`, so the previous "installed_plugins.json mtime only" heuristic misclassified the truly-active session. (Layer 3 in §3.3 of SPEC; new `effectiveActiveMtime` helper in `src/discovery/active-root.ts`.)
  2. **Layer 5 freshness** now compares the on-disk RPM `plugin.json#version` against the local marketplace clone (no-network). Two-tier lookup: exact `marketplaceName` match, then cross-reference by plugin name across registered marketplaces (filtered through `known_marketplaces.json` so orphan `.bak` dirs don't cause spurious ambiguity). `unknowable` when no comparable clone is locally available.
  3. **`cpd check`** now surfaces the RPM layer **alongside** the CCD plugin layers when the same plugin name exists in both surfaces — previously it short-circuited on the first CCD match. Exit code aggregates worst-status across the two surfaces (3 > 2 > 0).

### Added

- New `effectiveActiveMtime(root)` export in `src/discovery/active-root.ts` for callers that need a single "active" pick independently of the per-root `isMostRecent` flag.
- `CoworkRoot.rpmManifestMtime?: number` and `CoworkRootInfo.rpmManifestMtime?: number` on the type level (additive, optional).
- `RpmCopyData.versionDelta` and `RpmCopyData.versionDeltaSkipReason` evidence fields (additive, optional).
- `checkRpmCopy` and `snapshotRpmCopy` accept an optional `marketplaceClone: MarketplaceCloneHint` input enabling the Layer 5 version comparison. Calls without this field fall back to the legacy directory-existence verdict for back-compat with existing tests.
- New `MarketplaceCloneHint` exported type from `src/caches/rpm-copy.ts`.
- `readPluginJsonVersion` and `readMarketplaceJson` re-exported from `src/caches/install-snapshot.ts` so callers outside that module can share the resolver primitives.
- New "Also installed via Claude Cowork (Personal plugins)" section in the human `cpd check` renderer when both CCD and RPM surfaces resolve.
- `runRootPipeline` (v1.0 scan path) takes a new `ccdPluginsRoot` param as a fallback search root for RPM-plugin marketplace lookups.

### Tests

- 11 new tests: tie-breaking and single-signal cases in `test/unit/discovery/active-root.test.ts`; RPM-manifest mtime population in `test/unit/discovery/cowork-roots.test.ts`; stale/fresh/ahead/unknowable branches in `test/unit/caches/rpm-copy.test.ts`; cross-surface integration test in `test/integration/check-cross-surface.test.ts`. Total: 1212/1212 pass.

## [0.2.0] - 2026-05-06

This release absorbs the 2026-05-06 validation pass against Claude Desktop `1.6259.1` and the gist's two follow-up revisions (`T11:27:26Z` and `T11:45:05Z`). The audit baseline behind these notes is in `docs/internal/VALIDATION-claude-desktop-code-2026-05-06.md`; the gist's current revision references standalone CLI `2.1.131` and the gist's own retest reports same observed behaviors at `2.1.131` as at the audited `2.1.129`.

### Added

- **`extraKnownMarketplaces` settings-layer integration.** cpd now reads marketplace declarations from five settings sources: `userSettings` (`$CLAUDE_CONFIG_DIR/settings.json`), `projectSettings` (`<cwd>/.claude/settings.json`), `localSettings` (`<cwd>/.claude/settings.local.json`), `coworkSettings` (per-cowork-root), and `policySettings` (`/Library/Application Support/ClaudeCode/managed-settings.json` + drop-ins under `managed-settings.d/*.json`). Settings-declared marketplaces appear in `cpd list` with a `(settings-only: <sources>)` annotation when no clone is materialized. Closes the visibility gap the upstream gist documented as *"diagnostic tools that walk only `known_marketplaces.json` will miss settings-declared marketplaces"*.
- **`KnownMarketplaceEntry.declaredIn` and `KnownMarketplaceEntry.hasClone` fields** (additive, optional). `declaredIn` is a multi-source attribution array (`SettingsSource[]`); `hasClone` distinguishes settings-only declarations from materialized clones.
- **`MarketplaceReport.declaredIn` and `MarketplaceReport.hasClone` fields** (additive, optional) on the v0.5 list-path report shape, mirroring the topology-level fields.
- **New `SettingsSource` exported type** for the multi-source attribution union.
- **Per-session feature-gate detection.** cpd now reads `<userData>/local-agent-mode-sessions/<acc>/<org>/local_<UUID>.json` sidecars and surfaces the `pluginsEnabled` / `skillsEnabled` gates that turn whole subsystems off at session start. New `CoworkRoot.sessionConfigs[]`, `CoworkRoot.sessionConfigsTruncated`, and `CoworkRoot.sessionConfigsTotalScanned` fields. New `SessionConfig` exported type. Capped at 2048 files per cowork root to avoid pathological enumeration cost.
- **New `ScanAdvisory` ids and `summary.advisories[]` slot.** Advisories are surfaced as side notes when there are facts the user should know about that aren't drift findings:
  - `clean-scan-runtime-blind-spots` (clean-scan only) — runtime flags cpd cannot observe (`--plugin-dir`/`--plugin-url`, `--bare`, `--channels`/`--dangerously-load-development-channels`).
  - `session-plugins-disabled-detected` (always-fire) — ≥1 non-archived session has `pluginsEnabled: false`.
  - `session-skills-disabled-detected` (always-fire) — same for `skillsEnabled: false`.
  - `session-config-enumeration-truncated` (always-fire) — cowork root exceeded 2048-file cap.
- **`SessionGateAdvisoryDetails` exported type** for structured access to affected session counts and IDs.
- **`SkillsPluginSkill.isUserCreated` field.** Local-only user-created skills (`creatorType: "user"` AND `syncManaged: false` in the manifest) are now annotated `(user-created)` in `cpd list` and exempted from the `skills-plugin-stuck` trap, analogous to the existing built-in exemption.
- **New `ActionRecipe` variant `claude_plugin_marketplace_add`** for materializing settings-only marketplaces. Carries `source` (URL/path) and optional `scope` (`user`/`project`/`local`). **Type-only addition this release** — no catalog entry currently emits this recipe; settings-only marketplaces produce zero drift findings and zero recommendations (defensibly so: a settings-side declaration is a *menu* the user opts into via `claude plugin marketplace add` when ready, not a stale state to auto-fix). The variant is in place so a future release can wire the emission without a schema change. See "Known gaps" below.
- **Hermetic-test injection hooks.** New env var `CLAUDE_MANAGED_SETTINGS_DIR` overrides the macOS policy-settings root (`/Library/Application Support/ClaudeCode`) for tests and non-standard MDM deployments. The new readers also accept `cwd` injection in their `SystemContext` for `projectSettings`/`localSettings` resolution.

### Changed

- **`ScanAdvisory` is now a discriminated union** keyed by `id`, with typed `details` per advisory kind (was `{ id: string; severity; message }`). Consumers that read only `message` are unaffected; consumers that switch on `id` should add a default case to tolerate future ids. Wire-format additive within the existing `schemaVersion: "1.0"`.
- **Renamed `summary.advisories[].id`**: `session-only-plugin-loads-invisible` → `clean-scan-runtime-blind-spots`. The advisory message has also broadened to cover three runtime-flag categories (`--plugin-dir`/`--plugin-url`, `--bare`, `--channels`/`--dangerously-load-development-channels`) instead of just the first. The original id was added in post-v0.1.0 work and was never in a tagged release. Consumers that branched on the old discriminator string need to update; consumers that read only `message` are unaffected.
- **`skills-plugin-stuck` recommendation message** rewritten to reference the *effective* sync interval rather than a hard-coded 10 minutes. Desktop `1.6259.1` reads a GrowthBook value named `skillsSyncIntervalMs`, so the focus-handler interval is now remotely configurable. The recovery — quit and relaunch — is unchanged.
- **Marketplace inventory in `cpd list` now includes settings-only declarations** with `layer1.status: "skipped"` and a `(settings-only: <sources>)` human-readable annotation. Previously these would have been silently absent from the report.
- **Drift detection is `hasClone`-aware.** Settings-only marketplaces (no on-disk clone) are skipped in the upstream-probe loop, snapshot generation, and `marketplace-update-broken` / `refresh-needed` traps. Registration drift now compares declarations across roots (via the per-root `marketplaces[]` union of `declaredIn` sources), not clone presence — machine-global settings-source declarations correctly produce zero drift across all roots.

### Fixed

- **Friendly errors when a required positional argument is missing.** `cpd check`, `cpd refresh`, `cpd verify-in-ui`, and `cpd watch` previously produced Commander.js's generic one-liner (`error: missing required argument 'pluginAtMarketplace'`) when invoked without the positional. They now emit a multi-line message naming the argument, two example invocations, and a hint pointing at related commands (`cpd list` to find a plugin/marketplace, plain `cpd` for a whole-system scan). Exit code remains 64 (E_USAGE).
- **Skills-plugin user-created skill exemption** now uses literal-false comparison on `syncManaged` (predicate is `creatorType === "user"` AND `syncManaged === false`, conjunction). The earlier disjunction would have over-exempted *uploaded* user skills, which re-enter the API download cycle via `saveLocalSkill`'s upload branch and ARE subject to the silent-stale failure.
- **Marketplace-name safety filter applied to the new `extraKnownMarketplaces` reader.** Settings sources can carry attacker-controlled names (especially `.claude/settings.local.json` from a malicious project); the reader now rejects unsafe names with the same warn-level stderr message `parseKnownMarketplaces` uses.

### Security

- **`CLAUDE_MANAGED_SETTINGS_DIR` only governs reads.** cpd never writes to managed-settings paths; the new env var redirects reads only, preserving the read-only-by-default guarantee.

### Known gaps

- **Settings-only marketplaces produce no recommendations.** When a marketplace is declared via `extraKnownMarketplaces` in any settings source but no clone is materialized, `cpd list` shows the entry with the `(settings-only)` annotation, drift detection correctly skips it (no false `marketplace-update-broken` etc.), but no recommendation is emitted to materialize it. The `claude_plugin_marketplace_add` `ActionRecipe` variant exists in the type union but isn't wired to a catalog entry. Defensible because settings-side declarations represent an opt-in menu (especially `policySettings.extraKnownMarketplaces`), not stale state — but if real users report confusion ("how do I materialize this?"), wiring the emission is a small follow-up.
- **QA harness fixtures don't assert "advisory must fire" or "recommendation must be present."** `expected.json` supports exit-code and orphan-count assertions only. New tranche-2 fixtures (`extra-marketplaces-user-settings`, `extra-marketplaces-policy-settings`, `session-gate-plugins-disabled`) verify the structural shape via the list/topology oracles + IT-21/IT-22 invariants but do not assert specific advisory ids or recipe kinds at the fixture level. A `requiresAdvisoryId` / `requiresRecommendation` field on `expected.json` would close this gap.

## [0.1.0] - 2026-05-03

Initial public release.

### What it does

`claude-plugin-doctor` (binary alias `cpd`) diagnoses drift across the six
independent cache layers of the Claude Code / Claude Desktop plugin system:

1. Marketplace clone — `~/.claude/plugins/marketplaces/<mp>/`
2. Plugin install snapshot — `<plugins-root>/cache/<mp>/<plugin>/<ver>/`
3. Per-account/org Claude Cowork session mirror
4. Backend remote marketplace catalogue
5. Claude Cowork in-app install (Personal plugins)
6. Standalone Claude Code remote SSH content-hash sync

The "remove + relaunch + re-add" workaround clears multiple layers at once.
`cpd` finds *which* layer is actually stale and recommends the
minimum-impact fix.

### Subcommands

- `cpd` / `cpd scan` — full six-layer drift scan with aggregated recommendations.
- `cpd check <plugin>@<marketplace>` — single-plugin deep-dive with per-layer
  evidence and an inline `Fix:` block.
- `cpd list` — flat inventory of marketplaces, plugins, and Claude Cowork
  in-app installs, with cross-store xref annotations.
- `cpd topology` — discovered installation layout (debug subcommand).
- `cpd cache --orphans` — list install-snapshot dirs no longer referenced
  by any `installed_plugins.json` (read-only).
- `cpd cache --prune-cowork-sessions` — reap stale `local_<UUID>/` and
  `local_ditto_*_g<N>/` session directories (dry-run by default).
- `cpd refresh <marketplace>` — run `claude plugin marketplace update`
  with before/after diff. `--force-fetch` bypasses the silent-cooldown
  bug (Anthropic issue #46081) with direct `git fetch` + `git reset --hard`.
- `cpd verify-in-ui <plugin>@<marketplace>` — capture Claude Desktop UI
  evidence for a plugin.
- `cpd watch <plugin>@<marketplace>` — re-check on file changes (macOS only).
- `cpd explain` — six-layer architecture cheat-sheet plus glossary.

### Output and contract

- Human-readable output by default; `--json` emits a stable JSON document.
- `--ndjson-events` streams machine-readable phase events to stderr (or
  `--events-file`).
- Stable error codes (`E_USAGE`, `E_PARSE_INSTALLED_PLUGINS`, etc.) for
  scripting.
- `--verbose` streams one-line tagged prose to stderr describing each
  per-event probe, fetch, drift, and planned action.
- All commands write a default log file under
  `~/.claude-plugin-doctor/logs/` (override with `--log-file`, disable
  with `--no-log-file`).
- Commands accept `--no-color`, `--no-network`, `--no-progress`, `-q`/`--quiet`.

### Detected drift kinds

`refresh-needed`, `bump-needed`, `badge-only-needed`, `version-drift`,
`marketplace-update-broken`, `unsupported-source`, `npm-source-not-supported`,
`resolver-disagreement`, `runtime-boundary`, `registration-drift`,
`skills-plugin-stuck`, `session-bloat-cleanup-eligible`, `backend-ui-drift`.

### Honest framing for `bump-needed`

When commits diverge between the installed snapshot and the marketplace
clone but `plugin.json#version` is unchanged, `cpd check` no longer
asserts "Updates blocked." The divergence may be real (author needs to
bump) or harmless (docs/CI-only commits — `claude plugin update` is
correctly a no-op). To let the human judge:

- The detail string reads "Commits diverged but `plugin.json#version`
  unchanged — `claude plugin update` will be a no-op until the version
  bumps."
- The fix block is split: "Fix (manual, N steps — if you're the plugin
  maintainer):" followed by an "If you're a consumer of this plugin"
  footer pointing to the commits list as the basis for action vs. ignore.
- `evidence.marketplaceEntryVersion` is surfaced even when it agrees, so
  consumers see the badge-only-needed rule-out actually happened.

### New evidence: `commitsBetween` for `bump-needed` (and divergent `refresh-needed`)

`cpd check --json`'s `plugin.checks.install_snapshot.evidence` now carries
`commitsBetween: { sha, subject }[]` (and `commitsBetweenTruncated:
true` when a cap was hit) when both the installed SHA and clone HEAD
are known. Computed via local `git log <installedSha>..<cloneHeadSha>
-- <pluginSubdir>` against the marketplace clone — no network. Up to 10
commits. Renders inline in the human output as "new commits N commits
in this plugin's subdir:" followed by `<short-sha>  <subject>` rows.
Falls back silently when git is unavailable, the dir isn't a repo, or
either SHA is missing.

### "Other caches" line includes layer 4

The `cpd check` "Other caches" collapse line now lists "backend
marketplace catalogue (server-side, no local cache)" alongside the other
non-applicable layers, so all six layers of the model are accounted for
in the per-check output even though Layer 4 has no local cache to probe.

### Platform support

- macOS only.
- Node.js ≥ 20.

### Architectural rules

- Read-only by default. Mutations live behind opt-in `cache --prune…` /
  `refresh --force-fetch` subcommands, gated by `--yes`.
- Never writes to `marketplaces/`, `rpm/`, `cowork_settings.json`, or
  `known_marketplaces.json`. Mutations to those are delegated to the
  upstream `claude plugin ...` CLI.
- Pure file-system inspection — no IPC into Claude Desktop, no
  requirement for a running Claude session.
- Network access is limited to `git ls-remote` and HTTP `GET` of
  `plugin.json` for upstream-version comparison; `--no-network` suppresses
  both.
- One module per cache layer under `src/caches/`. Cross-platform path
  resolution lives in `src/paths.ts`. Honors `CLAUDE_CONFIG_DIR`.
</content>
