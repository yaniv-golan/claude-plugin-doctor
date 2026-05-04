**What's wrong:** Your `claude plugin marketplace update founder-skills` runs are succeeding on the surface but not actually fetching anything. Your local marketplace clone is **27 commits behind** the GitHub remote, even though `known_marketplaces.json#lastUpdated` was bumped yesterday (2026-05-02). That mismatch — `lastUpdated` advancing while the clone HEAD doesn't move — is the fingerprint of Anthropic issue #46081: the CLI silently absorbs an HTTP 304 / 429 / cooldown response and returns success without doing the fetch. Because the clone never moves, the install snapshot stays pinned at 0.2.0 and every resolver (CLI, badge, sessionStart) reports 0.2.0.

**Why nothing you tried worked:** `claude plugin marketplace update` is the tool that's broken here. Running it more times keeps hitting the same silent cooldown. There is no flag on the stock CLI to bypass it.

**Recommended fix:** `cpd` ships a force-fetch bypass. It runs `git fetch origin && git reset --hard origin/<default-branch>` directly against the marketplace clone at `/Users/me/.claude/plugins/marketplaces/founder-skills`, after backing up `.git/HEAD` and the origin ref to `.git/cpd-backups/`.

```bash
cpd refresh founder-skills --force-fetch --yes
```

This is **destructive** — it writes inside the clone's `.git/` and hard-resets the working tree to match origin. Backups go to `.git/cpd-backups/` so it's recoverable, but I want your sign-off before running it. **Confirm and I'll run it.**

After it succeeds, you'll still need one follow-up to actually install the new version into the snapshot:

```bash
claude plugin update founder-skills@founder-skills
```

Then a fresh Claude task / restart to cross the runtime boundary.
