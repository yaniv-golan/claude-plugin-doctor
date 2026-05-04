You're not doing anything wrong with git — your commits are pushed and the marketplace clone is fully up to date (local HEAD `deadbeef…` matches the remote). The problem is one level up: **you haven't bumped `version` in `plugin.json`.**

`claude plugin update` is version-driven, not commit-driven. It compares the `version` field in your `plugin.json` against what's installed. Both are `0.1.0`, so it concludes "already at latest version" and does nothing — even though the underlying commit (`111aaa2…`) is different from the marketplace clone's HEAD.

cpd flagged this as a `bump-needed` drift on `my-dev-plugin@local-mp`.

## Fix

1. Edit `plugin.json` and bump `version`, e.g. `0.1.0` → `0.1.1`.
2. `git commit -am 'bump version to 0.1.1'`
3. `git push`
4. `claude plugin marketplace update local-mp` (refresh the marketplace clone so it sees the new version).
5. `claude plugin update my-dev-plugin@local-mp`

## Workflow tip

For an active dev loop, bump the version on every change you want `update` to pick up. A pre-push hook that auto-bumps the patch version (or a `npm version patch`-style script) takes the friction out. Without a bump, `claude plugin update` will keep no-op'ing no matter how many commits you push.
