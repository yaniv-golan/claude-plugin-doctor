#!/usr/bin/env bash
# Fixture: extra-marketplaces-policy-settings — exercises the
# managed-policy declaration path. Two marketplaces are pre-registered
# via the `policySettings` source: one in the base file
# (`<policy-root>/managed-settings.json`) and one in a drop-in under
# `<policy-root>/managed-settings.d/*.json`. The harness redirects the
# policy root via CLAUDE_MANAGED_SETTINGS_DIR=$HOME/.policy.
#
# The binary investigation that produced these paths is in
# docs/internal/INVESTIGATION-policy-settings-2026-05-06.md.
set -euo pipefail

home="${1:-}"
[ -n "$home" ] || { echo "usage: setup.sh <HOME>" >&2; exit 64; }

plugins_root="$home/.claude/plugins"
mkdir -p "$plugins_root"
echo '{}' > "$plugins_root/known_marketplaces.json"
echo '{"version":2,"plugins":{}}' > "$plugins_root/installed_plugins.json"
mkdir -p "$home/Library/Application Support/Claude/local-agent-mode-sessions"

# Policy root: redirected via CLAUDE_MANAGED_SETTINGS_DIR set in
# scripts/qa-harness.sh (each fixture gets its own $tmpdir/.policy).
policy_root="$home/.policy"
mkdir -p "$policy_root/managed-settings.d"

cat > "$policy_root/managed-settings.json" <<'EOF'
{
  "extraKnownMarketplaces": {
    "policy-base-mp": {
      "source": { "source": "github", "repo": "org/policy-base" }
    }
  }
}
EOF

cat > "$policy_root/managed-settings.d/10-extra.json" <<'EOF'
{
  "extraKnownMarketplaces": {
    "policy-dropin-mp": {
      "source": { "source": "github", "repo": "org/policy-dropin" }
    }
  }
}
EOF
