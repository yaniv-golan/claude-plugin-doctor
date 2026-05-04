export const HELP_EPILOG = `
Subcommands:
  cpd scan [options]                     Full six-layer cache scan (default)
  cpd check <plugin>@<mp>               Single-plugin deep dive with evidence
  cpd list [--json]                      Flat inventory of marketplaces and plugins
  cpd refresh <mp> [--force-fetch]      Run marketplace update with before/after diff
  cpd topology [--json]                 Show discovered installation layout
  cpd cache --orphans                    List install-snapshot dirs no longer referenced
  cpd cache --prune-cowork-sessions      Reap stale local_<UUID>/ session dirs (dry-run by default)
  cpd verify-in-ui <plugin>@<mp>        Capture Claude Desktop UI evidence for a plugin
  cpd explain                           Print the six-layer architecture cheat-sheet
  cpd watch <plugin>@<mp>               Re-check on file changes (macOS only)

Examples:
  cpd                                    Run a full scan with default settings
  cpd --json                             Emit machine-readable scan report on stdout
  cpd --json | jq '.drifts[]'           Pipe v1.0 drift list to jq
  cpd topology --json                    Inspect discovered roots as JSON
  cpd --no-network                       Skip git ls-remote (offline mode)
  cpd --ndjson-events 2>events.log       Stream phase events to a file
  cpd --log-file /tmp/c.log             Override default log location
  CLAUDE_CONFIG_DIR=/alt cpd --no-color  Run against an alternate Claude config

Output streams:
  stdout                                 Scan report (human or JSON). Pipe-safe.
  stderr                                 Progress + log mirror + errors.
  Default log file                       ~/.claude-plugin-doctor/logs/cpd-<timestamp>.log
                                         (one file per run; \`tail -f\` works in real time)

Exit codes:
   0   Everything fresh, no drift
   1   Generic error (file not found, malformed JSON, etc.)
   2   Drift detected (any layer stale) — fixes available
   3   Drift detected, manual / destructive fix required
  64   Usage error

Environment:
  NO_COLOR                               Disable ANSI color (any value)
  CLAUDE_CONFIG_DIR                      Override ~/.claude
  CI                                     Force non-TTY mode (no spinner)
  TERM=dumb                              Force non-TTY mode

Stable error codes (for AI agents and scripts):
  E_PLATFORM_UNSUPPORTED                 Running on non-macOS (1.0 is macOS-only)
  E_PARSE_KNOWN_MARKETPLACES             known_marketplaces.json malformed
  E_PARSE_INSTALLED_PLUGINS              installed_plugins.json malformed
  E_PARSE_RPM_MANIFEST                   rpm/manifest.json malformed
  E_PARSE_MARKETPLACE_JSON               A marketplace.json failed schema
  E_PARSE_PLUGIN_JSON                    A plugin.json failed schema
  E_PARSE_SKILLS_PLUGIN_MANIFEST         A skills-plugin manifest failed schema
  E_GIT_TIMEOUT                          git ls-remote timed out
  E_FETCH_TIMEOUT                        HTTP fetch (e.g. raw.githubusercontent) timed out
  E_FETCH_NETWORK                        HTTP fetch failed (DNS, non-200, etc.)
  E_FORCE_FETCH_ABORTED                  cpd refresh --force-fetch declined or aborted
  E_VERIFY_IN_UI_INPUT                   cpd verify-in-ui got malformed input
  E_UI_EVIDENCE_SCHEMA                   ui-evidence.json on disk has unsupported schema
  E_USAGE                                Bad CLI invocation

See docs/CLI-DESIGN.md for the full agent/script contract.
`;
