/**
 * Marketplace-update-broken trap detector — tier E, phase 5.
 *
 * Detects the known Anthropic issue where `claude plugin marketplace update`
 * claims success but the local clone HEAD does not advance. The tell-tale
 * sign is a recent `lastUpdated` timestamp in known_marketplaces.json while
 * the local HEAD differs from the upstream HEAD.
 *
 * Source of truth: SPEC-v1.0.md §7.3 + v0.5 SPEC §gist item #13.
 */

import type {
  KnownTrap,
  MarketplaceCloneData,
  MarketplaceRef,
  UpstreamProbeResult,
} from "../../types.js";

export type MarketplaceUpdateBrokenInput = {
  marketplaceRef: MarketplaceRef;
  cloneSnapshot: MarketplaceCloneData;
  upstream?: UpstreamProbeResult;
  /** Window in days to consider lastUpdated "recent". Default 7. */
  windowDays?: number;
};

/**
 * Returns a `marketplace-update-broken` KnownTrap when:
 *   - `cloneSnapshot.lastUpdatedAtMs` is within `windowDays * 86_400_000` ms of now, AND
 *   - upstream status is "fresh" AND `cloneSnapshot.headLocal !== upstream.head`.
 *
 * Returns null otherwise (not triggered, or insufficient data).
 */
export function detectMarketplaceUpdateBroken(
  input: MarketplaceUpdateBrokenInput,
): Extract<KnownTrap, { kind: "marketplace-update-broken" }> | null {
  const { marketplaceRef, cloneSnapshot, upstream, windowDays = 7 } = input;

  // Need lastUpdatedAtMs to determine recency.
  if (cloneSnapshot.lastUpdatedAtMs === undefined) return null;

  // Need a successful upstream probe to know the remote head.
  if (upstream?.status !== "fresh") return null;

  // Need a local head to compare against.
  if (!cloneSnapshot.headLocal) return null;

  // Heads match — no trap.
  if (cloneSnapshot.headLocal === upstream.head) return null;

  // Check if lastUpdated is within the recency window.
  const windowMs = windowDays * 86_400_000;
  const age = Date.now() - cloneSnapshot.lastUpdatedAtMs;
  if (age >= windowMs) return null;

  return {
    kind: "marketplace-update-broken",
    subject: { kind: "marketplace", ref: marketplaceRef },
    lastUpdatedAtMs: cloneSnapshot.lastUpdatedAtMs,
    headLocal: cloneSnapshot.headLocal,
    headRemote: upstream.head,
  };
}
