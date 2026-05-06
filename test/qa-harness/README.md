# QA harness

A second, independent test tier that runs `cpd` end-to-end against synthetic Claude userData trees and checks its output against an oracle that was implemented separately from the production code.

`npm test` (vitest) verifies that individual modules behave as their authors intended. The QA harness verifies that **the whole CLI, observed as a black box, matches a specification that was rewritten from scratch in bash**. When the two implementations agree, that's evidence the behavior is correct — not just self-consistent.

## When it runs

| Trigger | Tier | Includes | Where |
|---|---|---|---|
| every PR + push to `main` | fast | 17 fixtures + vitest invariants | `.github/workflows/qa-harness.yml` job `fast` |
| weekly Sunday 06:00 UTC | full | adds `truly-massive` (1000 plugins × 50 marketplaces, ~4 min) | same workflow, job `full` |
| `workflow_dispatch` with `mode=full` | full | as above, on demand | manual via the Actions tab |

Locally:

```bash
npm run qa-harness        # fast tier
npm run qa-harness:full   # full tier — includes truly-massive
```

Both scripts run `npm run build` first; the harness invokes the compiled `dist/cli.js`, not source.

## Architecture

```
test/qa-harness/
├── fixtures/                 # one directory per scenario (18 today)
│   └── <name>/
│       ├── setup.sh          # builds a synthetic $HOME tree
│       └── expected.json     # per-command exit codes + assertions
├── oracles/                  # independent reference implementations
│   ├── orphans.sh            # wire-replica oracle for `cache --orphans`
│   ├── list.sh               # validator for `list`
│   ├── topology.sh           # validator for `topology`
│   ├── check.sh              # validator for `check`
│   └── _size.mjs             # shared size helper
├── diff/
│   └── json-diff.mjs         # set-aware, tolerance-aware JSON differ
└── invariants.test.ts        # vitest cross-command invariants (IT-1..IT-22)
```

The driver lives at `scripts/qa-harness.sh`. For every fixture × command × flag combination, it:

1. `mktemp -d`s a fresh `$HOME`, runs the fixture's `setup.sh` to populate it.
2. `env -i`s the parent environment and runs `cpd <cmd> --json --no-progress --no-log-file` against that synthetic `$HOME`.
3. Asserts the exit code matches `expected.json`.
4. If the fixture declares an `errorCode`, asserts the JSON `.code` matches.
5. For diagnostic-JSON exits (0/2/3), runs the oracle in one of two modes (below).
6. Applies fixture-specific assertions (`exactOrphanCount`, `strayReason`, `min/maxTotal*Bytes`, …).

## Two oracle modes

**Wire-replica** — used by `cache --orphans`. The oracle (`orphans.sh`) emits a `CacheOrphansReport`-shaped JSON document built from scratch. `diff/json-diff.mjs` then compares cpd's output against the oracle's:

- volatile fields (`runId`, `startedAt`, `finishedAt`, `logFile`) are stripped from both sides;
- arrays of records (`orphans`, `strayDirs`) are diffed as sets keyed by their natural identifier (`orphanPath`, `strayPath`) — order doesn't matter;
- size fields tolerate ±5% drift to absorb filesystem block-accounting differences.

This is the strongest form of agreement: two independent implementations producing byte-equivalent output.

**Validator** — used by `list`, `topology`, `check`. Producing a wire-replica for these commands would mean reimplementing too much of cpd's diagnostic logic in bash. Instead, the oracle reads cpd's `--json` output on stdin and asserts schema + cross-filesystem invariants:

- exit code is in the documented union (e.g. `{0, 2, 3, 64}` for `check`);
- counts in the report match what's actually on disk (e.g. `installed.length === Object.keys(installed_plugins.json.plugins).length`);
- `installedVersion` matches the directory name under `cache/<mp>/<plugin>/<ver>/`.

A violation prints `VIOLATION (<rule>): <detail>` on stderr and exits non-zero.

## Cross-command invariants (vitest)

`invariants.test.ts` runs separately and parameterizes a smaller set of structural checks across every fixture. These are the things that don't fit cleanly into either oracle mode because they span multiple commands or assert format-level contracts:

- IT-1..IT-10 — count/identity invariants between `list`, `topology`, `check`, `cache --orphans`.
- IT-11..IT-17 — prior-art baselines: `conditionId` shape, instance-id format, recipe presence, `runId` is a valid UUIDv4, timestamps are ISO-8601-Z. Hard-fail since v0.1.0 shipped these.
- IT-18..IT-20 — `Drift.kind` union frozen, `ErrorEnvelope` well-formedness, `--no-network` suppression.

If you change `src/refs.ts`, `src/types.ts`'s `Drift` union, the JSON envelope, or any condition/instance-id format, expect IT-11..IT-22 to fire — that's intentional, they exist to catch silent wire-format breakage.

IT-21 and IT-22 (added with the 2026-05-06 tranche) lock the new advisory-shape and `declaredIn`/`hasClone` invariants from the gist's revision 2026-05-06T11:45:05Z extraKnownMarketplaces integration. IT-21 enumerates the four valid `summary.advisories[].id` values and asserts the per-id `details` shape; IT-22 asserts that any marketplace with `declaredIn` set has a consistent `hasClone` (true iff `known_marketplaces` ∈ declaredIn).

## Fixture format

Every fixture has exactly two files:

**`setup.sh $HOME`** — pure bash, no Node, no `cpd`. Builds a synthetic Claude userData tree under `$1`. Must be deterministic and self-contained. The simplest case (from `fixtures/empty/`):

```bash
#!/usr/bin/env bash
set -euo pipefail
home="$1"
mkdir -p "$home/.claude/plugins"
echo '{}' > "$home/.claude/plugins/known_marketplaces.json"
echo '{"version":2,"plugins":{}}' > "$home/.claude/plugins/installed_plugins.json"
mkdir -p "$home/Library/Application Support/Claude/local-agent-mode-sessions"
```

**`expected.json`** — per-command expectations. Two layouts:

*Flat* (most fixtures):

```json
{
  "list":            { "exitCode": 2 },
  "topology":        { "exitCode": 0 },
  "check":           { "pluginId": "widget@acme", "exitCode": 2 },
  "cache --orphans": { "exitCode": 0, "exactOrphanCount": 0, "exactStrayCount": 0 }
}
```

*Active-block* (when one fixture covers two scenarios — e.g. before/after a mutation):

```json
{
  "active": "current",
  "current": { "list": { "exitCode": 0 }, ... },
  "desired": { "list": { "exitCode": 2 }, ... }
}
```

The driver reads `.active` and selects the corresponding block. Useful when you want a single `setup.sh` to express two states for visual comparison without duplicating the tree-building code.

Per-command keys the driver understands:

| key | applies to | meaning |
|---|---|---|
| `exitCode` | all | required; integer, defaults to 0 |
| `errorCode` | all | when set, asserts JSON `.code` matches (error-envelope path) |
| `pluginId` | `check` | required for `check` expectations; passed as the positional arg |
| `exactOrphanCount` | `cache --orphans` | exact length of `.orphans` |
| `exactStrayCount` | `cache --orphans` | exact length of `.strayDirs` |
| `strayReason` | `cache --orphans` | asserts `.strayDirs[0].reason` |
| `minTotalOrphanBytes` / `maxTotalOrphanBytes` | `cache --orphans` | bounds on `.totalOrphanBytes` |
| `minTotalStrayBytes` / `maxTotalStrayBytes` | `cache --orphans` | bounds on `.totalStrayBytes` |

Any command not listed in `expected.json` is skipped for that fixture.

## Adding a new fixture

1. `mkdir test/qa-harness/fixtures/<name>` — pick a name that describes the scenario (`single-plugin-stale`, `corrupt-marketplace-not-git-repo`).
2. Write `setup.sh` that builds the smallest tree that reproduces the condition. Use `fixtures/empty/setup.sh` as a starting skeleton; copy patterns from a fixture that's already close.
3. Write `expected.json` with `exitCode` for every command you want covered. Add tighter assertions (`exactOrphanCount`, `errorCode`, …) only where they're load-bearing for the scenario — every assertion is a future maintenance cost.
4. Run `npm run qa-harness` locally. Iterate until green.
5. If the fixture exercises a previously untested code path, also add (or extend) a vitest invariant in `invariants.test.ts` so the case is covered at both tiers.

If your fixture is expensive (>1s setup), exclude it from fast mode by adding its basename to `is_excluded_in_fast()` in `scripts/qa-harness.sh`. Today only `truly-massive` is excluded.

## Adding a new oracle or validator

You only need a new oracle when adding a new diagnostic command. The choice between modes:

- **Wire-replica** when the command's output is small and the oracle logic stays bash-readable in <300 lines (`orphans.sh` is ~150 lines).
- **Validator** when the report is large or the logic would mean re-deriving cpd's recommendation engine in bash. Most commands fall here.

Wire the new oracle into both `oracle_for()` and `oracle_mode_for()` in `scripts/qa-harness.sh`, and add a flag matrix entry in `flags_for()` if the command's CLI surface differs from the default.

## Design notes

- The harness is **bash 3.2 portable** — no associative arrays, no `mapfile`. macOS-latest ships bash 3.2 and we don't want to require `brew install bash` in CI.
- `env -i` in the driver is deliberate. Inheriting the parent shell's environment risks fixture leakage (e.g. a real `CLAUDE_CONFIG_DIR` overriding the synthetic `$HOME`). `PATH` is preserved so node + cpd resolve.
- Volatile fields (`runId`, timestamps, log paths) are stripped before diffing. They're asserted separately by the vitest invariants (IT-15, IT-16, IT-17).
- The harness intentionally does not test mutating commands. Per the spec, `cpd` is read-only by default; mutation lives behind opt-in `fix` subcommands which need their own scope-limited harness when they land.
