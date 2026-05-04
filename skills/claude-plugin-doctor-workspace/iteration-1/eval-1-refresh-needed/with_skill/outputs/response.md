**What's wrong:** `proof-engine@acme-marketplace` is stale because your **local marketplace clone is behind the remote**. That's why `claude plugin update` reported "already at latest version" — it only consults the local clone, and your local clone doesn't yet know 0.4.0 exists.

**Why specifically:**

- Local marketplace clone HEAD: `e5f6g7h8...` — **4 commits behind** remote.
- Remote HEAD: `a1b2c3d4...` (this is where 0.4.0 lives).
- Installed snapshot: `0.3.1` (matches the stale clone, so `claude plugin update` thinks it's already current).
- Resolvers confirm it: once the clone is refreshed, both the CLI and Desktop badge will resolve `0.4.0` from `marketplace.json`.

So the marketplace catalog the CLI is reading is itself out of date — refresh that first, then the update will actually do something.

**Recommended fix (safe, two commands chained):**

```bash
claude plugin marketplace update acme-marketplace && claude plugin update proof-engine@acme-marketplace
```

The first command fast-forwards your local clone of `acme-marketplace` to the remote. The second then sees `0.4.0` in the refreshed catalog and installs it. Both are read/write operations performed by the official `claude` CLI (no `cpd` mutations needed) and are non-destructive.

Want me to run it?

**If `marketplace update` reports success but the clone HEAD still doesn't advance** (rare — Anthropic issue #46081's silent-cooldown variant), come back and re-run `cpd --json --no-progress --no-log-file`. In that case the drift kind would change to `marketplace-update-broken` and the fix would shift to `cpd refresh acme-marketplace --force-fetch --yes`. But your current scan shows the standard refresh path is clear, so try the commands above first.
