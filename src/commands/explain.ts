export const THREE_NAMESPACE_SECTION = `
─────────────────────────────────────────────────────────────────
Marketplace names — there are THREE of them, and they can differ.

For any marketplace registered on your machine, three separate
identifiers exist:

  1. Your local alias            the name you typed when running
     (standalone Claude Code)    \`claude plugin marketplace add\`
                                 (lives in known_marketplaces.json
                                 under ~/.claude/plugins/)
  2. The author's chosen name    what the marketplace's author put in
                                 the marketplace.json#name field
  3. Cowork's backend name       the name Cowork's backend assigns when
                                 you install via Claude Cowork's in-app
                                 Plugins UI (lives in rpm/manifest.json)

These can all match, all differ, or any partial subset. cpd uses
plugin name + source URL as cross-reference signals when matching
the same plugin across standalone Claude Code and Claude Cowork
storage; do not rely on marketplace name alone.

Reference: https://gist.github.com/yaniv-golan/6c95c08aba98fc8218ef13e99461822f
            (§"\`marketplaceName\` here is the backend's name")
─────────────────────────────────────────────────────────────────
`;

export const EXPLAIN_TEXT = `
The Claude plugin system has six independent cache layers. Any one of them can
go stale on its own. \`cpd\` walks all six and tells you which is the problem.

  ┌─────────┬────────────────────────────────────────┬────────────────────────────────┐
  │ Layer   │ What it is                             │ Refresh command                │
  ├─────────┼────────────────────────────────────────┼────────────────────────────────┤
  │   1     │ Marketplace clone                      │ claude plugin marketplace      │
  │         │ ~/.claude/plugins/marketplaces/<mp>/   │   update <mp>                  │
  │   2     │ Plugin install snapshot                │ claude plugin update           │
  │         │ cache/<mp>/<plugin>/<ver>/             │   <plugin>@<mp>                │
  │   3     │ Claude Cowork session mirror           │ inspect cowork_settings.json   │
  │         │ <userData>/.../<acc>/<org>/...         │                                │
  │   4     │ Backend remote marketplace catalog     │ Settings UI → Refresh          │
  │         │ (server-side)                          │                                │
  │   5     │ Cowork in-app install (Personal        │ Cowork → Plugins UI → Resync   │
  │         │   plugins): <userData>/.../rpm/        │                                │
  │   6     │ Standalone Claude Code remote SSH      │ check on the remote machine    │
  │         │ <host>:.claude/remote/plugins/         │                                │
  └─────────┴────────────────────────────────────────┴────────────────────────────────┘

Common symptoms:

  "Marketplace update says 'already at latest version'"
    → Layer 1 stale (rare 429 cooldown) OR Layer 4 backend cooldown.

  "Plugin update is a no-op even after marketplace refresh"
    → The author pushed commits without bumping plugin.json#version, so
      \`claude plugin update\` is silently a no-op. Use \`cpd check
      <plugin>@<mp>\` to confirm — the detail line will say "Updates blocked"
      and show both commit SHAs.

  "Edited plugin source locally but Claude shows old behavior"
    → Layer 2 source drift (directory-source marketplaces). \`cpd check\`
      will diff the source dir against the cache install.

  "Plugin behaves differently in different sessions"
    → Layer 3 cross-root drift (multiple cowork roots).

Glossary (terms you'll see in cpd output):

  Where Claude lives on your machine
    Standalone Claude Code            the CLI you run from a terminal. Its
                                      plugins live in ~/.claude/plugins/.
    Claude Cowork                     the Claude Desktop app's session-storage
                                      area (one folder per logged-in account
                                      and organization), under
                                      <userData>/.../local-agent-mode-sessions/.
                                      Plugins installed via Claude Cowork's
                                      in-app Plugins UI live here, not in
                                      ~/.claude/plugins/.

  In-app installs (Cowork "Personal plugins")
    When you install a plugin from inside Claude Cowork (Plugins → Personal
    plugins → Install), the plugin is downloaded to a per-account/per-org
    directory under <userData>/.../local-agent-mode-sessions/ (specifically,
    the \`rpm/<plugin-id>/\` subtree). Cowork's backend assigns the marketplace
    its own internal name — which can differ from any name you registered
    yourself in standalone Claude Code. cpd cross-references the two by
    plugin name + source URL.

    Cowork backend ID                 a UUID like "plugin_01TNe8..." that
                                      Cowork's backend assigns to each
                                      in-app install. Mostly debug-only;
                                      visible with --verbose.

  Internal abbreviations (not part of cpd's vocabulary; you'll only see
  these in error codes, log files, and source comments)
    CCD                               "Claude Code Desktop" — appears in the
                                      stable error code E_PARSE_INSTALLED_PLUGINS
                                      and in source-level comments that
                                      reference Anthropic's internal naming.
                                      cpd's user-facing output uses
                                      "standalone Claude Code" instead.
    RPM                               "Remote Plugin Manager" — Cowork's
                                      internal name for the in-app install
                                      mechanism described above. cpd's
                                      user-facing output uses "Claude Cowork
                                      (in-app)" or "Personal plugins" instead.

  Statuses (human renderer ↔ JSON 'status' field)
    OK             / fresh         layer matches reference; nothing to do.
    WARN           / stale         layer is behind a known-newer reference.
    FAIL           / missing       layer expected but not present.
    n/a            / skipped       layer doesn't apply in the current mode
                                   (e.g. Cowork session mirror in a
                                   standalone-Claude-Code-only install).
    not-implemented/ skipped       Layer 4 (backend marketplace) and Layer 6
                                   (standalone Claude Code remote SSH) —
                                   reserved for v1.0; cpd does not introspect
                                   them yet.
    unknown        / unknowable    cpd couldn't determine — usually because
                                   --no-network was set for a Layer 1 check
                                   that needs to reach the remote.

  Other terms
    installed-from <sha>           the marketplace clone HEAD at install time
                                   (compared against current HEAD to detect
                                   the case where the author pushed commits
                                   without bumping plugin.json).
    source dir                     for directory-source marketplaces, the
                                   filesystem path the author edits in-place
                                   (vs. the cache install copy).
    primary scope                  the install scope authoritative for the
                                   plugin's behavior (user > project > local).

  JSON consumers: the 'status' field always uses canonical values
  (fresh|stale|missing|skipped|unknowable). The translations above are
  human-output-only and never appear in --json output.

For the full architecture: see docs/internal/SPEC.md (the spec) and
docs/CLI-DESIGN.md (the agent/script contract this CLI exposes).
`;

export function runExplain(): string {
  return EXPLAIN_TEXT + THREE_NAMESPACE_SECTION;
}
