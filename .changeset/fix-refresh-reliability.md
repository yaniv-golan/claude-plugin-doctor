---
"claude-plugin-doctor": patch
---

fix(refresh): three reliability fixes on the refresh path.

- Discovery: a malformed/locked `known_marketplaces.json` in one Cowork root no longer aborts `scan`/`refresh`/`list` for every marketplace — the bad root is skipped.
- `refresh <marketplace>` now targets the plugins root that actually owns the named marketplace (CCD or a specific Cowork root) instead of the single root picked by `installed_plugins.json` mtime. Previously, when a Cowork root had a newer mtime, `cpd refresh <ccd-marketplace>` resolved the Cowork root and failed with "is not registered" or "no local clone" — even though `cpd scan` listed the marketplace fine. Prefers the root with the clone on disk; honors an explicit `--cowork-account/--cowork-org` pin.
- `--force-fetch` no longer refuses with "no local clone (must be a github/git source…)" when a clone is present on disk but the scan could not resolve its HEAD (mid-upgrade with `marketplace.json` absent, corrupt/detached HEAD). It now gates on the clone dir existing and being a git repo — all `git fetch && git reset --hard` needs — with a distinct, path-specific message per failure case.

Behavior change: the old force-fetch guard implicitly rejected every non-github/git source (they never populate `headLocal`); the new gate refuses a source only if its `marketplaces/<name>` dir isn't a git repo. A `directory`-source marketplace whose dir happens to be a git repo now reaches the bypass, which fails cleanly at branch resolution (no `origin`) without mutating.
