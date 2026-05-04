## What's happening

Your `claude plugin marketplace update` command is reporting success but doing nothing — a known Claude Code bug (Anthropic issue #46081). The CLI silently absorbs HTTP 304/429 responses during a fetch cooldown, so the marketplace clone never actually pulls. Every layer downstream of that clone is therefore frozen at the old commit.

Here's the picture cpd shows:

| Layer | Commit | Status |
|---|---|---|
| GitHub remote (`origin/HEAD`) | `bc04331…` | current |
| Local marketplace clone (`~/.claude/plugins/marketplaces/founder-skills`) | `b54ecd5…` | **27 commits behind** |
| Install snapshot at `cache/founder-skills/founder-skills/0.2.0` | `b54ecd5…` | matches the stale clone |
| All resolvers (CLI, badge, sessionStart) | `0.2.0` | reading from the stale clone / `installed_plugins.json` |

So nothing is corrupt and nothing is "out of sync" between your local layers — they're all consistent with each other. The problem is upstream: the marketplace clone itself isn't being fast-forwarded. Re-running `marketplace update` will keep reporting success and keep doing nothing until the cooldown clears (which can take much longer than a week if the server keeps returning 304).

## What to do

Run cpd's force-fetch, which bypasses the broken CLI path by running `git fetch` + `git reset --hard origin/<default>` directly on the clone (after backing up `.git/HEAD` and the origin ref to `.git/cpd-backups/`):

```
cpd refresh founder-skills --force-fetch --yes
```

This is marked **destructive** because it hard-resets the marketplace clone — that's safe here since the clone is meant to mirror the remote and you have no local commits in it, but the `--yes` is required for that reason.

After it completes:

1. The marketplace clone will be at `bc04331…`.
2. Run `claude plugin install founder-skills@founder-skills` (or whatever your normal install command is) to populate a new `cache/founder-skills/founder-skills/<new-version>/` snapshot from the refreshed clone. The old `0.2.0` snapshot will remain on disk until you prune it — that's fine, it just won't be the resolved version anymore.
3. Restart Claude Code so the resolvers re-read `installed_plugins.json`.
4. Re-run `cpd` to confirm `behindCommits: 0` and the new version showing in `resolvers`.

If you want to verify before pulling the trigger, add `--dry-run` to the refresh command — it'll print the exact git operations it would run without touching anything.
