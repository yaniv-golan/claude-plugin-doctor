# Anthropic issue map

This file lists the open or closed-as-duplicate Anthropic GitHub issues that motivate `claude-plugin-doctor`. PRs that change behavior in `src/caches/` should reference at least one issue from this list (or explain why the change doesn't map to one).

| # | Title | Cache layer it touches |
|---|---|---|
| [46081](https://github.com/anthropics/claude-code/issues/46081) | `claude plugin update` uses stale marketplace cache — reports "already at latest version" when new commits exist | Marketplace clone (Layer 1); install snapshot (Layer 2) |
| [13799](https://github.com/anthropics/claude-code/issues/13799) | Plugin cache not invalidated when marketplace is updated — stale paths used | Install snapshot (Layer 2) |
| [52218](https://github.com/anthropics/claude-code/issues/52218) | Plugin `autoUpdate` doesn't update `installed_plugins.json`, leaving bundled hooks pinned to stale `installPath` | Install snapshot (Layer 2) |
| [48675](https://github.com/anthropics/claude-code/issues/48675) | Marketplace load failures fail silently — request for `/plugin doctor` | All layers |
| [19197](https://github.com/anthropics/claude-code/issues/19197) | `plugin update` doesn't re-download files when version changes | Install snapshot (Layer 2) |
| [15642](https://github.com/anthropics/claude-code/issues/15642) | Plugin cache: `CLAUDE_PLUGIN_ROOT` points to stale version after plugin update | Install snapshot (Layer 2) |
| [35691](https://github.com/anthropics/claude-code/issues/35691) | `/plugin uninstall` removes from `installed_plugins.json` but leaves cached files on disk | Install snapshot (Layer 2); orphan-cache cleanup |
| [12457](https://github.com/anthropics/claude-code/issues/12457) | `claude plugin install` succeeds but fails to persist plugin to `installed_plugins.json` for local directory marketplaces | Install snapshot (Layer 2) |
| [26951](https://github.com/anthropics/claude-code/issues/26951) | Cowork macOS — plugin install fails with HTTP 404 | Per-account/org Cowork mirror (Layer 3) |
| claude-plugins-official [#460](https://github.com/anthropics/claude-plugins-official/issues/460) | Missing `version` field causes cache bloat | Install snapshot (Layer 2); resolver fallbacks |

## Trap-taxonomy mapping

`cpd` classifies each detected drift into one of these kinds. The mapping below explains how the upstream issues land in the taxonomy.

- **`refresh-needed`** — local marketplace clone is behind remote; remote may already carry a `plugin.json#version` bump that the CLI would pick up after `claude plugin marketplace update`. **#46081** is canonically this kind.
- **`bump-needed`** — local clone fresh; commits diverged with matching versions. The classic plugin-author footgun: editing+pushing without bumping `plugin.json#version`. **#13799** is canonically this kind.
- **`badge-only-needed`** — object-source plugins where remote `plugin.json#version` ≠ `marketplace.json#plugins[].version`. CLI updates work; Desktop's "Update available" badge stays silent.
- **`marketplace-update-broken`** — `known_marketplaces.json#lastUpdated` is recent but local clone HEAD didn't advance. Anthropic issue **#46081**'s 429 cooldown variant. `cpd refresh --force-fetch` is the bypass.
- **`registration-drift`** — `installed_plugins.json` says installed but the on-disk install is missing (or vice-versa). Maps to **#35691**, **#12457**.
- **`unsupported-source`** — marketplace was authored against a newer Claude Code. Surfaces "upgrade Claude Code" advisory.

The full integration test suite covering each of these issues is on the v1.x roadmap.
