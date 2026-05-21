---
"claude-plugin-doctor": minor
---

Layer 5 (RPM / Personal Plugins) now performs a no-network version comparison against the local marketplace clone, so stale Personal-plugins installs are detected instead of being reported as "fresh" on dir-existence alone.

For each RPM-installed plugin, cpd reads `<rpm-root>/<plugin-id>/.claude-plugin/plugin.json#version` and compares it against the same plugin's version in the local marketplace clone (priority: clone's `plugin.json` → `marketplace.json#plugins[].version`). The clone lookup tries the exact `marketplaceName` first, then falls back to cross-referencing by plugin name across registered marketplaces (Cowork's backend alias often differs from the user's CCD-side alias — e.g. `proof-engine` vs `proof-engine-marketplace`). Orphan directories not declared in `known_marketplaces.json` are excluded from the cross-reference, so leftover `.bak` clones don't cause spurious ambiguity. When no comparable clone is locally available the verdict is `unknowable` (per user preference: no version-comparison fallbacks).

Both `checkRpmCopy` (CheckResult) and `snapshotRpmCopy` (CacheSnapshot) accept the new `marketplaceClone` input; `RpmCopyData` gains `versionDelta` and `versionDeltaSkipReason` evidence fields. Calls without the new field fall back to the legacy directory-existence verdict for backward compatibility.
