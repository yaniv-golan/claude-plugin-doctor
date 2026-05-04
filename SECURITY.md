# Security Policy

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Please email yaniv@lool.vc with the subject line `SECURITY: claude-plugin-doctor — <short summary>`. Include:

- A description of the issue and its impact
- Steps to reproduce
- Affected version(s)
- Any suggested fix

You'll receive an acknowledgment within 72 hours. A fix and disclosure timeline will be coordinated with you. We follow a 90-day disclosure window by default.

## Supported versions

Security fixes are issued for the latest released minor line. While the project is pre-1.0, only the latest published `0.x` line is supported.

| Version | Supported |
|---|---|
| 0.1.x | ✅ — fixes land on `main` and ship in the next patch release |
| < 0.1 | ❌ |

## Threat model (current)

`claude-plugin-doctor` reads local files and (when `--no-network` is unset) runs `git ls-remote` and HTTP `GET`s against `raw.githubusercontent.com` for plugin manifests. It writes only to its own log directory (`~/.claude-plugin-doctor/logs/`), to backup files it creates (e.g. `.git/cpd-backups/<file>-<ISO-timestamp>` on `cpd refresh --force-fetch`), and — when explicitly opted in via `cpd cache --prune-cowork-sessions --yes` — deletes stale Claude session directories. It does not call Anthropic backend APIs. There is no telemetry.
