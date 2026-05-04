#!/usr/bin/env bash
# Fixture: large-orphan — regression coverage for the recursive-size bug.
#
# Sparse files (truncate -s) report a large stat.size but occupy near-zero
# disk blocks. This catches the dirent-vs-content size bug just as
# effectively as a real 50 MB file, but creates instantaneously and
# costs no disk — keeping the fixture in fast CI.
#
# Setup creates an orphan plugin install:
#   ~/.claude/plugins/cache/acme/big-plugin/0.1.0/   (NOT referenced)
# with a 50 MB sparse file + a 10 MB sparse file in a deep subdir.
#
# `installed_plugins.json` is empty (no referenced installPaths), and
# `known_marketplaces.json` lists `acme` so the parent dir is treated
# as a real marketplace (not a stray). The version dir is therefore
# an orphan because no installed_plugins.json entry references its path.
set -euo pipefail

home="${1:-}"
if [ -z "$home" ]; then
  echo "usage: setup.sh <HOME>" >&2
  exit 64
fi

plugins_root="$home/.claude/plugins"
cache_dir="$plugins_root/cache/acme/big-plugin/0.1.0"
deep_dir="$cache_dir/node_modules/deep"

mkdir -p "$deep_dir"

# Two sparse files: 50 MB and 10 MB. Total logical size ≥ 60 MB.
truncate -s 50M "$cache_dir/data.bin"
truncate -s 10M "$deep_dir/c.bin"

# A few small real files so the test isn't relying on sparse alone.
echo "alpha" > "$cache_dir/a.txt"
echo "beta"  > "$cache_dir/node_modules/b.txt"

# Marketplace registry: acme is a real marketplace.
mkdir -p "$plugins_root/marketplaces/acme"
cat > "$plugins_root/known_marketplaces.json" <<'EOF'
{
  "acme": {
    "source": { "source": "github", "repo": "acme/marketplace" }
  }
}
EOF

# installed_plugins.json: empty, so the cache dir is unreferenced → orphan.
cat > "$plugins_root/installed_plugins.json" <<'EOF'
{
  "plugins": {}
}
EOF
