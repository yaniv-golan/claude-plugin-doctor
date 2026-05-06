#!/usr/bin/env bash
# Fixture: extra-marketplaces-user-settings — a marketplace declared
# via `extraKnownMarketplaces` in $HOME/.claude/settings.json (the
# userSettings source) but NOT materialized as a clone. cpd should
# surface it in `cpd list`'s marketplaces[] with hasClone=false and
# declaredIn including userSettings (and projectSettings, since the
# harness sets HOME=cwd=$tmpdir which collapses the two paths).
#
# This exercises the gist revision 2026-05-06T11:45:05Z extraKnownMarketplaces
# integration: settings-declared marketplaces must not be invisible to
# diagnostic tools.
set -euo pipefail

home="${1:-}"
[ -n "$home" ] || { echo "usage: setup.sh <HOME>" >&2; exit 64; }

plugins_root="$home/.claude/plugins"
mkdir -p "$plugins_root"
echo '{}' > "$plugins_root/known_marketplaces.json"
echo '{"version":2,"plugins":{}}' > "$plugins_root/installed_plugins.json"
mkdir -p "$home/Library/Application Support/Claude/local-agent-mode-sessions"

# Settings-side declaration. The CLI in 2.1.131 reads this; cpd does too.
mkdir -p "$home/.claude"
cat > "$home/.claude/settings.json" <<'EOF'
{
  "extraKnownMarketplaces": {
    "settings-only-mp": {
      "source": { "source": "github", "repo": "owner/settings-only" }
    }
  }
}
EOF
