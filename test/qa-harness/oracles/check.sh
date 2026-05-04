#!/usr/bin/env bash
# Validator oracle for `cpd check <plugin>@<mp> --json`.
#
# Reads V05CheckReport from stdin (src/commands/check.ts:236).
# IMPORTANT: V05CheckReport carries the installed version on
# `.plugin.installedVersion` (PluginReport.installedVersion —
# src/types.ts:128), NOT a fictional `installed.version`.
#
# Args: $1 = HOME (fixture root), $2 = pluginId (e.g. "bar@foo").
# Stdin: cpd check $2 --json output.
# Exit:  0 = pass; 1 = at least one violation.
set -uo pipefail

home="${1:-}"
plugin_id="${2:-}"
[ -n "$home" ] || { echo "usage: check.sh <HOME> <pluginId>" >&2; exit 64; }
[ -n "$plugin_id" ] || { echo "check.sh: missing pluginId" >&2; exit 64; }

plugins_root="$home/.claude/plugins"

failures=0
fail() { echo "VIOLATION ($1): $2"; failures=$((failures + 1)); }

cpd_json=$(cat)

# C-5: exit code in documented union {0, 2, 3, 64}.
exit_code=$(jq -r '.exitCode // empty' <<<"$cpd_json")
case "$exit_code" in
  0|2|3|64) ;;
  *) fail "C-5" "exitCode=$exit_code not in {0,2,3,64} (src/commands/check.ts:269)" ;;
esac

# C-1: .pluginId == requested pluginId.
actual_id=$(jq -r '.pluginId // empty' <<<"$cpd_json")
if [ "$actual_id" != "$plugin_id" ]; then
  fail "C-1" ".pluginId='$actual_id' != requested='$plugin_id'"
fi

# C-2: when installed_plugins.json lists $plugin_id, .plugin.installedVersion
#      matches the manifest's version (first scope's version).
manifest_version=$(jq -r --arg id "$plugin_id" \
  '.plugins[$id][0].version // empty' \
  "$plugins_root/installed_plugins.json" 2>/dev/null || true)
if [ -n "$manifest_version" ]; then
  reported_version=$(jq -r '.plugin.installedVersion // empty' <<<"$cpd_json")
  if [ "$reported_version" != "$manifest_version" ]; then
    fail "C-2" ".plugin.installedVersion='$reported_version' != manifest='$manifest_version' for $plugin_id"
  fi
fi

# C-3: when the plugin is NOT in installed_plugins AND NOT an RPM match,
#      .plugin must be absent. (We don't try to enumerate every RPM source
#      of truth here; the negative test is just "if neither exists, no
#      .plugin should appear.")
in_manifest=$(jq -r --arg id "$plugin_id" \
  'if (.plugins[$id] // null) == null then "no" else "yes" end' \
  "$plugins_root/installed_plugins.json" 2>/dev/null || echo "no")
rpm_match=$(jq -r 'if (.rpmMatch // null) == null then "no" else "yes" end' <<<"$cpd_json")
plugin_present=$(jq -r 'if (.plugin // null) == null then "no" else "yes" end' <<<"$cpd_json")
if [ "$in_manifest" = "no" ] && [ "$rpm_match" = "no" ] && [ "$plugin_present" = "yes" ]; then
  fail "C-3" ".plugin present but plugin is not in installed_plugins.json AND no rpmMatch"
fi

# C-4: .fullReport (V05ScanResult) internal consistency — every
#      .fullReport.plugins[i].id is unique. The report does NOT carry an
#      `installedPluginsPath` field at the root (that lives on
#      Topology.ccd / cowork roots); don't assert against a non-existent field.
dup=$(jq -r '
  .fullReport.plugins // [] | map(.id) |
  (length) - (unique | length)
' <<<"$cpd_json" 2>/dev/null || echo 0)
if [ "$dup" -gt 0 ]; then
  fail "C-4" ".fullReport.plugins[].id has $dup duplicate(s)"
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
