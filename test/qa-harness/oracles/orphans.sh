#!/usr/bin/env bash
# Wire-replica oracle for `cpd cache --orphans --json`.
#
# Inputs:  $1 = HOME (fixture root). The oracle derives plugins root and
#          cache dir internally.
# Stdout:  CacheOrphansReport-shaped JSON, byte-for-byte compatible with
#          src/commands/cache.ts:79 (modulo the volatile fields stripped
#          by diff/json-diff.mjs: runId, startedAt, finishedAt, logFile —
#          none of which CacheOrphansReport actually carries today).
#
# Bash 3.2 compatible — no associative arrays.
set -uo pipefail

home="${1:-}"
if [ -z "$home" ]; then
  echo "usage: orphans.sh <HOME>" >&2
  exit 64
fi

ORACLE_DIR="$(cd "$(dirname "$0")" && pwd)"
plugins_root="$home/.claude/plugins"
cache_dir="$plugins_root/cache"
installed_json="$plugins_root/installed_plugins.json"
known_json="$plugins_root/known_marketplaces.json"

# Set of installPaths from installed_plugins.json — the "referenced"
# install snapshots. Any cache/<mp>/<plugin>/<ver>/ NOT in this set is
# an orphan (its installed_plugins.json entry was deleted but the cache
# dir wasn't cleaned up).
referenced=""
if [ -f "$installed_json" ]; then
  referenced=$(jq -r '
    (.plugins // {}) | to_entries[] |
    .value[] | (.installPath // empty)
  ' "$installed_json" 2>/dev/null | sort -u || true)
fi

# Set of registered marketplace names (top-level keys of known_marketplaces.json).
known_mps=""
if [ -f "$known_json" ]; then
  known_mps=$(jq -r 'keys[]' "$known_json" 2>/dev/null | sort -u || true)
fi

orphans=""
strays=""

# Helper: append a JSON object to a comma-separated string.
append() {
  local var="$1" val="$2"
  if [ -z "${!var}" ]; then
    eval "$var=\$val"
  else
    eval "$var=\"\${$var},\$val\""
  fi
}

if [ -d "$cache_dir" ]; then
  # Enable dotglob so dotfile dirs (e.g. `.temp_*` interrupted-install
  # variants) are visible. Default bash globs skip dotfiles, but cpd's
  # `readdirSync` returns them — without dotglob, the oracle SILENTLY
  # MISSES strays that cpd correctly classifies, which would let a
  # future cpd regression go undetected.
  shopt -s dotglob 2>/dev/null || true
  for top in "$cache_dir"/*/; do
    [ -d "$top" ] || continue
    top_name=$(basename "$top")
    top_path="${top%/}"
    # Skip the `.` and `..` pseudo-entries some bash versions emit
    # under dotglob.
    case "$top_name" in .|..) continue ;; esac

    # Precedence: known-marketplace membership wins over the temp_*
    # name pattern. A user-registered marketplace called `temp_foo` is
    # NOT a stray staging dir.
    is_known_mp=0
    if [ -n "$known_mps" ] && grep -qx "$top_name" <<<"$known_mps"; then
      is_known_mp=1
    fi

    if [ "$is_known_mp" = 0 ]; then
      # Match cpd's `isTempStagingDirName` precisely
      # (src/commands/cache.ts:150-157): the prefix variants are
      # `temp_`, `temp.`, `.temp_`, `.temp.`. NOT `.temp*` (the bash
      # glob `.temp*` matches `.tempfoo` which cpd does NOT classify
      # as stray — surfaced by Step-8 meta-review fixture
      # `dot-temp-stray/.tempfoo` negative control).
      case "$top_name" in
        temp_*|temp.*|.temp_*|.temp.*)
          size=$(node "$ORACLE_DIR/_size.mjs" "$top_path")
          append strays "{\"strayPath\":\"$top_path\",\"approxSizeBytes\":$size,\"reason\":\"temp-staging-dir\"}"
          continue
          ;;
      esac
      if [ -n "$known_mps" ]; then
        # known_marketplaces.json non-empty but doesn't list this dir.
        size=$(node "$ORACLE_DIR/_size.mjs" "$top_path")
        append strays "{\"strayPath\":\"$top_path\",\"approxSizeBytes\":$size,\"reason\":\"unknown-marketplace\"}"
        continue
      fi
    fi

    # Real marketplace dir — walk <plugin>/<version>/ and report
    # every version dir whose abs path is NOT in `referenced`.
    for plugin in "$top"*/; do
      [ -d "$plugin" ] || continue
      p_name=$(basename "$plugin")
      for ver in "$plugin"*/; do
        [ -d "$ver" ] || continue
        v_name=$(basename "$ver")
        ver_abs="${ver%/}"
        if [ -z "$referenced" ] || ! grep -qxF "$ver_abs" <<<"$referenced"; then
          size=$(node "$ORACLE_DIR/_size.mjs" "$ver_abs")
          append orphans "{\"orphanPath\":\"$ver_abs\",\"marketplace\":\"$top_name\",\"pluginName\":\"$p_name\",\"version\":\"$v_name\",\"approxSizeBytes\":$size}"
        fi
      done
    done
  done
fi

total_orphan=$(echo "[$orphans]" | jq '[.[] | .approxSizeBytes] | add // 0')
total_stray=$(echo "[$strays]" | jq '[.[] | .approxSizeBytes] | add // 0')

cat <<EOF
{
  "kind": "cache_orphans",
  "orphans": [$orphans],
  "strayDirs": [$strays],
  "totalOrphanBytes": $total_orphan,
  "totalStrayBytes": $total_stray,
  "exitCode": 0
}
EOF
