# Diagnosis: marketplace clone is stale

Your local clone of `acme-marketplace` is **4 commits behind** its git remote. That's why `claude plugin update` says "already at latest version" — from the CLI's perspective, the latest *known* version is still 0.3.1, because the marketplace metadata it reads hasn't been re-fetched yet. Version 0.4.0 exists on the remote, but your local marketplace clone hasn't pulled it.

## What the cpd output shows

- **Marketplace clone** (`~/.claude/plugins/marketplaces/acme-marketplace`): HEAD is `e5f6g7h8…`, but the remote HEAD is `a1b2c3d4…` — 4 commits behind.
- **Install snapshot**: `proof-engine` 0.3.1 is installed, and its recorded `marketplaceCloneHead` matches the (stale) local clone HEAD — so the install is consistent with what your clone currently knows about, just not with reality.
- **Resolvers**: the CLI and badge resolve to 0.4.0 from `marketplace.json`, but the session-start path resolves to 0.3.1 from `installed_plugins.json` — i.e. Claude Desktop is still loading the version pinned at session start.
- **Drift**: a single `refresh-needed` drift on `proof-engine@acme-marketplace`.

## Why `claude plugin update` lied to you

`claude plugin update` only consults the **local marketplace clone**. It doesn't run `git fetch` first. So when the clone is behind the remote, the CLI genuinely believes 0.3.1 is the latest — there's no newer version in the metadata it has on disk.

## Fix — exact commands

Run these in order:

```sh
claude plugin marketplace update acme-marketplace && claude plugin update proof-engine@acme-marketplace
```

This is the safe, single recommendation `cpd` produced (rec-1). It:

1. Refreshes the local marketplace clone from `git@github.com:acme/marketplace.git` (pulls in the 4 missing commits, including the 0.4.0 release entry).
2. Re-runs the plugin update — which will now actually see 0.4.0 and install it.

After it finishes, **fully quit and reopen Claude Desktop** so the next `sessionStart` re-reads `installed_plugins.json` and loads the new version. (A reload-window inside Claude is not enough; the resolver picks the version at session boot.)

## Verify

Re-run `cpd --json --no-progress --no-log-file` — you should see:

- `marketplaceCaches.acme-marketplace[0].behindCommits: 0`
- `caches.proof-engine@acme-marketplace[0].installedVersion: "0.4.0"`
- `drifts: []`
- `exitCode: 0`
