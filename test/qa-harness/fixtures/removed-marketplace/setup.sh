#!/usr/bin/env bash
# Fixture: removed-marketplace — marketplace was removed from
# known_marketplaces.json but the cache subtree at
# `cache/<mp>/<plugin>/<ver>/` was left behind. Should be reported as
# `unknown-marketplace` stray (reason key, NOT "temp-staging-dir") so
# the user knows to clean the dir or re-register the marketplace.
set -euo pipefail

home="${1:-}"
[ -n "$home" ] || { echo "usage: setup.sh <HOME>" >&2; exit 64; }

plugins_root="$home/.claude/plugins"

# Cache for `foo` exists with a real plugin install snapshot.
mkdir -p "$plugins_root/cache/foo/plugin/1.0.0"
echo "alpha" > "$plugins_root/cache/foo/plugin/1.0.0/a.txt"
truncate -s 64K "$plugins_root/cache/foo/plugin/1.0.0/data.bin"

# But `known_marketplaces.json` only knows `bar` — `foo` was removed.
mkdir -p "$plugins_root/marketplaces/bar"
cat > "$plugins_root/known_marketplaces.json" <<'EOF'
{
  "bar": { "source": { "source": "github", "repo": "bar/marketplace" } }
}
EOF

# Empty installed_plugins (no references, but that's not what's being
# tested — the parent dir is mismatched, so per-plugin orphan walk
# never even runs for `foo/`).
echo '{"version":2,"plugins":{}}' > "$plugins_root/installed_plugins.json"
