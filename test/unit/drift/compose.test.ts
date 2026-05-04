import { describe, expect, it } from "vitest";
import { composeDrift, dedupKey } from "../../../src/drift/compose.js";
import { planRecommendations } from "../../../src/recommendations/plan.js";
import type {
  CacheSnapshot,
  CliUpdateSim,
  DesktopBadgeSim,
  Drift,
  InstallSnapshotData,
  MarketplaceCloneData,
  PluginRef,
  SessionStartSim,
  Topology,
} from "../../../src/types.js";

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function emptyTopology(): Topology {
  return {
    cowork: [],
    sessionLocals: [],
    scannedAt: new Date().toISOString(),
  };
}

const pluginRef: PluginRef = {
  pluginName: "test-plugin",
  marketplace: "test-mp",
  root: { kind: "ccd" },
};

function makeInstallSnapshot(): CacheSnapshot {
  const data: InstallSnapshotData = {
    kind: "install_snapshot",
    pluginRef,
    installPath: "/home/.claude/plugins/cache/test-mp/test-plugin/1.0.0",
    installPathExists: true,
    scopes: [
      {
        scope: "user",
        version: "1.0.0",
        installPath: "/home/.claude/plugins/cache/test-mp/test-plugin/1.0.0",
        gitCommitSha: "aaabbbccc",
        raw: {},
      },
    ],
    pluginEntrySourceKind: "string",
    pluginEntryRaw: "plugins/test-plugin",
  };
  return {
    layer: "install_snapshot",
    rootRef: { kind: "ccd" },
    subject: { kind: "plugin", ref: pluginRef },
    presence: "present",
    evidencePaths: ["/home/.claude/plugins/cache/test-mp/test-plugin/1.0.0"],
    parsedAt: new Date().toISOString(),
    data,
  };
}

function makeMarketplaceCloneSnapshot(headLocal: string): CacheSnapshot {
  const data: MarketplaceCloneData = {
    kind: "marketplace_clone",
    marketplace: "test-mp",
    cloneRoot: "/home/.claude/plugins/marketplaces/test-mp",
    marketplaceJsonPath:
      "/home/.claude/plugins/marketplaces/test-mp/.claude-plugin/marketplace.json",
    marketplaceJsonExists: true,
    headLocal,
    lastUpdatedAtMs: Date.now() - 2 * 24 * 60 * 60 * 1000,
  };
  return {
    layer: "marketplace_clone",
    rootRef: { kind: "ccd" },
    subject: { kind: "marketplace", ref: { marketplace: "test-mp", root: { kind: "ccd" } } },
    presence: "present",
    evidencePaths: ["/home/.claude/plugins/marketplaces/test-mp"],
    parsedAt: new Date().toISOString(),
    data,
  };
}

function makeCli(resolvedVersion: string): CliUpdateSim {
  return {
    resolvedVersion,
    resolvedFrom: "plugin.json-in-clone",
    evidence: { pluginEntrySourceKind: "string" },
  };
}

function makeBadge(resolvedVersion: string): DesktopBadgeSim {
  return {
    resolvedVersion,
    resolvedFrom: "plugin.json-in-clone",
    evidence: { pluginEntrySourceKind: "string" },
  };
}

function makeSession(resolvedVersion: string): SessionStartSim {
  return {
    resolvedVersion,
    installedPath: "/home/.claude/plugins/cache/test-mp/test-plugin/1.0.0",
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe("composeDrift — empty input", () => {
  it("returns empty array for completely empty input", () => {
    const result = composeDrift({
      topology: emptyTopology(),
      cacheSnapshots: [],
      upstreams: {},
      resolvers: {},
    });
    expect(result).toEqual([]);
  });

  it("returns empty array when topology has roots but no snapshots or resolvers", () => {
    const topology: Topology = {
      ...emptyTopology(),
      ccd: {
        pluginsRoot: "/home/.claude/plugins",
        knownMarketplacesPath: "/home/.claude/plugins/known_marketplaces.json",
        installedPluginsPath: "/home/.claude/plugins/installed_plugins.json",
        marketplacesDir: "/home/.claude/plugins/marketplaces",
        cacheDir: "/home/.claude/plugins/cache",
        marketplaces: [],
      },
    };
    const result = composeDrift({
      topology,
      cacheSnapshots: [],
      upstreams: {},
      resolvers: {},
    });
    expect(result).toEqual([]);
  });
});

describe("composeDrift — registration drift", () => {
  it("emits registration-drift for marketplace absent from one root", () => {
    const topology: Topology = {
      ccd: {
        pluginsRoot: "/root",
        knownMarketplacesPath: "/root/known_marketplaces.json",
        installedPluginsPath: "/root/installed_plugins.json",
        marketplacesDir: "/root/marketplaces",
        cacheDir: "/root/cache",
        marketplaces: [{ name: "test-mp", source: { kind: "github", raw: {} }, raw: {} }],
      },
      cowork: [
        {
          accountId: "acc1",
          orgId: "org1",
          rootPath: "/cowork1",
          hasCoworkPlugins: true,
          hasRpm: false,
          isMostRecent: true,
          marketplaces: [],
        },
      ],
      sessionLocals: [],
      scannedAt: new Date().toISOString(),
    };
    const result = composeDrift({
      topology,
      cacheSnapshots: [],
      upstreams: {},
      resolvers: {},
    });
    const regDrifts = result.filter((d) => d.kind === "registration-drift");
    expect(regDrifts).toHaveLength(1);
  });
});

describe("composeDrift — marketplace-update-broken", () => {
  it("emits marketplace-update-broken trap when recent and heads diverge", () => {
    const cloneSnap = makeMarketplaceCloneSnapshot("oldsha");
    const result = composeDrift({
      topology: emptyTopology(),
      cacheSnapshots: [cloneSnap],
      upstreams: {
        "test-mp#ccd": { status: "fresh", head: "newsha", fetchedAt: new Date().toISOString() },
      },
      resolvers: {},
    });
    const traps = result.filter((d) => d.kind === "marketplace-update-broken");
    expect(traps).toHaveLength(1);
  });

  it("does not emit marketplace-update-broken trap when heads match", () => {
    const cloneSnap = makeMarketplaceCloneSnapshot("samesha");
    const result = composeDrift({
      topology: emptyTopology(),
      cacheSnapshots: [cloneSnap],
      upstreams: {
        "test-mp#ccd": { status: "fresh", head: "samesha", fetchedAt: new Date().toISOString() },
      },
      resolvers: {},
    });
    const traps = result.filter((d) => d.kind === "marketplace-update-broken");
    expect(traps).toHaveLength(0);
  });
});

describe("composeDrift — version traps", () => {
  it("emits bump-needed when versions match but commits diverged and clone is fresh", () => {
    const installSnap = makeInstallSnapshot();
    const cloneSnap = makeMarketplaceCloneSnapshot("dddeeefff"); // different from aaabbbccc

    const result = composeDrift({
      topology: emptyTopology(),
      cacheSnapshots: [installSnap, cloneSnap],
      upstreams: {
        "test-plugin@test-mp#ccd": {
          status: "fresh",
          head: "dddeeefff",
          fetchedAt: new Date().toISOString(),
        },
        "test-mp#ccd": {
          status: "fresh",
          head: "dddeeefff",
          fetchedAt: new Date().toISOString(),
        },
      },
      resolvers: {
        "test-plugin@test-mp#ccd": {
          cli: makeCli("1.0.0"),
          badge: makeBadge("1.0.0"),
          session: makeSession("1.0.0"),
        },
      },
    });

    const traps = result.filter((d) => d.kind === "bump-needed");
    expect(traps).toHaveLength(1);
  });
});

describe("composeDrift — runtime-boundary suppression (audit issue #5)", () => {
  // Until tier D plumbs structured installed/resolved plugin.json into the
  // composer, deriveChangedSurfaces() falls back to ALL_SURFACES with provenance
  // "conservative-all-surfaces". Emitting runtime-boundary from that fallback
  // would tell the user to restart Claude Desktop on every plugin every scan.
  // The composer suppresses emission unless provenance is the real diff.
  it("does not emit runtime-boundary when changed-surfaces falls back to conservative-all-surfaces", () => {
    const installSnap = makeInstallSnapshot();
    const cloneSnap = makeMarketplaceCloneSnapshot("aaabbbccc");
    const result = composeDrift({
      topology: emptyTopology(),
      cacheSnapshots: [installSnap, cloneSnap],
      upstreams: {
        "test-plugin@test-mp#ccd": {
          status: "fresh",
          head: "aaabbbccc",
          fetchedAt: new Date().toISOString(),
        },
        "test-mp#ccd": {
          status: "fresh",
          head: "aaabbbccc",
          fetchedAt: new Date().toISOString(),
        },
      },
      resolvers: {
        "test-plugin@test-mp#ccd": {
          cli: makeCli("1.0.0"),
          badge: makeBadge("1.0.0"),
          session: makeSession("1.0.0"),
        },
      },
    });
    const boundaries = result.filter((d) => d.kind === "runtime-boundary");
    expect(boundaries).toHaveLength(0);

    // Side-channel guard: if the synthetic global runtime-boundary advisory
    // (recommendations/advisories.ts) is reintroduced upstream, no boundary
    // drifts should still produce no advisory action.
    const actions = planRecommendations(result);
    const advisory = actions.find((a) => a.id === "advisory:runtime-boundary");
    expect(advisory).toBeUndefined();
  });
});

describe("composeDrift — deduplication", () => {
  it("deduplicates identical drift items", () => {
    // Two identical marketplace clone snapshots (different array references but same key)
    const snap1 = makeMarketplaceCloneSnapshot("oldsha");
    const snap2 = makeMarketplaceCloneSnapshot("oldsha");
    // Both will try to emit the same marketplace-update-broken trap
    const result = composeDrift({
      topology: emptyTopology(),
      cacheSnapshots: [snap1, snap2],
      upstreams: {
        "test-mp#ccd": { status: "fresh", head: "newsha", fetchedAt: new Date().toISOString() },
      },
      resolvers: {},
    });
    const traps = result.filter((d) => d.kind === "marketplace-update-broken");
    expect(traps).toHaveLength(1); // deduplicated
  });
});

describe("composeDrift — source advisories", () => {
  it("emits unsupported-source advisory for unsupported plugins", () => {
    const snap = makeInstallSnapshot();
    // Override to unsupported source kind
    const modifiedSnap: CacheSnapshot = {
      ...snap,
      data: {
        ...(snap.data as InstallSnapshotData),
        pluginEntrySourceKind: "unrecognized-source-kind",
      },
    };
    const result = composeDrift({
      topology: emptyTopology(),
      cacheSnapshots: [modifiedSnap],
      upstreams: {},
      resolvers: {
        "test-plugin@test-mp#ccd": {
          cli: makeCli("1.0.0"),
          badge: makeBadge("1.0.0"),
          session: makeSession("1.0.0"),
        },
      },
    });
    const advisories = result.filter((d) => d.kind === "unsupported-source");
    expect(advisories).toHaveLength(1);
  });
});

describe("composeDrift — session bloat", () => {
  it("emits session-bloat trap for old session-local dirs", () => {
    const topology: Topology = {
      ...emptyTopology(),
      sessionLocals: [
        {
          kind: "session-local",
          pathOnDisk: "/cowork1/sessions/oldSession",
          parentRoot: "/cowork1",
          lastModified: Date.now() - 20 * 24 * 60 * 60 * 1000,
          approxSizeBytes: 1024,
        },
      ],
    };
    const result = composeDrift({
      topology,
      cacheSnapshots: [],
      upstreams: {},
      resolvers: {},
    });
    const bloat = result.filter((d) => d.kind === "session-bloat-cleanup-eligible");
    expect(bloat).toHaveLength(1);
  });
});

describe("composeDrift — skills-plugin-stuck", () => {
  it("emits skills-plugin-stuck from a stuck skill snapshot", () => {
    const skillSnap: CacheSnapshot = {
      layer: "skills_plugin",
      rootRef: { kind: "cowork", accountId: "acc1", orgId: "org1" },
      subject: {
        kind: "skill",
        pair: { orgId: "org1", accountId: "acc1" },
        skillName: "stuck-skill",
      },
      presence: "present",
      evidencePaths: ["/some/path"],
      parsedAt: new Date().toISOString(),
      data: {
        kind: "skills_plugin",
        pair: { orgId: "org1", accountId: "acc1", rootPath: "/some/path" },
        skill: {
          name: "stuck-skill",
          dirPath: "/some/path/stuck-skill",
          hasSkillMd: true,
        },
        stuckFailureSignature: true,
      },
    };
    const result = composeDrift({
      topology: emptyTopology(),
      cacheSnapshots: [skillSnap],
      upstreams: {},
      resolvers: {},
    });
    const stuck = result.filter((d) => d.kind === "skills-plugin-stuck");
    expect(stuck).toHaveLength(1);
  });
});

describe("composeDrift — verify-in-ui evidence lookup (audit issue #6)", () => {
  // Background: `runVerifyInUi` persists evidence under the unqualified plugin
  // key `<plugin>@<marketplace>` (no `#<rootKey>` suffix), because the UI is
  // cross-root. The composer iterates resolvers whose keys carry the root
  // suffix. Pre-fix, the lookup `uiEvidence.observations[pkKey]` always missed
  // and BackendUiDrift was never emitted. The fix: fall back to the unqualified
  // form when the root-aware lookup misses.
  it("matches unqualified evidence keys against root-aware resolver keys (single root)", () => {
    const installSnap = makeInstallSnapshot();
    const result = composeDrift({
      topology: emptyTopology(),
      cacheSnapshots: [installSnap],
      upstreams: {},
      resolvers: {
        "test-plugin@test-mp#ccd": {
          cli: makeCli("1.0.0"),
          badge: makeBadge("1.0.0"),
          session: makeSession("1.0.0"),
        },
      },
      uiEvidence: {
        schemaVersion: "1.0",
        observations: {
          // Unqualified key — what verify-in-ui actually writes.
          "test-plugin@test-mp": {
            pluginListed: true,
            versionShown: "1.0.0",
            capturedAt: new Date().toISOString(),
          },
        },
      },
    });
    const ui = result.filter((d) => d.kind === "backend-ui-drift");
    expect(ui).toHaveLength(1);
  });

  it("emits one BackendUiDrift per root when the same observation matches multiple roots", () => {
    // Multi-root semantics (per plan v3): one observation under the unqualified
    // key serves every root the plugin is installed in. Distinct dedupKeys
    // (which include the root) keep them as separate items.
    const ccdSnap = makeInstallSnapshot();
    const coworkRef: PluginRef = {
      pluginName: "test-plugin",
      marketplace: "test-mp",
      root: { kind: "cowork", accountId: "acc1", orgId: "org1" },
    };
    const coworkSnap: CacheSnapshot = {
      ...ccdSnap,
      rootRef: { kind: "cowork", accountId: "acc1", orgId: "org1" },
      subject: { kind: "plugin", ref: coworkRef },
      data: { ...(ccdSnap.data as InstallSnapshotData), pluginRef: coworkRef },
    };
    const capturedAt = new Date().toISOString();
    const result = composeDrift({
      topology: emptyTopology(),
      cacheSnapshots: [ccdSnap, coworkSnap],
      upstreams: {},
      resolvers: {
        "test-plugin@test-mp#ccd": {
          cli: makeCli("1.0.0"),
          badge: makeBadge("1.0.0"),
          session: makeSession("1.0.0"),
        },
        "test-plugin@test-mp#cowork:acc1:org1": {
          cli: makeCli("1.0.0"),
          badge: makeBadge("1.0.0"),
          session: makeSession("1.0.0"),
        },
      },
      uiEvidence: {
        schemaVersion: "1.0",
        observations: {
          "test-plugin@test-mp": {
            pluginListed: true,
            versionShown: "1.0.0",
            capturedAt,
          },
        },
      },
    });
    const ui = result.filter((d) => d.kind === "backend-ui-drift");
    expect(ui).toHaveLength(2);
    // Both pull from the same observation, so timestamps match.
    for (const d of ui) {
      if (d.kind === "backend-ui-drift") {
        expect(d.uiObservedAt).toBe(capturedAt);
      }
    }
  });
});

describe("dedupKey", () => {
  it("produces stable key for registration-drift", () => {
    const d: Drift = {
      kind: "registration-drift",
      scope: "marketplace",
      name: "mp1",
      presentIn: [],
      absentIn: [],
    };
    expect(dedupKey(d)).toBe("registration-drift:marketplace:mp1");
  });

  it("produces stable key for marketplace-update-broken", () => {
    const d: Drift = {
      kind: "marketplace-update-broken",
      subject: { kind: "marketplace", ref: { marketplace: "mp1", root: { kind: "ccd" } } },
      lastUpdatedAtMs: Date.now(),
      headLocal: "old",
      headRemote: "new",
    };
    expect(dedupKey(d)).toBe("marketplace-update-broken:mp1#ccd");
  });

  it("produces stable key for session-bloat-cleanup-eligible", () => {
    const d: Drift = {
      kind: "session-bloat-cleanup-eligible",
      subject: { kind: "root", ref: { kind: "ccd" } },
      bytesReclaimable: 1024,
      dirsCount: 2,
    };
    expect(dedupKey(d)).toBe("session-bloat-cleanup-eligible:ccd");
  });

  it("produces stable key for skills-plugin-stuck", () => {
    const d: Drift = {
      kind: "skills-plugin-stuck",
      subject: { kind: "root", ref: { kind: "ccd" } },
      skill: "my-skill",
    };
    expect(dedupKey(d)).toBe("skills-plugin-stuck:ccd:my-skill");
  });

  it("produces stable key for refresh-needed", () => {
    const d: Drift = {
      kind: "refresh-needed",
      subject: { kind: "plugin", ref: pluginRef },
    };
    expect(dedupKey(d)).toBe("refresh-needed:test-plugin@test-mp#ccd");
  });
});
