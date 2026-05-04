#!/usr/bin/env bash
# Fixture: bump-needed-aggregated — three plugins from the same
# marketplace, all installed at 1.0.0, marketplace advertises 2.0.0.
#
# Original intent: force the bump-needed aggregator in
# src/recommendations/plan.ts to collapse three drifts into ONE action.
# True bump-needed firing requires (1) git-commit divergence between
# install snapshot and clone HEAD AND (2) marketplace clone status ==
# "fresh" — under --no-network the layer-1 probe can't establish
# "fresh", so v0.1.0 produces three separate `action:version-drift:*`
# recs instead of one aggregated bump-needed.
#
# Today's value: exercises IT-13 across multiple synthetic per-plugin
# actions in one run (one rec per plugin, all carrying valid recipes).
# When v0.2 introduces true bump-needed coverage under --no-network,
# this fixture flips into single-aggregated-action mode automatically.
set -euo pipefail

home="${1:-}"
[ -n "$home" ] || { echo "usage: setup.sh <HOME>" >&2; exit 64; }

plugins_root="$home/.claude/plugins"

# Marketplace clone with three plugins — all at 2.0.0 upstream.
mp_dir="$plugins_root/marketplaces/acme"
mkdir -p "$mp_dir/.claude-plugin"
# Plugins use STRING source so CliUpdateSim resolves the upstream version
# from marketplace.json without needing a network probe (object/github
# sources return `indeterminate-no-network` under --no-network — see
# src/resolvers/cli-update.ts:117). String sources are the v0.1.0
# happy-path for offline bump-needed exercise.
cat > "$mp_dir/.claude-plugin/marketplace.json" <<'EOF'
{
  "name": "acme",
  "owner": { "name": "test" },
  "plugins": [
    { "name": "alpha", "version": "2.0.0", "source": "./alpha" },
    { "name": "beta",  "version": "2.0.0", "source": "./beta"  },
    { "name": "gamma", "version": "2.0.0", "source": "./gamma" }
  ]
}
EOF
(cd "$mp_dir" && git init -q && git config user.email t@t && git config user.name t \
  && git add . && git commit -q -m init) >/dev/null 2>&1

# Three install snapshots, all at 1.0.0 (one minor behind upstream).
declare_plugin() {
  local name="$1"
  local snap="$plugins_root/cache/acme/$name/1.0.0"
  mkdir -p "$snap/.claude-plugin"
  cat > "$snap/.claude-plugin/plugin.json" <<EOF
{ "name": "$name", "version": "1.0.0" }
EOF
  echo "$snap"
}
SNAP_ALPHA=$(declare_plugin alpha)
SNAP_BETA=$(declare_plugin beta)
SNAP_GAMMA=$(declare_plugin gamma)

cat > "$plugins_root/known_marketplaces.json" <<'EOF'
{ "acme": { "source": { "source": "github", "repo": "acme/marketplace" } } }
EOF

cat > "$plugins_root/installed_plugins.json" <<EOF
{
  "version": 2,
  "plugins": {
    "alpha@acme": [ { "scope": "user", "version": "1.0.0", "installPath": "$SNAP_ALPHA" } ],
    "beta@acme":  [ { "scope": "user", "version": "1.0.0", "installPath": "$SNAP_BETA"  } ],
    "gamma@acme": [ { "scope": "user", "version": "1.0.0", "installPath": "$SNAP_GAMMA" } ]
  }
}
EOF
