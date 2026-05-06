/**
 * Registration drift detector — tier E, phase 5.
 *
 * Detects marketplaces that are registered in some roots but not others.
 * When a marketplace is present in one root (e.g. CCD) but absent from
 * another (e.g. a Cowork root), plugin installs will diverge.
 *
 * Plugin-scoped registration drift (per-plugin presence/absence across roots)
 * requires the full installed_plugins.json data from all roots and is deferred
 * to v1.1. This function implements MARKETPLACE-scoped drift only.
 *
 * TODO(v1.1): Add plugin-scoped registration drift detection once the tier-A
 * integration provides parsed installed_plugins.json data per root.
 *
 * Source of truth: SPEC-v1.0.md §7.1.
 */

import type { RegistrationDrift, RootRef, Topology } from "../types.js";

/**
 * Returns one RegistrationDrift per marketplace that is absent from at least
 * one root. Emits marketplace-scoped drift only.
 *
 * Empty topology (no roots) yields [].
 */
export function detectRegistrationDrift(topology: Topology): RegistrationDrift[] {
  // Collect all roots (CCD + all cowork roots).
  const allRoots: RootRef[] = [];
  if (topology.ccd !== undefined) {
    allRoots.push({ kind: "ccd" });
  }
  for (const cowork of topology.cowork) {
    allRoots.push({ kind: "cowork", accountId: cowork.accountId, orgId: cowork.orgId });
  }

  if (allRoots.length === 0) return [];

  // Build a map: marketplace name → set of root refs that have it.
  //
  // "Has it" means **declared in this root's `marketplaces[]`** — the union
  // of `known_marketplaces.json` entries and `extraKnownMarketplaces`
  // declarations from all applicable settings sources, populated by tier-A
  // discovery (see src/discovery/extra-known-marketplaces.ts and reviewer #5
  // in PLAN-2026-05-06-tranche-2.md). Machine-global settings sources
  // (userSettings, policySettings) get merged into EVERY root, so a
  // marketplace declared only in those will appear in every root's
  // `marketplaces[]` and correctly produce zero registration drift. A
  // marketplace declared only in CCD's `known_marketplaces.json` (or only
  // in one cowork root's per-root `coworkSettings`) will correctly fire
  // drift for the absent roots.
  //
  // Presence is independent of `hasClone` — a settings-only declaration
  // (no materialized clone) still counts as "registered" for cross-root
  // comparison purposes. The clone-presence dimension is handled by other
  // drift kinds (marketplace-update-broken, refresh-needed) that consult
  // `KnownMarketplaceEntry.hasClone`.
  const mpPresence = new Map<string, RootRef[]>();

  if (topology.ccd !== undefined) {
    const ccdRef: RootRef = { kind: "ccd" };
    for (const mp of topology.ccd.marketplaces) {
      const list = mpPresence.get(mp.name) ?? [];
      list.push(ccdRef);
      mpPresence.set(mp.name, list);
    }
  }

  for (const cowork of topology.cowork) {
    const coworkRef: RootRef = { kind: "cowork", accountId: cowork.accountId, orgId: cowork.orgId };
    for (const mp of cowork.marketplaces) {
      const list = mpPresence.get(mp.name) ?? [];
      list.push(coworkRef);
      mpPresence.set(mp.name, list);
    }
  }

  const drifts: RegistrationDrift[] = [];

  for (const [mpName, presentRoots] of mpPresence) {
    // Determine absentIn: roots that do not have this marketplace.
    const presentKeys = new Set(presentRoots.map(rootRefKey));
    const absentRoots = allRoots.filter((r) => !presentKeys.has(rootRefKey(r)));

    if (absentRoots.length > 0) {
      drifts.push({
        kind: "registration-drift",
        scope: "marketplace",
        name: mpName,
        presentIn: presentRoots,
        absentIn: absentRoots,
      });
    }
  }

  return drifts;
}

/** Local helper — avoids importing from refs.ts to keep this module pure-typed. */
function rootRefKey(ref: RootRef): string {
  switch (ref.kind) {
    case "ccd":
      return "ccd";
    case "cowork":
      return `cowork:${ref.accountId}:${ref.orgId}`;
    case "skills-plugin-pair":
      return `skp:${ref.orgId}:${ref.accountId}`;
  }
}
