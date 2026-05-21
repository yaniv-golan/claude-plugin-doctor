---
"claude-plugin-doctor": minor
---

Active-Cowork-session pick now considers both `installed_plugins.json` and `rpm/manifest.json` mtimes (max of the two). Personal-plugins UI installs touch only `rpm/manifest.json`, so the previous "installed_plugins.json mtime only" heuristic misclassified sessions whose most recent activity was a Personal-plugins install — causing `cpd scan`/`check` to inspect the wrong session and miss stale Personal-plugins installs entirely. SPEC §3.3 Layer 3 and §15 updated. `CoworkRoot` and `CoworkRootInfo` gain an `rpmManifestMtime?: number` field; `active-root` exports a new `effectiveActiveMtime(root)` helper.
