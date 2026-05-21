---
name: claude-plugin-doctor
description: >-
  Use for diagnosing and fixing Claude Code / Claude Desktop plugin staleness, stuck updates, and cache drift. Triggers when a plugin keeps loading an old version, when `claude plugin update` or `claude plugin marketplace update` says "already at latest" but isn't, when a `plugin.json` version bump doesn't show up in Desktop's "Update available" badge, when an installed plugin's files are missing on disk, when a manually-deleted plugin breaks Desktop, when skills/commands won't refresh after marketplace pushes, or when the user mentions `cpd`, `claude-plugin-doctor`, or drift kinds like `marketplace-update-broken`, `bump-needed`, `badge-only-needed`, `registration-drift`, `skills-plugin-stuck`. Runs the `cpd` CLI to pinpoint which of six cache layers is stale and recommends the safest fix, confirming before any destructive action.
compatibility: "Requires `cpd` on PATH (`npm i -g claude-plugin-doctor`). macOS-only. Designed for Claude Code and Claude Cowork (shared plugin runtime)."
metadata:
  author: Yaniv Golan
  version: 0.2.0
---

# claude-plugin-doctor (cpd)

`cpd` is a read-only diagnostic CLI for the Claude Code / Claude Desktop plugin system. There are **six independent cache layers** (marketplace clone, plugin install snapshot, per-account Claude Cowork session mirror, backend marketplace catalog, Cowork in-app install / "Personal plugins", standalone Claude Code remote SSH sync) and any one of them can be stale on its own. Most "the plugin is still loading the old version" reports are one specific layer being stale — `cpd` walks all six and tells you which.

This skill teaches you to run `cpd`, read its structured JSON output, and present the right fix to the user.

## When NOT to use this skill

- Authoring or validating a `plugin.json` manifest from scratch — that's `claude plugin validate`'s job.
- Diagnosing the `claude` CLI's own auto-updater — that's `claude doctor`'s job.
- Generic Claude Code login/auth/MCP problems unrelated to plugin staleness.

If the user is asking about plugin staleness or any of the symptoms in the description above, this skill applies.

## Step 1 — Verify the binary and platform

Before running anything else:

```bash
cpd --version
```

If `cpd` is not installed, tell the user to install it once:

```bash
npm i -g claude-plugin-doctor
```

If `uname` reports anything other than `Darwin`, stop — `cpd` is macOS-only and exits with `E_PLATFORM_UNSUPPORTED` on Linux/Windows. Tell the user that and don't continue.

## Step 2 — Run the diagnosis

Two forms. Pick by what the user asked.

**Whole-system scan** (use when the user is debugging "something is stale" without naming a plugin):

```bash
cpd --json --no-progress --no-log-file
```

**Single-plugin deep-dive** (use when the user names a specific plugin, e.g. `founder-skills@lool-founder-skills` or any `<plugin>@<marketplace>` form):

```bash
cpd check <plugin>@<mp> --json --no-progress --no-log-file
```

The flags are not optional. `--json` gives you a stable schema; `--no-progress` keeps stdout clean; `--no-log-file` avoids leaving artifacts on the user's disk. Add `--no-network` only if the user is offline.

## Step 3 — Branch on the response shape

The output is **exactly one JSON document**. Parse it once and branch in this order:

1. **`ok === false` → error envelope.** The run failed. Read `code` (an `E_*` error code) and `message`. Tell the user what failed in plain English and stop. Do not try to interpret partial output.

2. **`schemaVersion`.** Should be `"1.0"`. If different, the user's `cpd` is older than this skill expects — suggest `npm i -g claude-plugin-doctor@latest` and stop.

3. **`exitCode`:**
   - `0` — everything is fresh. Tell the user there's no drift.
   - `2` — drift detected, automatic fixes available.
   - `3` — drift detected, manual or destructive fix required.
   - `1` or `64` only appear in the error envelope, never here.

4. **Read `recommendations[]`** — this is the planned, ordered fix set. Iterate in `ordinal` order; each entry has:
   - `conditionId` — **stable catalog ID** (`<layer>:<condition>`, e.g. `marketplace_clone:update_broken`). Use this for structured lookup; never parse `id`.
   - `refs[]` — plugin/marketplace refs targeted by this action.
   - `description` — one-line summary, agent-friendly.
   - `cmd` — copy-paste-able shell command. **Omitted when the fix requires manual steps** (e.g. `bump-needed` requires editing files).
   - `fixes[]` — the drift entries this single recommendation resolves; useful for explaining WHY.
   - `risk` — `"safe"` or `"destructive"`. **Always confirm with the user before running anything `"destructive"`.**
   - `requiresYes` — if true, the underlying `cpd` subcommand needs `--yes`. Don't add `--yes` automatically; surface what it does and let the user opt in.
   - `requiresManualStep` — if true, walk the user through the steps; don't try to auto-execute.
   - `recipes[]` is reserved for a future fix runner — current consumers should ignore it.

5. **Read `drifts[]`** for context — each entry has a `kind` discriminator. Use the table below to translate.

6. *(Optional)* **Read `summary.perLayer`** for a one-line inventory ("found N marketplaces, M install snapshots, all fresh"). Useful when reporting a clean run; on a drift run, the per-layer counts give a quick "where" before you walk `drifts[]`. The field is typed optional on the wire so future schema additions don't break consumers — but every `cpd scan` emits it.

7. *(Per-plugin evidence)* For `bump-needed` (and `refresh-needed` when applicable), `cpd check --json`'s `plugin.checks.install_snapshot.evidence.commitsBetween` carries the commits between the user's installed SHA and the marketplace clone HEAD, scoped to that plugin's subdir. Each entry is `{sha, subject}`; `commitsBetweenTruncated: true` indicates a cap was hit. Use the subjects to decide whether the divergence reflects real plugin code changes (bump truly needed) or docs/CI-only commits (silent no-op is correct, ignore). Falls back to absent when SHAs aren't both known or git wasn't available.

## Layer-status playbook (read `cpd check` per-layer verdicts)

Some per-layer verdicts in `cpd check` are NOT modeled as entries in `drifts[]`. Translate them by inspecting the per-layer `CheckResult` directly:

| Where | When | What to tell the user |
|---|---|---|
| `rpmPlugins[<i>].layer5.status === "stale"` | The plugin is installed via Claude Desktop's Personal-plugins UI (RPM) and the on-disk `plugin.json#version` is behind the local marketplace clone. `evidence.rpmVersion` and `evidence.cloneVersion` carry the two version strings. | "Claude Desktop's Personal-plugins copy is out of date (X vs marketplace Y)." The fix is `recommendation.action` — typically: *Open Claude Desktop → Settings → Plugins → `<name>` → Uninstall, then Install (or wait for the next auto-sync)*. No machine-runnable `cmd` because the Personal-plugins UI doesn't have a CLI surface; do NOT try to script it. |
| `rpmPlugins[<i>].layer5.status === "unknowable"` | `evidence.skipReason` explains why no comparison was possible (`marketplace-clone-unavailable`, `plugin-not-in-marketplace`, `rpm-plugin-json-missing`, etc.). | "cpd can't tell if this Personal-plugins install is current — `<reason>`." For `marketplace-clone-unavailable`, suggest adding the marketplace in standalone Claude Code via `claude plugin marketplace add <repo>` so the next check can compare. Don't try to guess freshness. |
| `cpd check <P>@<MP>` output contains an `Also installed via Claude Cowork (Personal plugins)` section | The same plugin name exists in BOTH standalone Claude Code (CCD) and Claude Desktop's Personal-plugins UI, and they may have drifted independently. Both surfaces are reported; the exit code is worst-status across them. | Surface BOTH verdicts to the user. If CCD is fresh but RPM is stale (or vice versa), the relevant fix may differ per surface — don't conflate them. The `Naming note` block (if present) explains why the two surfaces have different marketplace aliases (Cowork backend alias vs user's local `marketplace add` alias). |

## Drift-kind playbook

For each entry in `drifts[]`, recognize the kind and present accordingly. The recommendation is already in `recommendations[]`; this table is for *explaining* the situation to the user.

| `kind` | What it means | What to tell the user |
|---|---|---|
| `refresh-needed` | Local marketplace clone is behind remote; remote already has a `plugin.json#version` bump. | "Your marketplace clone is stale. Refresh it, then update the plugin." Run `claude plugin marketplace update <mp> && claude plugin update <plugin>@<mp>`. Safe. |
| `bump-needed` | Local clone is fresh but commits diverged with matching `plugin.json#version`. `claude plugin update` will be a silent no-op until the version bumps. Either the maintainer pushed code without bumping (real bump-needed) or the new commits are docs/CI-only (no-op is correct, no action needed). | Read `evidence.commitsBetween[]` (the commits between the user's install and the clone HEAD, scoped to the plugin's subdir): if the subjects show real plugin code changes, walk the maintainer through the numbered bump-and-republish steps in the recommendation. If the subjects look docs/CI-only, tell the user their install is functionally up-to-date and they can ignore. If the user is a *consumer* (not maintainer), there's no local fix — point them to filing an issue against the plugin. **Never auto-execute the version bump.** |
| `badge-only-needed` | Object-source plugin only. Source repo's `plugin.json#version` is ahead of the marketplace catalog's `marketplace.json#plugins[<plugin>].version`. CLI updates work; Desktop's "Update available" badge stays silent. | "The CLI sees the new version, but Desktop's badge reads from the catalog and is silent. The marketplace maintainer needs to bump the catalog-side version." Manual; no auto-runnable command. |
| `marketplace-update-broken` | `known_marketplaces.json#lastUpdated` was bumped recently but the local clone HEAD didn't advance. Anthropic issue #46081's silent-cooldown variant — the CLI absorbed an HTTP 304 / 429 / network blip and returned success. | "The standard refresh isn't working — Anthropic's CLI silently failed. `cpd` ships a bypass." Recommendation will be `cpd refresh <mp> --force-fetch --yes`. **`requiresYes` and `risk: "destructive"`** (writes to `.git/`, after backing up `.git/HEAD` and the origin ref). Confirm with the user before running. |
| `registration-drift` | Plugin is registered in `installed_plugins.json` but the on-disk install path is missing, or vice versa. | Either reinstall (`claude plugin install <plugin>@<mp>`) or drop the registration (`claude plugin uninstall <plugin>@<mp>`). The recommendation will pick one based on context; explain both options if the user wants to choose. |
| `skills-plugin-stuck` | A skills-plugin skill has a `stuckFailureSignature` from a failed sync. Built-ins (`schedule`, `setup-cowork`, `consolidate-memory`) and **user-created local skills** (`saveLocalSkill` IPC, manifest tags `creatorType: "user"` or `syncManaged: false`) are exempt — neither goes through the API-download path that produces this failure mode. `cpd list` annotates them `(built-in)` and `(user-created)` respectively. | "Quit and relaunch Claude Desktop." Focusing the window is unreliable — the focus handler only re-syncs if the last poll was older than the effective sync interval (defaults to 10 minutes but can be GrowthBook-configured via `skillsSyncIntervalMs` since Desktop `1.6259.1`). |
| `version-drift` / `resolver-disagreement` | Resolved version disagrees with the installed snapshot, or the CLI and Desktop badge resolvers would resolve different versions. | When `version-drift` has `ahead === "upstream"` (catalog newer than installed), the recommendation is `claude plugin update <plugin>@<mp>` and the run lifts to `exitCode: 2`. Other `ahead` values (`installed`, `incomparable`) are advisory only — surface them but don't auto-act. Often subsumed by `refresh-needed`/`bump-needed`/`badge-only-needed` when those traps cover the same plugin. |
| `runtime-boundary` | A change has landed on disk but won't take effect until a fresh task or Claude restart. | Tell the user to restart Claude Desktop or start a new task. Not destructive. Currently emitted only when `cpd` can perform a structured `plugin.json` diff between installed and resolved versions; the conservative all-surfaces fallback is suppressed (it would fire on every plugin every scan). Don't be surprised if you rarely see this kind. |
| `unsupported-source` / `npm-source-not-supported` | Marketplace was authored against a newer Claude Code (`unsupported`), or the plugin is npm-source which `cpd` does not probe in this release. | Advisory only. Tell the user; don't try to fix it. |

## Advisories

`cpd` emits `summary.advisories[]` entries (separate from `drifts[]` and `recommendations[]`) when there are facts the user should know about that aren't drift findings. Each advisory has a stable `id`, a `severity` (`info` or `warn`), a `message`, and (for some ids) a typed `details` object. Treat them as side notes — they don't block; they explain.

| `id` | When it fires | What to tell the user |
|---|---|---|
| `clean-scan-runtime-blind-spots` | Only on clean scans. Lists per-session flags cpd cannot observe: `--plugin-dir`/`--plugin-url` (session-only loads), `--bare` (skips plugin sync + many startup paths), `--channels`/`--dangerously-load-development-channels` (per-session MCP channel registration). | If the user's stale-plugin symptom only manifests in a specific session, ask whether they launched with any of these flags. Restart the session — `cpd refresh` won't help. |
| `session-plugins-disabled-detected` | Whenever ≥1 non-archived session has `pluginsEnabled: false` in its `local_<UUID>.json` sidecar. `details` carries the affected session count + first 3 most-recent IDs (truncated in human render, full in `--json`). | The session config has plugins turned off. Settings UI / CLI plugin ops still mutate disk, but the running session won't see results. Recovery: start a new session (the gate is session-config-level, not user-toggleable through Settings UI). |
| `session-skills-disabled-detected` | Same as above for `skillsEnabled: false`. The session manager logs `[LocalAgentModeSessionManager] skillsEnabled=false — skipping list_skills/save_skill/propose_skills` as the canary. | Same recovery path: start a new session. |
| `session-config-enumeration-truncated` | When a cowork root has >2048 `local_<UUID>.json` files. cpd reads the first 2048; older sessions are skipped. | Usually harmless (heavy users with hundreds of sessions). If the user's symptom traces to a specific older session that may have been cut off, point them at session cleanup. |
| `policy-settings-not-inspected` | (Reserved — currently always present in the type but never emitted in v0.1 since policy reading is integrated. Do not surface to users.) | — |

When emitting these to users, lead with the practical advice (restart session, check flags) rather than the advisory's structured shape. The `details` field is for programmatic consumers.

## Step 4 — Present the fix and get confirmation

Don't dump JSON at the user. Translate.

A good response shape (adapt to the situation — this is a starting template, not a script):

> **What's wrong:** `<plugin>@<mp>` is stale because *<plain-English explanation of the drift kind>*.
>
> **Why:** *<what specifically is out of sync — e.g. "your local marketplace clone is 4 commits behind the remote">*.
>
> **Recommended fix:** *<the recommendation's `description`>*. *<If `cmd` is present:>* I can run:
> ```bash
> <cmd>
> ```
> *<If `risk: "destructive"` or `requiresYes`:>* This writes to `<what it touches>`, after backing up `<what gets backed up>`. Confirm before I run it?
>
> *<If `requiresManualStep`:>* This needs you to do it manually. Here are the steps: *<numbered steps from the recommendation's description>*.

For multi-recommendation cases, iterate in `ordinal` order and apply the same shape per recommendation. Identical actions across multiple plugins are pre-aggregated by `cpd` into one entry with a longer `fixes[]`.

## Gotchas

- **Always parse `ok` first.** A failed `cpd` run emits an `ErrorEnvelope`, not a `ScanReport`. If you `jq '.drifts[]'` on an envelope you'll get null and miss the actual error. The error envelope has no `schemaVersion`; the report has no `ok`. Branching on `ok === false` is the cleanest discriminator.
- **`exitCode` 1 and 64 only appear in error envelopes.** They never appear inside a successful `ScanReport`. Don't write code that ignores envelopes and reads `exitCode` straight off the report.
- **Don't add `--yes` automatically.** Several `cpd` subcommands (`refresh --force-fetch`, `cache --prune-cowork-sessions`) write to disk and require `--yes`. The recommendation tells you (`requiresYes: true`); surface that to the user and let them opt in. The `session-bloat-cleanup-eligible` recommendation already includes `--yes` in its `cmd` because dry-run reclaims zero bytes — but it correctly carries `requiresYes: true` and `risk: "destructive"`, so still confirm with the user before running.
- **`cpd refresh` exit codes reflect mutation outcomes.** With `--auto-update`, a clean post-mutation scan does not mean the mutations succeeded. The report's `exitCode` is the worst of `claudeUpdate.ok`, any `chainedUpdates[].ok`, and the post-scan exit. A failed marketplace update or chained update lifts the run to 3 even if the post-scan is otherwise clean. Branch on `claudeUpdate.ok` and `chainedUpdates[].ok` if you need per-step detail.
- **Recommendations are aggregated.** `recommendations[].fixes[]` may name multiple plugins. Don't assume one rec = one plugin.
- **Phase events are append-only.** If you're consuming `--ndjson-events`, new phase types may appear in future minor versions; tolerate unknown phase names.
- **`cpd` is read-only by default.** Plain `cpd`, `cpd check`, `cpd list`, `cpd topology`, `cpd cache --orphans` never mutate user state. Only `cpd refresh --force-fetch --yes` and `cpd cache --prune-cowork-sessions --yes` write to disk. Treat the read-only default as a safety property worth preserving — there's no reason to invoke `--force-fetch` for a purely informational query.
- **Several runtime flags create blind spots cpd cannot see.** `cpd` checks on-disk state, not how Claude was launched. On clean scans `cpd` emits `summary.advisories[]` entry `clean-scan-runtime-blind-spots` (severity `info`) listing the flags this covers: (1) `--plugin-dir <path>` / `--plugin-url <url>` (session-only plugin loads under the reserved `inline` marketplace name — no marketplace clone, no `installed_plugins.json` entry); (2) `--bare` (skips plugin sync, hooks, LSP, attribution, auto-memory, background prefetches, keychain reads, CLAUDE.md auto-discovery; skills still resolve via `/skill-name`); (3) `--channels <servers...>` / `--dangerously-load-development-channels <servers...>` (per-session MCP channel server registration, lives in settings + per-session CLI args). If a user reports stale-plugin symptoms with any of these flags in use, point them at restarting the session, not at `cpd refresh`.
- **Local-only user-created skills carry the `(user-created)` annotation.** Skills authored via Desktop's `saveLocalSkill` IPC and stored locally only (`creatorType: "user"` AND `syncManaged: false` in the manifest, conjunction required) are renderer-owned and never go through the API download path — `cpd` exempts them from `skills-plugin-stuck` analogously to built-ins, and `cpd list` annotates them `(user-created)`. **Caveat:** skills that the user *uploaded* via `saveLocalSkill`'s upload branch (`save_skill` API) re-enter the sync cycle and ARE subject to the same silent-stale failure as Anthropic-managed skills. They retain `creatorType: "user"` but flip `syncManaged` to `true`, so they will NOT carry the `(user-created)` annotation and `cpd` will correctly flag them stuck. If a user reports a stuck skill they originally authored themselves, ask whether they uploaded it — that determines whether the fix is the local rebuild path or the standard skills-plugin recovery (rm + relaunch).
- **`<plugin>@inline` and `<plugin>@builtin` are CLI-internal reserved marketplace names.** `@inline` identifies a session-only plugin loaded via `--plugin-dir` / `--plugin-url`; `@builtin` identifies a plugin shipped with Claude Code itself (e.g. `claude-plugin-directory`). Neither lands in `known_marketplaces.json` or `installed_plugins.json`, so `cpd` cannot diagnose them — they're CLI stream-output identifiers, not real marketplaces. If a user pastes one, point them at runtime flags / session restart, not at any `cpd` action. (`@org-provisioned` is similar but is Desktop-wrapper-territory; the constant lives in Desktop's bundle, not the CLI. The standalone CLI does not block the name; if it slips into on-disk state, Desktop strips it on next launch.)
- **For CI/scripted plugin installs, point users at `CLAUDE_CODE_SYNC_PLUGIN_INSTALL`, not at `cpd`.** `cpd` is a diagnostic, not an install driver. The supported integration point for CI is `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1` (with optional `CLAUDE_CODE_SYNC_PLUGIN_INSTALL_TIMEOUT_MS`) plus consuming the stream-JSON `plugin_install` events (`status` cycles `started` / `installed` / `failed` / `completed`). If a user asks "how do I script plugin installs and know they finished?", that's the answer — don't recommend polling on-disk state or running `cpd` in a loop.

## References

The stable agent contract — JSON schema, exit codes, error codes, NDJSON events — lives in `docs/CLI-DESIGN.md` of the [claude-plugin-doctor repo](https://github.com/yaniv-golan/claude-plugin-doctor/blob/main/docs/CLI-DESIGN.md). Read it when you need the full schema (e.g. when handling a drift kind not in the table above).

For per-drift-kind explanations of *what to tell users in plain English*, see [`docs/TROUBLESHOOTING.md`](https://github.com/yaniv-golan/claude-plugin-doctor/blob/main/docs/TROUBLESHOOTING.md).

For which Anthropic GitHub issues each cache layer addresses, see [`docs/anthropic-issue-map.md`](https://github.com/yaniv-golan/claude-plugin-doctor/blob/main/docs/anthropic-issue-map.md).

`cpd explain` is the in-tool architecture cheat-sheet — useful when the user wants to understand the model, not just fix the symptom.
