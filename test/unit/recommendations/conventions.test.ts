// Conventions invariants for the recommendation surface.
//
// These tests pin the v0.1.0 baseline so synthetic-or-catalog drift can never
// produce a `RecommendedAction` missing the wire fields the v0.2 `cpd fix`
// runner relies on (conditionId, refs, recipes). Every drift kind goes
// through the planner; every emitted action must satisfy the invariants.

import { describe, expect, it } from "vitest";
import { actionForDrift } from "../../../src/recommendations/catalog.js";
import { planRecommendations } from "../../../src/recommendations/plan.js";
import type { Drift, MarketplaceRef, PluginRef, RootRef } from "../../../src/types.js";

const ccdRoot: RootRef = { kind: "ccd" };
const pluginRef: PluginRef = {
  pluginName: "foo",
  marketplace: "bar",
  root: ccdRoot,
};
const marketplaceRef: MarketplaceRef = { marketplace: "bar", root: ccdRoot };

// One Drift per kind. Aggregating here rather than per-test so the invariant
// loops cleanly; specific shape correctness lives in compose/catalog tests.
const driftFixtures: Drift[] = [
  {
    kind: "registration-drift",
    scope: "plugin",
    name: "foo",
    marketplace: "bar",
    presentIn: [ccdRoot],
    absentIn: [],
  },
  {
    kind: "version-drift",
    subject: { kind: "plugin", ref: pluginRef },
    upstreamVersion: "1.1.0",
    installedVersion: "1.0.0",
    ahead: "upstream",
  },
  {
    kind: "resolver-disagreement",
    subject: { kind: "plugin", ref: pluginRef },
    cliVersion: "1.0.0",
    badgeVersion: "1.1.0",
  } as Drift,
  {
    kind: "marketplace-update-broken",
    subject: { kind: "marketplace", ref: marketplaceRef },
    reason: "stuck",
  } as Drift,
  {
    kind: "refresh-needed",
    subject: { kind: "plugin", ref: pluginRef },
  } as Drift,
  {
    kind: "bump-needed",
    subject: { kind: "plugin", ref: pluginRef },
  } as Drift,
  {
    kind: "badge-only-needed",
    subject: { kind: "plugin", ref: pluginRef },
  } as Drift,
  {
    kind: "skills-plugin-stuck",
    subject: { kind: "root", ref: { kind: "skills-plugin-pair", orgId: "o", accountId: "a" } },
    skill: "test-skill",
  } as Drift,
  {
    kind: "session-bloat-cleanup-eligible",
    subject: { kind: "root", ref: { kind: "cowork", accountId: "a", orgId: "o" } },
    bytesReclaimable: 50_000_000,
    dirsCount: 3,
  } as Drift,
  {
    kind: "unsupported-source",
    subject: { kind: "plugin", ref: pluginRef },
  } as Drift,
];

describe("recommendation conventions (v0.1.0 baseline)", () => {
  it("every catalog action has conditionId in <layer>:<condition> form", () => {
    for (const d of driftFixtures) {
      const action = actionForDrift(d, 1);
      if (!action) continue; // advisory-only kinds return undefined, fine.
      expect(action.conditionId).toBeDefined();
      expect(action.conditionId).toMatch(
        /^(marketplace_clone|install_snapshot|cowork_mirror|rpm_copy|ccd_remote_ssh):[a-z0-9_]+$/,
      );
    }
  });

  it("every catalog action has refs[] (possibly empty for root-scoped)", () => {
    for (const d of driftFixtures) {
      const action = actionForDrift(d, 1);
      if (!action) continue;
      expect(action.refs).toBeDefined();
      expect(Array.isArray(action.refs)).toBe(true);
    }
  });

  it("every catalog action has a non-empty recipes array", () => {
    for (const d of driftFixtures) {
      const action = actionForDrift(d, 1);
      if (!action) continue;
      expect(action.recipes).toBeDefined();
      expect(action.recipes?.length).toBeGreaterThan(0);
      for (const recipe of action.recipes ?? []) {
        expect(recipe.kind).toBeDefined();
      }
    }
  });

  it("planRecommendations produces actions with all three fields populated", () => {
    const actions = planRecommendations(driftFixtures);
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) {
      expect(a.conditionId, `missing conditionId on action ${a.id}`).toBeDefined();
      expect(a.refs, `missing refs on action ${a.id}`).toBeDefined();
      expect(a.recipes, `missing recipes on action ${a.id}`).toBeDefined();
      expect(a.recipes?.length).toBeGreaterThan(0);
    }
  });

  it("synthetic runtime-boundary advisory satisfies the invariant", () => {
    // Runtime-boundary advisories are synthesized at planner time. Provide a
    // realistic-shaped runtime-boundary drift (with `changedSurfaces`) so the
    // synthesizer fires; assert the synthesized action carries the same fields
    // as catalog-derived ones.
    const drifts: Drift[] = [
      {
        kind: "runtime-boundary",
        subject: { kind: "plugin", ref: pluginRef },
        changedSurfaces: ["skill"],
      } as unknown as Drift,
    ];
    const actions = planRecommendations(drifts);
    const advisory = actions.find((a) => a.id === "advisory:runtime-boundary");
    expect(advisory, "expected synthetic runtime-boundary advisory").toBeDefined();
    expect(advisory?.conditionId).toBeDefined();
    expect(advisory?.refs).toBeDefined();
    expect(advisory?.recipes).toBeDefined();
    expect(advisory?.recipes?.length).toBeGreaterThan(0);
    expect(advisory?.recipes?.[0]?.kind).toBe("advisory");
  });
});

describe("session-bloat recommendation (audit issue #2)", () => {
  it("generated cmd appends --yes and declares destructive risk", () => {
    // Pre-fix the cmd was `cpd cache --prune-cowork-sessions --older-than 14d`
    // with no --yes; the cli's dryRun default meant running the suggested
    // command verbatim reclaimed zero bytes. The recommendation must be
    // self-fixing — append --yes and set requiresYes/risk truthfully.
    const drift: Drift = {
      kind: "session-bloat-cleanup-eligible",
      subject: { kind: "root", ref: { kind: "cowork", accountId: "a", orgId: "o" } },
      bytesReclaimable: 50_000_000,
      dirsCount: 3,
    } as Drift;
    const action = actionForDrift(drift, 1);
    expect(action).toBeDefined();
    expect(action?.cmd).toContain("--yes");
    expect(action?.requiresYes).toBe(true);
    expect(action?.risk).toBe("destructive");
  });
});
