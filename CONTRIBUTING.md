# Contributing to claude-plugin-doctor

Thank you for considering a contribution!

## Quick start

```bash
git clone https://github.com/yaniv-golan/claude-plugin-doctor
cd claude-plugin-doctor
npm install
npm run check    # typecheck + lint + test
npm run dev      # run the CLI from source
```

Node 20 or newer required. `nvm use` will pick the version from `.nvmrc`.

## Architecture

The authoritative architecture reference is the public [Architecture & Design Gist](https://gist.github.com/yaniv-golan/6c95c08aba98fc8218ef13e99461822f). Read it before making non-trivial changes — every cache-layer module assumes the reader understands the six-layer model it describes.

The CLI/JSON contract for scripts and AI agents lives in [`docs/CLI-DESIGN.md`](docs/CLI-DESIGN.md). PRs that change stdout, JSON output, exit codes, error codes, or NDJSON events must keep that contract in sync.

Source layout:

- `src/caches/` — one module per cache layer. The universal `CacheSnapshot` shape (`src/types.ts`) is the contract; every layer returns it.
- `src/discovery/`, `src/sources/`, `src/resolvers/`, `src/drift/`, `src/recommendations/` — the v1.0 tier pipeline. `scripts/check-tier-purity.mjs` enforces the import boundaries (run via `npm run lint:tiers`).
- `src/commands/` — one module per subcommand.
- `src/output/` — human and JSON formatters. Both consume the same `ScanReport` shape.

PRs that change behavior in `src/caches/` should reference at least one Anthropic issue from [`docs/anthropic-issue-map.md`](docs/anthropic-issue-map.md), or explain why the change doesn't map to one.

## Tests

We use vitest with TDD. Every PR should have:

- A failing test that demonstrates the bug or required behavior, then
- The minimal change to make it pass.

Run `npm test` before opening a PR. CI runs typecheck + lint + tests on Node 20 and 22 across ubuntu and macOS.

### Writing fixtures

Tests build synthetic Claude userData trees with `fs.mkdtempSync(path.join(os.tmpdir(), "cpd-home-"))` and clean up after themselves. See `test/integration/scan.test.ts` and `test/integration/cli.test.ts` for the canonical pattern. Bug reports are easiest to fix when they ship with a fixture in this style.

### QA harness (second tier)

Beyond vitest, the repo runs a black-box QA harness that exercises the compiled CLI against synthetic `$HOME` trees and compares its output against an independent bash oracle (wire-replica diff for `cache --orphans`, schema/invariant validators for `list`, `topology`, `check`).

```bash
npm run qa-harness        # fast tier (~30 s on macOS)
npm run qa-harness:full   # full tier — adds the truly-massive perf fixture
```

CI runs the fast tier on every PR and the full tier on a weekly cron. See [`test/qa-harness/README.md`](test/qa-harness/README.md) for the architecture, the fixture format, and how to add a new fixture or oracle.

## Linting & formatting

Biome handles both. `npm run lint` runs Biome plus the tier-purity check; `npm run lint:fix` auto-fixes Biome findings. The pre-commit hook (installed by `npm install`) runs Biome on staged files.

## Commit messages

Conventional Commits style: `feat:`, `fix:`, `docs:`, `chore:`, `test:`, `ci:`, `refactor:`. The scope is optional but encouraged: `feat(caches): …`.

## Adding a changeset

If your PR changes user-visible behavior, add a changeset:

```bash
npm run changeset
```

Pick the bump level and write a one-line summary. Commit the resulting `.changeset/*.md` file.

## Reporting issues

Use the issue templates. A failing test (in the style above) makes a bug report dramatically easier to triage and fix.

## Code of conduct

This project follows the Contributor Covenant 2.1. See `CODE_OF_CONDUCT.md`.

## Security

For security issues, do **not** open a public issue. See `SECURITY.md`.
