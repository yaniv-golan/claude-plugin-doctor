# Troubleshooting

A field guide to the drift kinds `cpd` reports and what to do about each. The full taxonomy plus a six-layer cheat-sheet is what `cpd explain` prints; this file covers the cases you'll actually hit and what to type to fix them.

## "Commits diverged but plugin.json#version unchanged" (`bump-needed`)

The marketplace clone has commits your installed snapshot doesn't, but `plugin.json#version` is the same on both sides. `claude plugin update` compares versions, sees a match, and is a silent no-op. The marketplace clone is fresh — it's the version field that's stuck.

`cpd check` shows the actual commits in this plugin's subdir between your installed SHA and the clone HEAD (the "new commits" block in the evidence). Read the subjects: if they look like real plugin code changes, you need a bump; if they're docs/CI/README only, your install is functionally up-to-date and the no-op is correct.

**If you're the plugin's maintainer:**

```bash
# In the plugin's source repo:
"$EDITOR" .claude-plugin/plugin.json     # bump "version"
git commit -am "bump version to <new>"
git push
claude plugin marketplace update <mp>
claude plugin update <plugin>@<mp>
```

For object-source plugins (`source: { source: "github", ... }` in `marketplace.json`), you also need to bump `marketplace.json#plugins[<plugin>].version` in the marketplace catalog repo — otherwise the Desktop "Update available" badge stays silent. `cpd check` renders the dual-bump steps for you.

**If you're a consumer:** there's no local fix. Either confirm from the commit list that the new commits don't affect plugin functionality (in which case ignore), or open an issue against the plugin asking the maintainer to bump and republish.

## "Marketplace clone behind remote" (`refresh-needed`)

Your local marketplace clone is missing commits the remote already has. Fix the marketplace, then update the plugin:

```bash
claude plugin marketplace update <mp>
claude plugin update <plugin>@<mp>
```

## "Marketplace refresh succeeds but local clone never advances" (`marketplace-update-broken`)

Anthropic's CLI absorbs an underlying fetch failure (HTTP 304, network blip, 429 cooldown) and returns success without surfacing the error. `known_marketplaces.json#lastUpdated` gets bumped but the on-disk `.git/HEAD` doesn't. This is [Anthropic issue #46081](https://github.com/anthropics/claude-code/issues/46081).

**Fix** — `cpd` ships a bypass:

```bash
cpd refresh <mp> --force-fetch --yes
```

This runs `git fetch origin && git reset --hard origin/<default-branch>` directly on the clone, after backing up `.git/HEAD` and the origin ref under `.git/cpd-backups/`.

## "Update available" badge silent but CLI sees the new version (`badge-only-needed`)

Object-source only (github / git-subdir / url). The plugin author bumped `plugin.json#version` on the source repo, but didn't bump `marketplace.json#plugins[<plugin>].version` in the marketplace catalog. The CLI fetches from the source repo and sees the new version; the Desktop UI badge reads only the catalog and stays silent.

**Fix:** edit the marketplace catalog's `marketplace.json` and bump the catalog-side version field to match. There's no auto-runnable command — it's a catalog-maintainer edit.

## "Listed in installed_plugins.json but install path missing on disk" (`registration-drift`)

The plugin is registered as installed, but the on-disk install snapshot is gone. Common after manual cleanup, partial installs, or the orphan-leave behavior of older `claude plugin uninstall` versions ([#35691](https://github.com/anthropics/claude-code/issues/35691)).

**Fix:** reinstall, or remove the dangling registration:

```bash
claude plugin install <plugin>@<mp>      # recreate the install snapshot
# OR
claude plugin uninstall <plugin>@<mp>    # drop the registration entirely
```

## "Skill stuck loading" (`skills-plugin-stuck`)

A skills-plugin skill has a `stuckFailureSignature` in its manifest — Claude Desktop's skill-sync hit an error and recorded it. Built-in skills (`schedule`, `setup-cowork`, `consolidate-memory`) are exempt — they're rewritten on every sync from the in-bundle copy and can't go stuck via this path; `cpd` annotates them `(built-in)` and skips the trap.

**Fix:** quit and relaunch Claude Desktop. Focusing the window is unreliable — the focus handler only re-syncs if the last poll was older than the effective sync interval, which defaults to 10 minutes but can be remotely configured via the GrowthBook value `skillsSyncIntervalMs`.

## "Plugin / skill on disk but the running session isn't using it"

Two common causes. Both are session-config-level and not user-toggleable through the Settings UI per the gist:

- **`pluginsEnabled: false`** in the session's `local_<UUID>.json` sidecar — turns off both remote (RPM) and local/classic plugin mounts. Settings UI / CLI plugin ops still work and mutate disk; the running session just won't see results.
- **`skillsEnabled: false`** — turns off the skills-API tool calls (`list_skills`, `save_skill`, `propose_skills`). The session manager logs `[LocalAgentModeSessionManager] skillsEnabled=false — skipping list_skills/save_skill/propose_skills` as the canary.

`cpd` detects both by reading `<userData>/local-agent-mode-sessions/<acc>/<org>/local_<UUID>.json` files and emits `session-plugins-disabled-detected` / `session-skills-disabled-detected` advisories whenever ≥1 non-archived session has either gate set to `false`.

**Fix:** start a new task / new session. The flags are written per-session and don't apply to a fresh one.

## "I see settings-only marketplaces in `cpd list`"

Marketplaces declared via `extraKnownMarketplaces` in any of `settings.json`, `settings.local.json`, `cowork_settings.json`, or `/Library/Application Support/ClaudeCode/managed-settings.json` (incl. drop-ins under `managed-settings.d/`) are surfaced in `cpd list` with a `(settings-only: <sources>)` annotation. Their `layer1.status` is `skipped` because there's no clone to compare against.

This is intentional — these declarations are real (the CLI reads them), but until `claude plugin marketplace add <source>` materializes a clone for that root, they don't have on-disk content for `cpd` to drift-check. To materialize: run the `marketplace add` command shown in the recommendation.

## `cpd` exits with `E_PLATFORM_UNSUPPORTED` on Linux/Windows

`cpd` is macOS-only. Linux and Windows support are not yet available.

## `cpd --json | jq …` truncates / produces invalid JSON

If you see truncation, file an issue with the run's NDJSON log (`~/.claude-plugin-doctor/logs/cpd-<timestamp>.log`).

## `cpd check <plugin>@<mp>` says "not installed" but the plugin is installed

Run with no flags first — `cpd` walks both standalone Claude Code and Claude Cowork by default. If you originally passed `--mode cowork` (or `--mode ccd`) and the plugin is in the other install, `cpd` will fall back and surface a one-line note explaining what it found.

## `cpd refresh <mp>` says "is not registered" or "no local clone" but `cpd scan` lists the marketplace

`refresh <mp>` operates on the plugins root that *owns* the named marketplace — standalone Claude Code (CCD, `~/.claude/plugins/`) or a specific Claude Cowork root. A marketplace registered in one root stays refreshable even when the other root was used more recently. To force a specific root instead, pass `--mode ccd` or `--mode cowork` (or pin a Cowork root with `--cowork-account <id> --cowork-org <id>`) — an explicit choice is honored as-is and is not auto-redirected.

If you are on `cpd` ≤ 0.3.0, upgrade: earlier versions picked the root for `refresh`/`list` by `installed_plugins.json` modification time, so a marketplace living in the other root would be reported "is not registered" (or `--force-fetch` would say "no local clone") even though `cpd scan` listed it. As a workaround on the older version, force the owning root with `--mode ccd` / `--mode cowork`.

## I want to see what `cpd` is doing in real time

```bash
# Stream phase events to stderr
cpd --ndjson-events

# Or to a file
cpd --ndjson-events --events-file run.ndjson

# Tail the always-on NDJSON log file
tail -f ~/.claude-plugin-doctor/logs/cpd-*.log
```

## I want to suppress all logs

```bash
cpd --no-log-file --no-progress --quiet
```

`--quiet` silences progress and the human report; combine with `--json` if you still want machine-readable output.

## Anything else

- `cpd explain` — in-tool architecture cheat-sheet and status legend.
- [`docs/CLI-DESIGN.md`](CLI-DESIGN.md) — the full agent/script contract.
- [`docs/anthropic-issue-map.md`](anthropic-issue-map.md) — which Anthropic GitHub issues each cache layer addresses.
- [Architecture & Design Gist](https://gist.github.com/yaniv-golan/6c95c08aba98fc8218ef13e99461822f) — the canonical reference for how the six layers fit together.

Still stuck? Open an issue with `cpd --json` output (or the run's log file) attached.
