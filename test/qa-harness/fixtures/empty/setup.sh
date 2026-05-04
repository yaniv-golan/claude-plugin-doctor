#!/usr/bin/env bash
# Fixture: empty — a clean machine with no marketplaces, no plugins,
# no cowork sessions. Every command should exit 0 with zero counts.
set -euo pipefail

home="${1:-}"
[ -n "$home" ] || { echo "usage: setup.sh <HOME>" >&2; exit 64; }

mkdir -p "$home/.claude/plugins"
echo '{}' > "$home/.claude/plugins/known_marketplaces.json"
echo '{"version":2,"plugins":{}}' > "$home/.claude/plugins/installed_plugins.json"
mkdir -p "$home/Library/Application Support/Claude/local-agent-mode-sessions"
