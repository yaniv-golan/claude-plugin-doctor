#!/usr/bin/env bash
# Validator oracle for `cpd topology --json`.
#
# Reads TopologyReport from stdin (src/types.ts:258) wrapping
# Topology (src/types.ts:247). Note the actual shape has no top-level
# `rpmRoots[]` — RPM data is per-cowork-root via
# CoworkRoot.{hasRpm, rpmManifestPath}.
#
# Args: $1 = HOME (fixture root).
# Stdin: cpd topology --json output.
# Exit:  0 = pass; 1 = at least one violation.
set -uo pipefail

home="${1:-}"
[ -n "$home" ] || { echo "usage: topology.sh <HOME>" >&2; exit 64; }

plugins_root="$home/.claude/plugins"
userdata="$home/Library/Application Support/Claude"

failures=0
fail() { echo "VIOLATION ($1): $2"; failures=$((failures + 1)); }

cpd_json=$(cat)

# Sanity: exit-code in documented union.
exit_code=$(jq -r '.exitCode // empty' <<<"$cpd_json")
case "$exit_code" in
  0|1) ;;
  *) fail "exitCode" "exitCode=$exit_code not in {0,1} (src/types.ts:262)" ;;
esac

# T-1: when topology.ccd is present, ccd.marketplaces[].name set ==
#      known_marketplaces.json top-level keys ∪ extraKnownMarketplaces
#      keys from cross-cutting settings sources (gist revision
#      2026-05-06T11:45:05Z). Cross-cutting sources at the CCD level:
#      userSettings ($HOME/.claude/settings.json), projectSettings (cwd-
#      relative — same as userSettings here since the harness sets
#      HOME=cwd=$tmpdir), localSettings, policySettings (redirected via
#      CLAUDE_MANAGED_SETTINGS_DIR=$HOME/.policy by the harness driver)
#      + drop-ins under managed-settings.d/*.json.
extra_keys() {
  local f="$1"
  [ -f "$f" ] || return 0
  jq -r '(.extraKnownMarketplaces // {}) | keys[]' "$f" 2>/dev/null || true
}

ccd_present=$(jq -r '.topology.ccd // null | if . == null then "no" else "yes" end' <<<"$cpd_json")
if [ "$ccd_present" = "yes" ]; then
  base_keys=$(jq -r 'keys[]' \
    "$plugins_root/known_marketplaces.json" 2>/dev/null | sort -u || true)
  settings_keys=""
  settings_keys="${settings_keys}$(extra_keys "$home/.claude/settings.json")"$'\n'
  settings_keys="${settings_keys}$(extra_keys "$home/.claude/settings.local.json")"$'\n'
  policy_root="$home/.policy"
  settings_keys="${settings_keys}$(extra_keys "$policy_root/managed-settings.json")"$'\n'
  if [ -d "$policy_root/managed-settings.d" ]; then
    while IFS= read -r f; do
      [ -n "$f" ] && settings_keys="${settings_keys}$(extra_keys "$f")"$'\n'
    done < <(find "$policy_root/managed-settings.d" -maxdepth 1 -name '*.json' 2>/dev/null)
  fi
  expected_mps=$(printf '%s\n%s\n' "$base_keys" "$settings_keys" \
    | grep -v '^$' | sort -u || true)
  actual_mps=$(jq -r '.topology.ccd.marketplaces[].name' <<<"$cpd_json" 2>/dev/null | sort -u)
  if [ "$expected_mps" != "$actual_mps" ]; then
    fail "T-1" "ccd.marketplaces[].name mismatch. expected=[$expected_mps] actual=[$actual_mps]"
  fi
fi

# T-2: cowork[].accountId set == acc dir names.
expected_acc=""
if [ -d "$userdata/local-agent-mode-sessions" ]; then
  expected_acc=$(ls -1 "$userdata/local-agent-mode-sessions" 2>/dev/null | sort -u || true)
fi
actual_acc=$(jq -r '.topology.cowork[].accountId' <<<"$cpd_json" 2>/dev/null | sort -u)
if [ "$expected_acc" != "$actual_acc" ]; then
  fail "T-2" "cowork[].accountId mismatch. expected=[$expected_acc] actual=[$actual_acc]"
fi

# T-3: per cowork root, marketplaces[].name == top-level keys of that
# root's cowork_plugins/known_marketplaces.json (NOT directory names),
# UNION cross-cutting extraKnownMarketplaces declarations (machine-global
# settings sources are merged into every root) AND that root's own
# coworkSettings.extraKnownMarketplaces (per-root).
#
# Cross-cutting set is the same union computed at T-1 above for CCD.
# Reuse via local variable to avoid recomputing.
cross_cutting=$(printf '%s\n' "$settings_keys" | grep -v '^$' | sort -u || true)

while IFS= read -r entry; do
  [ -z "$entry" ] && continue
  acc=$(jq -r '.accountId' <<<"$entry")
  org=$(jq -r '.orgId' <<<"$entry")
  km_path=$(jq -r '.knownMarketplacesPath // empty' <<<"$entry")
  cs_path=$(jq -r '.coworkSettingsPath // empty' <<<"$entry")
  reported_mps=$(jq -r '.marketplaces[].name // empty' <<<"$entry" | sort -u)

  base=""
  if [ -n "$km_path" ] && [ -f "$km_path" ]; then
    base=$(jq -r 'keys[]' "$km_path" 2>/dev/null | sort -u || true)
  fi
  cowork_extra=""
  if [ -n "$cs_path" ] && [ -f "$cs_path" ]; then
    cowork_extra=$(extra_keys "$cs_path")
  fi
  expected=$(printf '%s\n%s\n%s\n' "$base" "$cross_cutting" "$cowork_extra" \
    | grep -v '^$' | sort -u || true)

  if [ -z "$expected" ] && [ -n "$reported_mps" ]; then
    fail "T-3" "cowork[$acc/$org] reports marketplaces=[$reported_mps] but no source declared any"
    continue
  fi
  if [ "$reported_mps" != "$expected" ]; then
    fail "T-3" "cowork[$acc/$org].marketplaces mismatch. expected=[$expected] actual=[$reported_mps]"
  fi
done < <(jq -c '.topology.cowork[]?' <<<"$cpd_json")

# T-4: every cowork[i] root with hasRpm: true has an existing rpmManifestPath.
while IFS= read -r entry; do
  [ -z "$entry" ] && continue
  has_rpm=$(jq -r '.hasRpm // false' <<<"$entry")
  rpm_path=$(jq -r '.rpmManifestPath // empty' <<<"$entry")
  acc=$(jq -r '.accountId' <<<"$entry")
  if [ "$has_rpm" = "true" ]; then
    if [ -z "$rpm_path" ] || [ ! -f "$rpm_path" ]; then
      fail "T-4" "cowork[$acc].hasRpm=true but rpmManifestPath ('$rpm_path') does not exist"
    fi
  fi
done < <(jq -c '.topology.cowork[]?' <<<"$cpd_json")

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
