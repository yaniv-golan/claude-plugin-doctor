#!/usr/bin/env bash
# Fixture: no-network-mode — same setup as single-plugin-stale, but
# the harness's --no-network flag suppresses upstream probes. Verifies
# that cpd does NOT falsely declare "everything fresh" when it cannot
# reach the upstream (the original honest-inconclusive bug class).
#
# Layer-2 (install-snapshot) can still detect drift from local sources
# alone (marketplace.json says 1.0.2, installed is 1.0.0), so list and
# check should still exit 2 — but the layer-1 verdict must be
# "unknowable" or equivalent, not "fresh".
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
