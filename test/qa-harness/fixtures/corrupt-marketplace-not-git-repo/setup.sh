#!/usr/bin/env bash
# Fixture: corrupt-marketplace-not-git-repo — `marketplaces/foo/`
# exists but contains plain files, no `.git/`. Triggers the
# `marketplace-clone-not-a-repo` (γ.A) recovery path. cpd check should
# exit 2 and surface a destructive remove+re-add Fix block.
#
# Path layout reminder (CLAUDE.md §1):
#   <plugins-root>/marketplaces/<mp>/  → marketplace clone
#   <plugins-root>/cache/<mp>/<plugin>/<version>/  → install snapshot
set -euo pipefail

home="${1:-}"
[ -n "$home" ] || { echo "usage: setup.sh <HOME>" >&2; exit 64; }

plugins_root="$home/.claude/plugins"

# Marketplace clone directory exists but is NOT a git repo.
mp_dir="$plugins_root/marketplaces/foo"
mkdir -p "$mp_dir/.claude-plugin"
cat > "$mp_dir/.claude-plugin/marketplace.json" <<'EOF'
{
  "name": "foo",
  "owner": { "name": "test" },
  "plugins": [
    { "name": "some-plugin", "version": "1.0.0",
      "source": { "source": "github", "repo": "foo/some-plugin" } }
  ]
}
EOF
echo "stub" > "$mp_dir/README.md"
# Deliberately no `.git/` directory — that's the bug under test.

# Real install snapshot referenced by installed_plugins.
snap="$plugins_root/cache/foo/some-plugin/1.0.0"
mkdir -p "$snap/.claude-plugin"
cat > "$snap/.claude-plugin/plugin.json" <<'EOF'
{ "name": "some-plugin", "version": "1.0.0" }
EOF

cat > "$plugins_root/known_marketplaces.json" <<'EOF'
{ "foo": { "source": { "source": "github", "repo": "foo/some-plugin" } } }
EOF
cat > "$plugins_root/installed_plugins.json" <<EOF
{
  "version": 2,
  "plugins": {
    "some-plugin@foo": [
      { "scope": "user", "version": "1.0.0", "installPath": "$snap" }
    ]
  }
}
EOF
