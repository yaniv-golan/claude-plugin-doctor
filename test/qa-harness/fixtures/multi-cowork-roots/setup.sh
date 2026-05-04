#!/usr/bin/env bash
# Fixture: multi-cowork-roots — three Cowork roots under
# `<userdata>/local-agent-mode-sessions/<acc>/<org>/cowork_plugins/`,
# all registering the same marketplace+plugin pair. Verifies that
# topology reports 3 cowork roots and list aggregates correctly across
# them. (Scan-side drift dedup will be exercised by the scan validator
# when it lands; this fixture pins the topology/list shape today.)
set -euo pipefail

home="${1:-}"
[ -n "$home" ] || { echo "usage: setup.sh <HOME>" >&2; exit 64; }

plugins_root="$home/.claude/plugins"
userdata="$home/Library/Application Support/Claude"
sessions="$userdata/local-agent-mode-sessions"

# Minimal CCD presence so list/topology don't bail.
mkdir -p "$plugins_root"
echo '{}' > "$plugins_root/known_marketplaces.json"
echo '{"version":2,"plugins":{}}' > "$plugins_root/installed_plugins.json"

# Build 3 cowork roots: acc1/org1, acc2/org2, acc3/org3. Each registers
# `acme` with plugin `widget@1.0.0` installed.
for n in 1 2 3; do
  root="$sessions/acc${n}/org${n}"
  cw="$root/cowork_plugins"
  mkdir -p "$cw"

  cat > "$cw/known_marketplaces.json" <<'EOF'
{ "acme": { "source": { "source": "github", "repo": "acme/widget" } } }
EOF

  # Real install snapshot under cowork's cache/<mp>/<plugin>/<ver>/.
  snap="$cw/cache/acme/widget/1.0.0"
  mkdir -p "$snap/.claude-plugin"
  cat > "$snap/.claude-plugin/plugin.json" <<'EOF'
{ "name": "widget", "version": "1.0.0" }
EOF

  cat > "$cw/installed_plugins.json" <<EOF
{
  "version": 2,
  "plugins": {
    "widget@acme": [
      { "scope": "user", "version": "1.0.0", "installPath": "$snap" }
    ]
  }
}
EOF
done
