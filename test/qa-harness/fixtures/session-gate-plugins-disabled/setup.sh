#!/usr/bin/env bash
# Fixture: session-gate-plugins-disabled — a Cowork root with three
# `local_<UUID>.json` session-config sidecars: one with
# pluginsEnabled=false (active, should fire the advisory), one with
# pluginsEnabled=false (archived, should be counted but not advised),
# one without the field at all (default-on, ignored).
#
# Per gist revision 2026-05-06T11:27:26Z §"Per-session feature gates":
# pluginsEnabled=false at the session-config level skips both remote
# (RPM) and local/classic plugin mounts for that session. cpd surfaces
# this via the `session-plugins-disabled-detected` advisory.
set -euo pipefail

home="${1:-}"
[ -n "$home" ] || { echo "usage: setup.sh <HOME>" >&2; exit 64; }

plugins_root="$home/.claude/plugins"
mkdir -p "$plugins_root"
echo '{}' > "$plugins_root/known_marketplaces.json"
echo '{"version":2,"plugins":{}}' > "$plugins_root/installed_plugins.json"

# One cowork root with three session JSONs.
sessions="$home/Library/Application Support/Claude/local-agent-mode-sessions"
root="$sessions/acc1/org1"
mkdir -p "$root/cowork_plugins"
echo '{}' > "$root/cowork_plugins/known_marketplaces.json"
echo '{"version":2,"plugins":{}}' > "$root/cowork_plugins/installed_plugins.json"

# Active disabled — must fire the advisory.
cat > "$root/local_aaaaaaaa-bbbb-cccc-dddd-111111111111.json" <<'EOF'
{
  "sessionId": "aaaaaaaa-bbbb-cccc-dddd-111111111111",
  "title": "active-disabled",
  "pluginsEnabled": false,
  "isArchived": false,
  "lastActivityAt": "2026-05-06T10:00:00Z"
}
EOF

# Archived disabled — counted in archivedDisabledCount, not advised.
cat > "$root/local_aaaaaaaa-bbbb-cccc-dddd-222222222222.json" <<'EOF'
{
  "sessionId": "aaaaaaaa-bbbb-cccc-dddd-222222222222",
  "title": "archived-disabled",
  "pluginsEnabled": false,
  "isArchived": true,
  "lastActivityAt": "2024-01-01T00:00:00Z"
}
EOF

# No field at all — default-on, neither counted nor advised.
cat > "$root/local_aaaaaaaa-bbbb-cccc-dddd-333333333333.json" <<'EOF'
{
  "sessionId": "aaaaaaaa-bbbb-cccc-dddd-333333333333",
  "title": "no-flags",
  "lastActivityAt": "2026-05-05T00:00:00Z"
}
EOF
