#!/usr/bin/env bash
# Fixture: single-plugin-stale — installed=1.0.0, marketplace=1.0.2,
# install dir at 1.0.0/. Layer-2 (install-snapshot) should detect drift
# (version-drift, ahead: "upstream"). cpd scan exits 2; check should
# also exit 2 with a recommendation.
set -euo pipefail

home="${1:-}"
[ -n "$home" ] || { echo "usage: setup.sh <HOME>" >&2; exit 64; }

plugins_root="$home/.claude/plugins"

mp_dir="$plugins_root/marketplaces/acme"
mkdir -p "$mp_dir/.claude-plugin"
cat > "$mp_dir/.claude-plugin/marketplace.json" <<'EOF'
{
  "name": "acme",
  "owner": { "name": "test" },
  "plugins": [
    { "name": "widget", "version": "1.0.2",
      "source": { "source": "github", "repo": "acme/widget" } }
  ]
}
EOF
(cd "$mp_dir" && git init -q && git config user.email t@t && git config user.name t \
  && git add . && git commit -q -m init) >/dev/null 2>&1

# Install snapshot at OLD version 1.0.0.
snap="$plugins_root/cache/acme/widget/1.0.0"
mkdir -p "$snap/.claude-plugin"
cat > "$snap/.claude-plugin/plugin.json" <<'EOF'
{ "name": "widget", "version": "1.0.0" }
EOF

cat > "$plugins_root/known_marketplaces.json" <<'EOF'
{ "acme": { "source": { "source": "github", "repo": "acme/widget" } } }
EOF
cat > "$plugins_root/installed_plugins.json" <<EOF
{
  "version": 2,
  "plugins": {
    "widget@acme": [
      { "scope": "user", "version": "1.0.0", "installPath": "$snap" }
    ]
  }
}
EOF
