#!/usr/bin/env bash
# Fixture: dot-temp-stray — pins the four name variants accepted by
# `isTempStagingDirName` (`src/commands/cache.ts:150-157`) AND surfaces
# any oracle/cpd disagreement on dotfile-prefix dirs.
#
# Discovered via Step-8 meta-review (2026-05-04): the orphan oracle's
# bash glob `"$cache_dir"/*/` skipped dotfiles by default, while cpd's
# `readdirSync` saw them. Without `shopt -s dotglob` the oracle silently
# missed `.temp_*` strays that cpd correctly classified — a harness
# false-negative that would let any future cpd regression sail through.
# Oracle now sets `dotglob`; this fixture pins both sides in lockstep.
set -euo pipefail

home="${1:-}"
[ -n "$home" ] || { echo "usage: setup.sh <HOME>" >&2; exit 64; }

plugins_root="$home/.claude/plugins"

# Four prefix variants, all should classify as `temp-staging-dir`:
#   temp_a   — primary form (interrupted install)
#   temp.b   — `.`-delimited variant
#   .temp_c  — dotfile + underscore-delimited
#   .temp.d  — dotfile + `.`-delimited
#
# Plus one negative-control: `.tempfoo` has neither delimiter — cpd
# does NOT treat it as a temp staging dir (`startsWith(".temp_")` ||
# `startsWith(".temp.")`, src/commands/cache.ts:154-155).
for n in temp_a temp.b .temp_c .temp.d; do
  mkdir -p "$plugins_root/cache/$n/sub"
  truncate -s 8K "$plugins_root/cache/$n/sub/x.bin"
done

# Negative control — exists in cache but should NOT be reported as a
# temp-staging stray. Empty registry means "fall through" rules apply,
# so this dir falls into the best-effort plugin walk and reports
# nothing (no version subdirs).
mkdir -p "$plugins_root/cache/.tempfoo/sub"
truncate -s 4K "$plugins_root/cache/.tempfoo/sub/x.bin"

echo '{}' > "$plugins_root/known_marketplaces.json"
echo '{"version":2,"plugins":{}}' > "$plugins_root/installed_plugins.json"
