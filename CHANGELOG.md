# Changelog

## 0.2.0

### Minor Changes

- [`1c0e6af`](https://github.com/yaniv-golan/claude-plugin-doctor/commit/1c0e6af4cf70489834e30fc6af1a74ef19eafa8f) Thanks [@yaniv-golan](https://github.com/yaniv-golan)! - v0.2.0 — plugin-author dev loop. Adds `check`, `refresh`, `list`, `explain`,
  `watch` subcommands. Layer 2 now detects the **version trap** (when an
  installed plugin's `gitCommitSha` matches the recorded version but the
  marketplace clone has advanced beyond that commit) and surfaces source-dir
  content drift for `directory`-source marketplaces.

  Breaking (no published v0.1 consumers): `ScanReport.schemaVersion` bumps
  0.1 → 0.2; `InstalledPlugin` collapsed to `{ id, pluginName, marketplace,
scopes[] }`; parsers now require the real-world JSON shapes only (single-Entry
  and wrapped-marketplaces fallbacks removed).

- [`1c0e6af`](https://github.com/yaniv-golan/claude-plugin-doctor/commit/1c0e6af4cf70489834e30fc6af1a74ef19eafa8f) Thanks [@yaniv-golan](https://github.com/yaniv-golan)! - Two-resolver model — Layer 2's reference rewritten with a 5-level CLI resolver
  (plugin.json#version primary, marketplace.json#plugins[].version fallback) and
  a separate Desktop UI resolver. New trap taxonomy (refresh-needed,
  bump-needed, badge-only-needed) replaces the v0.2 "version trap A/B" jargon.
  schemaVersion bumped 0.2 → 0.3 (breaking JSON consumers pinned to 0.2).
  Object-form `source` shape now parsed (claude-plugins-official compat).

- [`1c0e6af`](https://github.com/yaniv-golan/claude-plugin-doctor/commit/1c0e6af4cf70489834e30fc6af1a74ef19eafa8f) Thanks [@yaniv-golan](https://github.com/yaniv-golan)! - Source-aware resolver redesign + `cpd refresh --force-fetch` bypass for
  Anthropic [#46081](https://github.com/yaniv-golan/claude-plugin-doctor/issues/46081). Layer 2's "two resolvers" v0.3/v0.4 framing replaced
  with the corrected "one resolver, two read locations based on plugin
  entry source kind" model. Schema bump 0.3 → 0.5 (breaking evidence
  renames: cliVersion → resolvedVersion, desktopUiVersion →
  marketplaceEntryVersion, marketplaceSourceKind → pluginEntrySourceKind).
  New trap kinds: marketplace-update-broken, npm-source-not-supported,
  unsupported-source. badge-only-needed narrowed to object-source only.

### Patch Changes

- [`1c0e6af`](https://github.com/yaniv-golan/claude-plugin-doctor/commit/1c0e6af4cf70489834e30fc6af1a74ef19eafa8f) Thanks [@yaniv-golan](https://github.com/yaniv-golan)! - Initial v0.1.0 release

- [`1c0e6af`](https://github.com/yaniv-golan/claude-plugin-doctor/commit/1c0e6af4cf70489834e30fc6af1a74ef19eafa8f) Thanks [@yaniv-golan](https://github.com/yaniv-golan)! - Two real-machine bugfixes:

  1. `cpd check <plugin>` exit code is now per-plugin, not system-wide rollup.
  2. `rpm/manifest.json` parser accepts both object-keyed and array-of-entries
     shapes (the array form is the real shape on Cowork ≥ 1.x; pre-fix this
     crashed `cpd check --mode cowork` with E_USAGE).

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
`cpd` finds _which_ layer is actually stale and recommends the
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
