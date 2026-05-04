#!/usr/bin/env bash
# Fixture: truly-massive — 50 marketplaces × 20 plugins each = 1000
# plugins. Pre-release-only perf benchmark. Excluded from per-PR CI
# because setup is slow (~3-5s) even with sparse files. Run via
# `npm run qa-harness:perf` (the only invocation that includes this
# fixture's directory).
set -euo pipefail

home="${1:-}"
[ -n "$home" ] || { echo "usage: setup.sh <HOME>" >&2; exit 64; }

plugins_root="$home/.claude/plugins"
mkdir -p "$plugins_root/marketplaces"

# Build known_marketplaces.json incrementally.
km="$plugins_root/known_marketplaces.json"
echo "{" > "$km"
first=1

# installed_plugins.json scopes accumulator.
ip="$plugins_root/installed_plugins.json"
echo '{"version":2,"plugins":{' > "$ip"
first_plugin=1

for mp_idx in $(seq 1 50); do
  mp="mp${mp_idx}"
  mp_dir="$plugins_root/marketplaces/$mp"
  mkdir -p "$mp_dir/.claude-plugin"

  # Build marketplace.json with 20 plugins.
  mj="$mp_dir/.claude-plugin/marketplace.json"
  {
    printf '{\n  "name": "%s",\n  "owner": { "name": "test" },\n  "plugins": [\n' "$mp"
    for p_idx in $(seq 1 20); do
      sep=$([ "$p_idx" = 1 ] && echo "" || echo ",")
      printf '    %s{ "name": "p%d", "version": "1.0.0", "source": "./p%d" }\n' "$sep" "$p_idx" "$p_idx"
    done
    printf '  ]\n}\n'
  } > "$mj"

  # Append to known_marketplaces.json.
  [ "$first" = 1 ] || echo "," >> "$km"
  first=0
  printf '  "%s": { "source": { "source": "github", "repo": "owner/%s" } }' "$mp" "$mp" >> "$km"

  # Make a real install snapshot per plugin and reference it.
  for p_idx in $(seq 1 20); do
    snap="$plugins_root/cache/$mp/p${p_idx}/1.0.0"
    mkdir -p "$snap/.claude-plugin"
    printf '{ "name": "p%d", "version": "1.0.0" }\n' "$p_idx" > "$snap/.claude-plugin/plugin.json"

    [ "$first_plugin" = 1 ] || echo "," >> "$ip"
    first_plugin=0
    printf '"p%d@%s": [{ "scope": "user", "version": "1.0.0", "installPath": "%s" }]' \
      "$p_idx" "$mp" "$snap" >> "$ip"
  done
done

echo "" >> "$km"
echo "}" >> "$km"
echo "}}" >> "$ip"
