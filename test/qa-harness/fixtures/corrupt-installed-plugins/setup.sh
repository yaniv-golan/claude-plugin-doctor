#!/usr/bin/env bash
# Fixture: corrupt-installed-plugins — graceful error handling when
# installed_plugins.json is malformed. Today scan/list/check return
# E_USAGE+exit 1 (commander wraps the parse failure); cache --orphans
# tolerates it and returns an empty report. Both contracts are pinned
# in expected.json under "current"; a future PR can flip "active" to
# "desired" to gate the typed-error work item.
set -euo pipefail

home="${1:-}"
[ -n "$home" ] || { echo "usage: setup.sh <HOME>" >&2; exit 64; }

plugins_root="$home/.claude/plugins"
mkdir -p "$plugins_root/marketplaces/foo/.claude-plugin"

# Valid marketplace.json so check has a syntactically-valid target.
cat > "$plugins_root/marketplaces/foo/.claude-plugin/marketplace.json" <<'EOF'
{
  "name": "foo",
  "owner": { "name": "test" },
  "plugins": [
    { "name": "bar", "version": "1.0.0", "source": { "source": "github", "repo": "foo/bar" } }
  ]
}
EOF

cat > "$plugins_root/known_marketplaces.json" <<'EOF'
{ "foo": { "source": { "source": "github", "repo": "foo/marketplace" } } }
EOF

# THE corruption: malformed installed_plugins.json.
printf '{not json' > "$plugins_root/installed_plugins.json"
