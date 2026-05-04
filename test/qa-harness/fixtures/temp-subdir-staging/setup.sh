#!/usr/bin/env bash
# Fixture: temp-subdir-staging — regression coverage for the orphan-walker
# bug. An interrupted `claude plugin marketplace add` leaves
# `cache/temp_subdir_<unix-ms>_<rand>.clone/` behind. The buggy walker
# treated each sub-path under .git/ as its own plugin orphan; the
# correct behavior is to report the parent dir ONCE as a stray
# (`reason: "temp-staging-dir"`) and not explode into sub-paths.
set -euo pipefail

home="${1:-}"
[ -n "$home" ] || { echo "usage: setup.sh <HOME>" >&2; exit 64; }

plugins_root="$home/.claude/plugins"
temp_dir="$plugins_root/cache/temp_subdir_1234_abc.clone"

mkdir -p "$temp_dir/.git/hooks"
mkdir -p "$temp_dir/.git/objects"
mkdir -p "$temp_dir/.git/refs"
mkdir -p "$temp_dir/plugin/commands"
mkdir -p "$temp_dir/plugin/hooks"

# A meaningful payload so the size check is non-trivial. 128 KB.
truncate -s 128K "$temp_dir/.git/objects/pack.bin"
echo "stub hook" > "$temp_dir/plugin/hooks/post-install"

# Empty registry + manifest. The temp dir is the ONLY entry under cache/.
echo '{}' > "$plugins_root/known_marketplaces.json"
echo '{"version":2,"plugins":{}}' > "$plugins_root/installed_plugins.json"
