#!/usr/bin/env bash
# Fixture: marketplace-named-temp — a user legitimately registered a
# marketplace named `temp_legitimate` in known_marketplaces.json. The
# orphan walker MUST honor known-marketplace membership over the
# `temp_*` name pattern; otherwise the user's marketplace would be
# reported as a stray staging dir (suggesting deletion).
#
# Oracle implements the DESIRED precedence (known-mp wins). Today's
# cpd implementation matches; this fixture pins it so a future
# refactor that swaps the precedence order is caught.
set -euo pipefail

home="${1:-}"
[ -n "$home" ] || { echo "usage: setup.sh <HOME>" >&2; exit 64; }

plugins_root="$home/.claude/plugins"

# Marketplace registered under a temp_-prefixed name — fully legitimate.
mkdir -p "$plugins_root/marketplaces/temp_legitimate"
cat > "$plugins_root/known_marketplaces.json" <<'EOF'
{ "temp_legitimate": { "source": { "source": "github", "repo": "user/temp_legitimate" } } }
EOF

# A real plugin install snapshot under that marketplace.
mkdir -p "$plugins_root/cache/temp_legitimate/myplugin/1.0.0"
echo "ok" > "$plugins_root/cache/temp_legitimate/myplugin/1.0.0/a.txt"

# installed_plugins references the snapshot — so it's NOT an orphan
# either. The dir under cache/ is a real, in-use install snapshot of
# a real, registered marketplace. cache --orphans should report ZERO.
cat > "$plugins_root/installed_plugins.json" <<EOF
{
  "version": 2,
  "plugins": {
    "myplugin@temp_legitimate": [
      { "scope": "user", "version": "1.0.0",
        "installPath": "$plugins_root/cache/temp_legitimate/myplugin/1.0.0" }
    ]
  }
}
EOF
