---
"claude-plugin-doctor": minor
---

`cpd check <plugin>@<marketplace>` now surfaces BOTH the CCD plugin and the RPM/Personal-plugins install when the same plugin name exists in both surfaces. Previously, `check` short-circuited on the first CCD match and dismissed the RPM surface as `n/a`, hiding stale Personal-plugins installs (the original `proof-engine 1.41 in Claude Desktop while CCD has 1.42` repro).

- `runV05Check` no longer guards the RPM lookup on `!plugin`. The lookup always runs; both `plugin` and `rpmMatch` can now appear together in `V05CheckReport`.
- Exit code aggregates worst-status across the two surfaces (worst-wins: 3 > 2 > 0).
- The human renderer adds an "Also installed via Claude Cowork (Personal plugins)" section after the CCD layer dump when both surfaces resolved.
- The fix is gated on unambiguous matches: when `plugin` is set AND ≥2 RPM matches exist, the disambiguation block is suppressed (the user got a definitive answer for the CCD-style id they typed).
- `renderHumanCheckRpmOnly` now delegates to a shared `renderRpmSection` helper to keep the two render paths in sync.
