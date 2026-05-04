// Stable string-form helpers for the v1.0 ref types defined in types.ts.
// These produce the canonical `*Key` strings used as map/record keys
// throughout the v1.0 architecture (composer input, JSON output, log records).
//
// Format reference (SPEC-v1.0.md §2.1):
//   rootRefKey       — "ccd" | "cowork:<acc>:<org>" | "skp:<org>:<acc>"
//   pluginRefKey     — "<plugin>@<marketplace>#<rootKey>"
//   marketplaceRefKey — "<marketplace>#<rootKey>"
//   rpmKey           — "rpm:<rootKey>:<pluginId>"
//
// The three plugin/marketplace/rpm key spaces are disjoint by construction:
//   - plugin keys carry "@<mp>"
//   - marketplace keys do not carry "@"
//   - rpm keys are prefixed with "rpm:"

import type {
  MarketplaceRef,
  MarketplaceRefKey,
  PluginRef,
  PluginRefKey,
  RootRef,
} from "./types.js";

/**
 * Parse a plugin id string of the form `<plugin>@<marketplace>` into its
 * components. Splits on the LAST `@` so that scoped npm-style plugin names
 * like `@scope/foo@mp` round-trip correctly.
 *
 * Returns null when the id has no `@`, the leading segment is empty, or the
 * trailing segment is empty.
 *
 * Source of truth for id-shape decisions; callers that need to split plugin
 * ids must use this helper rather than rolling their own `split("@")` calls
 * (which break on multi-`@` ids — see audit issue #13).
 */
export function parsePluginId(id: string): { pluginName: string; marketplace: string } | null {
  const idx = id.lastIndexOf("@");
  if (idx <= 0 || idx === id.length - 1) return null;
  return {
    pluginName: id.slice(0, idx),
    marketplace: id.slice(idx + 1),
  };
}

/**
 * Strip the `#<rootRefKey>` suffix from a plugin or marketplace ref key,
 * returning the user-facing form. For `name@mp#ccd` returns `name@mp`; for a
 * key without `#`, returns the input unchanged.
 */
export function stripRootSuffix(refKey: string): string {
  const hashIdx = refKey.indexOf("#");
  return hashIdx === -1 ? refKey : refKey.slice(0, hashIdx);
}

export function rootRefKey(ref: RootRef): string {
  switch (ref.kind) {
    case "ccd":
      return "ccd";
    case "cowork":
      return `cowork:${ref.accountId}:${ref.orgId}`;
    case "skills-plugin-pair":
      return `skp:${ref.orgId}:${ref.accountId}`;
  }
}

export function pluginRefKey(ref: PluginRef): PluginRefKey {
  return `${ref.pluginName}@${ref.marketplace}#${rootRefKey(ref.root)}`;
}

export function marketplaceRefKey(ref: MarketplaceRef): MarketplaceRefKey {
  return `${ref.marketplace}#${rootRefKey(ref.root)}`;
}

export function rpmKey(rootRef: RootRef, pluginId: string): string {
  return `rpm:${rootRefKey(rootRef)}:${pluginId}`;
}

// ─── Run identifiers and timestamps ─────────────────────────────────────────
//
// Conventions pack baseline (locked in v0.1.0). One source of truth for the
// two identifier formats that appear on every JSON wire payload (`runId`,
// `startedAt`, `finishedAt`, log entries, error envelopes).
//
//   runId  — UUIDv4 string. Opaque, fixed length, fits the existing
//            `crypto.randomUUID()` callsite in logger.ts. We keep UUID rather
//            than ULID because the existing wire shape already produces
//            UUIDs and switching now would invalidate captured fixtures.
//            Sortability is not load-bearing for cpd's diagnostic output.
//   timestamp — ISO-8601 with the `Z` (UTC) suffix. Always UTC, never local.
//            `Date#toISOString()` already produces this format; this helper
//            exists so future changes (sub-millisecond precision, monotonic
//            clock, etc.) happen in one place.
//
// New code MUST use these helpers. Existing scattered `new Date().toISOString()`
// callsites are migrating to `nowIso()`; new direct calls should not be added.
export function newRunId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}
