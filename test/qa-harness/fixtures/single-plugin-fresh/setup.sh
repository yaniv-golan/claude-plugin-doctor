#!/usr/bin/env bash
# Fixture: single-plugin-fresh — happy path. One marketplace, one
# plugin, version matches. Marketplace has a real git repo (matching
# what cpd expects under marketplaces/<mp>/). Layer-1 expects to find
# .claude-plugin/marketplace.json with the plugin entry.
set -euo pipefail

home="${1:-}"
[ -n "$home" ] || { echo "usage: setup.sh <HOME>" >&2; exit 64; }

plugins_root="$home/.claude/plugins"

# Marketplace clone with valid marketplace.json.
mp_dir="$plugins_root/marketplaces/acme"
mkdir -p "$mp_dir/.claude-plugin"
cat > "$mp_dir/.claude-plugin/marketplace.json" <<'EOF'
{
  "name": "acme",
  "owner": { "name": "test" },
  "plugins": [
    { "name": "widget", "version": "1.0.0",
      "source": { "source": "github", "repo": "acme/widget" } }
  ]
}
EOF

# Make it a real git repo so layer-1 doesn't flag clone-not-a-repo.
(cd "$mp_dir" && git init -q && git config user.email t@t && git config user.name t \
  && git add . && git commit -q -m init) >/dev/null 2>&1

# Install snapshot under cache/<mp>/<plugin>/<ver>/.
snap="$plugins_root/cache/acme/widget/1.0.0"
mkdir -p "$snap/.claude-plugin"
cat > "$snap/.claude-plugin/plugin.json" <<'EOF'
{ "name": "widget", "version": "1.0.0" }
EOF

# Registries.
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
