#!/usr/bin/env bash
# Fixture: symlink-in-cache — symlinks under cache/ must NOT be followed
# (would either loop or double-count). Tests the size walker's symlink
# guard.
set -euo pipefail

home="${1:-}"
[ -n "$home" ] || { echo "usage: setup.sh <HOME>" >&2; exit 64; }

plugins_root="$home/.claude/plugins"
orphan_dir="$plugins_root/cache/acme/sym-plugin/0.1.0"

mkdir -p "$orphan_dir"
echo "real content" > "$orphan_dir/real.txt"
truncate -s 32K "$orphan_dir/data.bin"

# Outside-cache target — significantly larger than the real content.
big_target="$home/big-outside-cache"
mkdir -p "$big_target"
truncate -s 100M "$big_target/elsewhere.bin"

# Symlink under the orphan pointing to the big target.
ln -s "$big_target" "$orphan_dir/link-out"

# Marketplace registry: acme is real.
mkdir -p "$plugins_root/marketplaces/acme"
cat > "$plugins_root/known_marketplaces.json" <<'EOF'
{ "acme": { "source": { "source": "github", "repo": "acme/marketplace" } } }
EOF
echo '{"version":2,"plugins":{}}' > "$plugins_root/installed_plugins.json"
