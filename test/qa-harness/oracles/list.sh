#!/usr/bin/env bash
# Validator oracle for `cpd list --json`.
#
# Reads ListReport from stdin. Asserts against the real shape
# (src/commands/list.ts:31) — schema + cross-filesystem invariants.
#
# Args: $1 = HOME (fixture root).
# Stdin: cpd list --json output.
# Stdout: empty on pass; one failure line per violation on fail.
# Exit:  0 = pass; 1 = at least one violation.
#
# Bash 3.2 portable.
set -uo pipefail

home="${1:-}"
[ -n "$home" ] || { echo "usage: list.sh <HOME>" >&2; exit 64; }

plugins_root="$home/.claude/plugins"
userdata="$home/Library/Application Support/Claude"

failures=0
fail() { echo "VIOLATION ($1): $2"; failures=$((failures + 1)); }

# Read cpd JSON once.
cpd_json=$(cat)

# Sanity: exit-code must be in the documented union.
exit_code=$(jq -r '.exitCode // empty' <<<"$cpd_json")
case "$exit_code" in
  0|2|3) ;;
  *) fail "exitCode" "exitCode=$exit_code not in {0,2,3} (src/commands/list.ts:49)" ;;
esac

# L-1: plugins[].id set == UNION of installed_plugins.json keys across
#      CCD (`<plugins_root>/installed_plugins.json`) AND every cowork
#      root's `cowork_plugins/installed_plugins.json`.
ccd_ids=$(jq -r '.plugins // {} | keys[]' \
  "$plugins_root/installed_plugins.json" 2>/dev/null || true)
cowork_ids=""
if [ -d "$userdata/local-agent-mode-sessions" ]; then
  cowork_ids=$(find "$userdata/local-agent-mode-sessions" -mindepth 4 -maxdepth 4 \
    -name installed_plugins.json -path '*/cowork_plugins/*' 2>/dev/null \
    | while IFS= read -r f; do
      jq -r '.plugins // {} | keys[]' "$f" 2>/dev/null || true
    done)
fi
expected_ids=$(printf '%s\n%s\n' "$ccd_ids" "$cowork_ids" | grep -v '^$' | sort -u || true)
actual_ids=$(jq -r '.plugins[].id' <<<"$cpd_json" | sort -u)
if [ "$expected_ids" != "$actual_ids" ]; then
  fail "L-1" "plugins[].id != union(CCD, cowork) installed_plugins keys. expected=[$expected_ids] actual=[$actual_ids]"
fi

# L-2: marketplaces[].name set == UNION of known_marketplaces.json keys
#      across CCD AND every cowork root.
ccd_mps=$(jq -r 'keys[]' "$plugins_root/known_marketplaces.json" 2>/dev/null || true)
cowork_mps=""
if [ -d "$userdata/local-agent-mode-sessions" ]; then
  cowork_mps=$(find "$userdata/local-agent-mode-sessions" -mindepth 4 -maxdepth 4 \
    -name known_marketplaces.json -path '*/cowork_plugins/*' 2>/dev/null \
    | while IFS= read -r f; do
      jq -r 'keys[]' "$f" 2>/dev/null || true
    done)
fi
expected_mps=$(printf '%s\n%s\n' "$ccd_mps" "$cowork_mps" | grep -v '^$' | sort -u || true)
actual_mps=$(jq -r '.marketplaces[].name' <<<"$cpd_json" | sort -u)
if [ "$expected_mps" != "$actual_mps" ]; then
  fail "L-2" "marketplaces[].name != union(CCD, cowork) known_marketplaces keys. expected=[$expected_mps] actual=[$actual_mps]"
fi

# L-3: every plugins[i].scopes[j].installPath exists on disk.
while IFS= read -r p; do
  [ -z "$p" ] && continue
  if [ ! -d "$p" ]; then
    fail "L-3" "scope installPath does not exist: $p"
  fi
done < <(jq -r '.plugins[].scopes[].installPath' <<<"$cpd_json")

# L-4: rpmPlugins[].pluginId set == set of plugin_* dirs under cowork rpm/.
expected_rpm=$(find "$userdata/local-agent-mode-sessions" -mindepth 4 -maxdepth 4 \
  -type d -path '*/rpm/*' 2>/dev/null \
  | xargs -n1 basename 2>/dev/null | sort -u || true)
actual_rpm=$(jq -r '.rpmPlugins[].pluginId' <<<"$cpd_json" 2>/dev/null | sort -u)
if [ "$expected_rpm" != "$actual_rpm" ]; then
  fail "L-4" "rpmPlugins[].pluginId mismatch. expected=[$expected_rpm] actual=[$actual_rpm]"
fi

# L-5: coworkRoots[].accountId set == directory names under
# local-agent-mode-sessions/.
expected_acc=""
if [ -d "$userdata/local-agent-mode-sessions" ]; then
  expected_acc=$(ls -1 "$userdata/local-agent-mode-sessions" 2>/dev/null | sort -u || true)
fi
actual_acc=$(jq -r '.coworkRoots[].accountId' <<<"$cpd_json" 2>/dev/null | sort -u)
if [ "$expected_acc" != "$actual_acc" ]; then
  fail "L-5" "coworkRoots[].accountId mismatch. expected=[$expected_acc] actual=[$actual_acc]"
fi

# L-6: nameCollisions[].entries.length >= 2 for every reported group.
nc_bad=$(jq -r '
  (.nameCollisions // []) | map(select((.entries | length) < 2)) | length
' <<<"$cpd_json")
if [ "$nc_bad" -gt 0 ]; then
  fail "L-6" "nameCollisions has $nc_bad group(s) with < 2 entries"
fi

# Schema baselines locked by prior-art (shipped in v0.1.0).
schema_version=$(jq -r '.schemaVersion // empty' <<<"$cpd_json")
if [ "$schema_version" != "1.0" ]; then
  fail "schemaVersion" "expected '1.0', got '${schema_version:-<missing>}'"
fi
run_id=$(jq -r '.runId // empty' <<<"$cpd_json")
if ! [[ "$run_id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]; then
  fail "runId" "not a UUIDv4: '${run_id:-<missing>}'"
fi

exit $([ "$failures" = 0 ] && echo 0 || echo 1)
