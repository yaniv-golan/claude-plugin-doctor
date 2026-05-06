#!/usr/bin/env bash
# QA Harness — exercises read-only cpd commands against synthetic
# fixtures, comparing cpd output against independently-computed oracle
# output (wire-replica mode) or against schema/semantic invariants
# (validator mode).
#
# Bash 3.2 portable. Runs on macos-latest without `brew install bash`.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS_DIR="$REPO_ROOT/test/qa-harness"
FIXTURES_DIR="$HARNESS_DIR/fixtures"
ORACLES_DIR="$HARNESS_DIR/oracles"
DIFF_DIR="$HARNESS_DIR/diff"
CPD_BIN="$REPO_ROOT/dist/cli.js"

if [ ! -x "$CPD_BIN" ]; then
  echo "ERROR: $CPD_BIN not found or not executable. Run \`npm run build\` first." >&2
  exit 2
fi

# Mode selection. Default is FAST: skip the perf benchmark fixture
# (`truly-massive`, ~3s setup time). `--full` includes everything.
MODE="fast"
for arg in "$@"; do
  case "$arg" in
    --full) MODE="full" ;;
    --fast) MODE="fast" ;;
    *) echo "warn: ignoring unknown arg '$arg'" >&2 ;;
  esac
done

# Fixtures excluded from fast mode. Match by directory basename.
is_excluded_in_fast() {
  case "$1" in
    truly-massive) return 0 ;;
    *) return 1 ;;
  esac
}

pass_count=0
fail_count=0
skip_count=0
failures=""

record_failure() {
  local fixture="$1" cmd="$2" detail="$3"
  fail_count=$((fail_count + 1))
  failures="${failures}FAIL  ${fixture}  ${cmd}  ${detail}
"
}

# Per-command flag matrix. `cache` does NOT go through addScanOptions
# in src/cli.ts, so it doesn't accept --no-network. All commands accept
# --no-color. We omit --verbose from the harness today (NDJSON-on-stderr
# noise; orthogonal to oracle correctness).
flags_for() {
  case "$1" in
    "cache --orphans") echo "|--no-color" ;;
    *)                 echo "|--no-network|--no-color" ;;
  esac
}

# Per-command oracle script.
oracle_for() {
  case "$1" in
    "cache --orphans") echo "orphans.sh" ;;
    "list")            echo "list.sh" ;;
    "topology")        echo "topology.sh" ;;
    "check")           echo "check.sh" ;;
    *) echo "" ;;
  esac
}

# Oracle dispatch mode: wire-replica (whole-output JSON diff) vs
# validator (consume cpd output via stdin, exit non-zero on violation).
oracle_mode_for() {
  case "$1" in
    "cache --orphans") echo "wire-replica" ;;
    "list"|"topology"|"check") echo "validator" ;;
    *) echo "" ;;
  esac
}

# Resolve the fixture's active expected block. Fixtures either nest
# under current/desired (with `.active` selector), or use a flat
# top-level. Returns "" for flat fixtures, else the active block name.
resolve_active() {
  jq -r '.active // ""' "$1" 2>/dev/null
}

# Look up a leaf value from expected.json honoring the active selector.
exp_get() {
  local file="$1" active="$2" cmd="$3" key="$4"
  if [ -n "$active" ]; then
    jq -r --arg a "$active" --arg c "$cmd" --arg k "$key" \
      '(.[$a][$c][$k]) // empty' "$file" 2>/dev/null
  else
    jq -r --arg c "$cmd" --arg k "$key" \
      '(.[$c][$k]) // empty' "$file" 2>/dev/null
  fi
}

# Whether this fixture has any expectation declared for the given cmd.
exp_has_cmd() {
  local file="$1" active="$2" cmd="$3"
  if [ -n "$active" ]; then
    jq -r --arg a "$active" --arg c "$cmd" \
      'if (.[$a] // {}) | has($c) then "yes" else "no" end' "$file" 2>/dev/null
  else
    jq -r --arg c "$cmd" \
      'if has($c) then "yes" else "no" end' "$file" 2>/dev/null
  fi
}

for fixture_dir in "$FIXTURES_DIR"/*/; do
  fixture=$(basename "$fixture_dir")
  expected_file="$fixture_dir/expected.json"

  if [ "$MODE" = "fast" ] && is_excluded_in_fast "$fixture"; then
    skip_count=$((skip_count + 1))
    continue
  fi

  [ -f "$expected_file" ] || { record_failure "$fixture" "-" "missing expected.json"; continue; }
  [ -f "$fixture_dir/setup.sh" ] || { record_failure "$fixture" "-" "missing setup.sh"; continue; }

  tmpdir=$(mktemp -d)
  if ! bash "$fixture_dir/setup.sh" "$tmpdir" >/dev/null 2>&1; then
    record_failure "$fixture" "-" "setup.sh failed"
    rm -rf "$tmpdir"
    continue
  fi

  active=$(resolve_active "$expected_file")

  for cmd in "cache --orphans" "list" "topology" "check"; do
    # Skip commands the fixture doesn't declare expectations for.
    if [ "$(exp_has_cmd "$expected_file" "$active" "$cmd")" != "yes" ]; then
      continue
    fi

    # `check` needs a pluginId. Validate that the fixture supplies one
    # whenever it declares a check expectation.
    extra=""
    if [ "$cmd" = "check" ]; then
      pid=$(exp_get "$expected_file" "$active" "$cmd" "pluginId")
      if [ -z "$pid" ]; then
        record_failure "$fixture" "$cmd" \
          "fixture declares check expectation but no .check.pluginId"
        continue
      fi
      extra="$pid"
    fi

    IFS='|' read -ra cmd_flags <<<"$(flags_for "$cmd")"
    for flags in "${cmd_flags[@]}"; do
      stdout_file=$(mktemp); stderr_file=$(mktemp)
      run_failed=0

      # `env -i` scrubs the parent environment so the fixture's
      # synthetic HOME really IS the only HOME cpd sees. Preserve PATH
      # so node + cpd can resolve.
      #
      # CLAUDE_MANAGED_SETTINGS_DIR redirects the macOS policy-settings reads
      # introduced in tranche 2 (extraKnownMarketplaces from policySettings)
      # to a per-fixture path. Without this, cpd would read
      # `/Library/Application Support/ClaudeCode/managed-settings.json` on
      # the host — invisible-but-real on machines with MDM policy. Set to a
      # tmpdir subpath that fixtures can populate if they want to test
      # policy-settings behavior; otherwise the path is absent and reads
      # gracefully return [].
      #
      # `cd "$tmpdir"` keeps `process.cwd()` inside the fixture so the
      # `projectSettings` / `localSettings` readers (which resolve from cwd)
      # don't leak the developer's repo-level `.claude/settings.json` (if
      # any) into fixture results.
      ( cd "$tmpdir" && \
        env -i HOME="$tmpdir" PATH="$PATH" \
          CLAUDE_MANAGED_SETTINGS_DIR="$tmpdir/.policy" \
          "$CPD_BIN" $cmd $extra $flags \
          --json --no-progress --no-log-file \
          > "$stdout_file" 2> "$stderr_file" )
      cpd_exit=$?

      # Compare exit code first.
      expected_exit=$(exp_get "$expected_file" "$active" "$cmd" "exitCode")
      [ -z "$expected_exit" ] && expected_exit=0
      if [ "$cpd_exit" != "$expected_exit" ]; then
        record_failure "$fixture" "$cmd $flags" \
          "exit-code mismatch: cpd=$cpd_exit expected=$expected_exit. stderr: $(head -c 200 "$stderr_file")"
        run_failed=1
      fi

      # errorCode assertion when the fixture declares one (error-envelope path).
      if [ "$run_failed" = 0 ]; then
        expected_code=$(exp_get "$expected_file" "$active" "$cmd" "errorCode")
        if [ -n "$expected_code" ]; then
          actual_code=$(jq -r '.code // empty' "$stdout_file" 2>/dev/null)
          if [ "$actual_code" != "$expected_code" ]; then
            record_failure "$fixture" "$cmd $flags" \
              "error-code mismatch: cpd=$actual_code expected=$expected_code"
            run_failed=1
          fi
        fi
      fi

      # Run oracle for diagnostic-JSON exits (0/2/3). Skip for error
      # envelopes (1/64) — those have no oracle-comparable shape.
      if [ "$run_failed" = 0 ] && [ "$cpd_exit" != 1 ] && [ "$cpd_exit" != 64 ]; then
        oracle_script=$(oracle_for "$cmd")
        mode=$(oracle_mode_for "$cmd")
        if [ -n "$oracle_script" ]; then
          case "$mode" in
            "wire-replica")
              oracle_out=$(mktemp)
              bash "$ORACLES_DIR/$oracle_script" "$tmpdir" > "$oracle_out" 2>/dev/null
              diff_err=$(mktemp)
              if ! node "$DIFF_DIR/json-diff.mjs" "$stdout_file" "$oracle_out" "$cmd" 2> "$diff_err"; then
                record_failure "$fixture" "$cmd $flags" "wire-replica diff: $(head -c 500 "$diff_err")"
                run_failed=1
              fi
              rm -f "$oracle_out" "$diff_err"
              ;;
            "validator")
              # Validator consumes cpd output via stdin; exit non-zero
              # with structured violations on stdout/stderr.
              val_err=$(mktemp)
              if ! bash "$ORACLES_DIR/$oracle_script" "$tmpdir" $extra < "$stdout_file" > "$val_err" 2>&1; then
                record_failure "$fixture" "$cmd $flags" "validator failed: $(head -c 500 "$val_err")"
                run_failed=1
              fi
              rm -f "$val_err"
              ;;
          esac
        fi
      fi

      # Fixture-specific assertions. All optional; absent keys are no-ops.
      if [ "$run_failed" = 0 ] && [ "$cpd_exit" = 0 ]; then
        # exactOrphanCount / exactStrayCount
        for key in exactOrphanCount exactStrayCount; do
          want=$(exp_get "$expected_file" "$active" "$cmd" "$key")
          if [ -n "$want" ]; then
            if [ "$key" = "exactOrphanCount" ]; then
              got=$(jq -r '.orphans | length' "$stdout_file" 2>/dev/null)
            else
              got=$(jq -r '.strayDirs | length' "$stdout_file" 2>/dev/null)
            fi
            if [ "$got" != "$want" ]; then
              record_failure "$fixture" "$cmd $flags" "$key mismatch: got=$got want=$want"
              run_failed=1
            fi
          fi
        done

        # strayReason (asserts the FIRST stray's reason)
        want=$(exp_get "$expected_file" "$active" "$cmd" "strayReason")
        if [ -n "$want" ] && [ "$run_failed" = 0 ]; then
          got=$(jq -r '.strayDirs[0].reason // ""' "$stdout_file" 2>/dev/null)
          if [ "$got" != "$want" ]; then
            record_failure "$fixture" "$cmd $flags" "strayReason mismatch: got=$got want=$want"
            run_failed=1
          fi
        fi

        # min/max byte bounds
        for spec in "minTotalOrphanBytes:totalOrphanBytes:lt" \
                    "maxTotalOrphanBytes:totalOrphanBytes:gt" \
                    "minTotalStrayBytes:totalStrayBytes:lt" \
                    "maxTotalStrayBytes:totalStrayBytes:gt"; do
          [ "$run_failed" = 0 ] || continue
          IFS=: read -r ekey jkey op <<<"$spec"
          want=$(exp_get "$expected_file" "$active" "$cmd" "$ekey")
          [ -n "$want" ] || continue
          got=$(jq -r ".${jkey} // 0" "$stdout_file")
          if [ "$op" = "lt" ] && [ "$got" -lt "$want" ]; then
            record_failure "$fixture" "$cmd $flags" "$jkey=$got below $ekey=$want"
            run_failed=1
          elif [ "$op" = "gt" ] && [ "$got" -gt "$want" ]; then
            record_failure "$fixture" "$cmd $flags" "$jkey=$got above $ekey=$want"
            run_failed=1
          fi
        done
      fi

      if [ "$run_failed" = 0 ]; then
        pass_count=$((pass_count + 1))
      fi

      rm -f "$stdout_file" "$stderr_file"
    done
  done

  rm -rf "$tmpdir"
done

echo
total=$((pass_count + fail_count))
mode_suffix=""
if [ "$skip_count" -gt 0 ]; then
  mode_suffix=" (mode=$MODE, $skip_count fixture(s) skipped)"
fi
echo "QA Harness — $total runs, $pass_count pass, $fail_count fail$mode_suffix"
if [ $fail_count -gt 0 ]; then
  echo
  printf "%s" "$failures"
  exit 1
fi
