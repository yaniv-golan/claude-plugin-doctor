---
name: claude-plugin-doctor
description: >-
  Use for diagnosing and fixing Claude Code / Claude Desktop plugin staleness, stuck updates, and cache drift. Triggers when a plugin keeps loading an old version, when `claude plugin update` or `claude plugin marketplace update` says "already at latest" but isn't, when a `plugin.json` version bump doesn't show up in Desktop's "Update available" badge, when an installed plugin's files are missing on disk, when a manually-deleted plugin breaks Desktop, when skills/commands won't refresh after marketplace pushes, or when the user mentions `cpd`, `claude-plugin-doctor`, or drift kinds like `marketplace-update-broken`, `bump-needed`, `badge-only-needed`, `registration-drift`, `skills-plugin-stuck`. Runs the `cpd` CLI to pinpoint which of six cache layers is stale and recommends the safest fix, confirming before any destructive action.
compatibility: "Requires `cpd` on PATH (`npm i -g claude-plugin-doctor`). macOS-only. Designed for Claude Code and Claude Cowork (shared plugin runtime)."
metadata:
  author: Yaniv Golan
  version: 0.1.0
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

## Drift-kind playbook

For each entry in `drifts[]`, recognize the kind and present accordingly. The recommendation is already in `recommendations[]`; this table is for *explaining* the situation to the user.

| `kind` | What it means | What to tell the user |
|---|---|---|
| `refresh-needed` | Local marketplace clone is behind remote; remote already has a `plugin.json#version` bump. | "Your marketplace clone is stale. Refresh it, then update the plugin." Run `claude plugin marketplace update <mp> && claude plugin update <plugin>@<mp>`. Safe. |
| `bump-needed` | Local clone is fresh but commits diverged with matching `plugin.json#version`. `claude plugin update` will be a silent no-op until the version bumps. Either the maintainer pushed code without bumping (real bump-needed) or the new commits are docs/CI-only (no-op is correct, no action needed). | Read `evidence.commitsBetween[]` (the commits between the user's install and the clone HEAD, scoped to the plugin's subdir): if the subjects show real plugin code changes, walk the maintainer through the numbered bump-and-republish steps in the recommendation. If the subjects look docs/CI-only, tell the user their install is functionally up-to-date and they can ignore. If the user is a *consumer* (not maintainer), there's no local fix — point them to filing an issue against the plugin. **Never auto-execute the version bump.** |
| `badge-only-needed` | Object-source plugin only. Source repo's `plugin.json#version` is ahead of the marketplace catalog's `marketplace.json#plugins[<plugin>].version`. CLI updates work; Desktop's "Update available" badge stays silent. | "The CLI sees the new version, but Desktop's badge reads from the catalog and is silent. The marketplace maintainer needs to bump the catalog-side version." Manual; no auto-runnable command. |
| `marketplace-update-broken` | `known_marketplaces.json#lastUpdated` was bumped recently but the local clone HEAD didn't advance. Anthropic issue #46081's silent-cooldown variant — the CLI absorbed an HTTP 304 / 429 / network blip and returned success. | "The standard refresh isn't working — Anthropic's CLI silently failed. `cpd` ships a bypass." Recommendation will be `cpd refresh <mp> --force-fetch --yes`. **`requiresYes` and `risk: "destructive"`** (writes to `.git/`, after backing up `.git/HEAD` and the origin ref). Confirm with the user before running. |
| `registration-drift` | Plugin is registered in `installed_plugins.json` but the on-disk install path is missing, or vice versa. | Either reinstall (`claude plugin install <plugin>@<mp>`) or drop the registration (`claude plugin uninstall <plugin>@<mp>`). The recommendation will pick one based on context; explain both options if the user wants to choose. |
| `skills-plugin-stuck` | A skills-plugin skill has a `stuckFailureSignature` from a failed sync. Built-ins (`schedule`, `setup-cowork`, `consolidate-memory`) are exempt. | "Quit and relaunch Claude Desktop." Focusing the window is unreliable — the focus handler only re-syncs if the last poll was more than 10 minutes ago. |
| `version-drift` / `resolver-disagreement` | Resolved version disagrees with the installed snapshot, or the CLI and Desktop badge resolvers would resolve different versions. | When `version-drift` has `ahead === "upstream"` (catalog newer than installed), the recommendation is `claude plugin update <plugin>@<mp>` and the run lifts to `exitCode: 2`. Other `ahead` values (`installed`, `incomparable`) are advisory only — surface them but don't auto-act. Often subsumed by `refresh-needed`/`bump-needed`/`badge-only-needed` when those traps cover the same plugin. |
| `runtime-boundary` | A change has landed on disk but won't take effect until a fresh task or Claude restart. | Tell the user to restart Claude Desktop or start a new task. Not destructive. Currently emitted only when `cpd` can perform a structured `plugin.json` diff between installed and resolved versions; the conservative all-surfaces fallback is suppressed (it would fire on every plugin every scan). Don't be surprised if you rarely see this kind. |
| `unsupported-source` / `npm-source-not-supported` | Marketplace was authored against a newer Claude Code (`unsupported`), or the plugin is npm-source which `cpd` does not probe in this release. | Advisory only. Tell the user; don't try to fix it. |

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

## References

The stable agent contract — JSON schema, exit codes, error codes, NDJSON events — lives in `docs/CLI-DESIGN.md` of the [claude-plugin-doctor repo](https://github.com/yaniv-golan/claude-plugin-doctor/blob/main/docs/CLI-DESIGN.md). Read it when you need the full schema (e.g. when handling a drift kind not in the table above).

For per-drift-kind explanations of *what to tell users in plain English*, see [`docs/TROUBLESHOOTING.md`](https://github.com/yaniv-golan/claude-plugin-doctor/blob/main/docs/TROUBLESHOOTING.md).

For which Anthropic GitHub issues each cache layer addresses, see [`docs/anthropic-issue-map.md`](https://github.com/yaniv-golan/claude-plugin-doctor/blob/main/docs/anthropic-issue-map.md).

`cpd explain` is the in-tool architecture cheat-sheet — useful when the user wants to understand the model, not just fix the symptom.
