**What's wrong:** `my-dev-plugin@local-mp` isn't actually stale on the marketplace clone — your local clone is fresh and matches the remote (`headLocal == headRemote`, 0 commits behind). The problem is that you've been pushing code commits without bumping `plugin.json#version`. It's still `0.1.0` on every commit.

**Why this blocks updates:** `claude plugin update` compares the installed version against the marketplace version. Both read `0.1.0`, so it sees a match and stops — that's why it keeps reporting "already at latest version." The CLI never looks at git SHAs; it only looks at the `version` field. Same story for `installedGitCommitSha` (`111aaa…`) vs `marketplaceCloneHead` (`deadbeef…`) — different commits, identical version string, so the update path treats them as equivalent.

**Recommended fix (manual — you have to do this yourself):**

1. Edit `plugin.json` in your marketplace repo and bump `version`, e.g. `0.1.0` → `0.1.1`.
2. `git commit -am 'bump version to 0.1.1'`
3. `git push`
4. `claude plugin marketplace update local-mp`
5. `claude plugin update my-dev-plugin@local-mp`

From now on, every time you push plugin code changes that you want users (including yourself) to pick up, bump `plugin.json#version` in the same commit. No version bump = no update, by design.

There's nothing for me to auto-run here — the version bump has to come from you, in your repo. Once you've pushed the bumped commit, steps 4 and 5 are the standard refresh-then-update pair and I can run those for you if you'd like.
