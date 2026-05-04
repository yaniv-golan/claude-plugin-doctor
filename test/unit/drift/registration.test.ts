import { describe, expect, it } from "vitest";
import { detectRegistrationDrift } from "../../../src/drift/registration.js";
import type { Topology } from "../../../src/types.js";

function makeTopology(overrides: Partial<Topology> = {}): Topology {
  return {
    cowork: [],
    sessionLocals: [],
    scannedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("detectRegistrationDrift — empty topology", () => {
  it("returns empty when no roots", () => {
    expect(detectRegistrationDrift(makeTopology())).toEqual([]);
  });

  it("returns empty with only ccd but no marketplaces", () => {
    const topology = makeTopology({
      ccd: {
        pluginsRoot: "/root",
        knownMarketplacesPath: "/root/known_marketplaces.json",
        installedPluginsPath: "/root/installed_plugins.json",
        marketplacesDir: "/root/marketplaces",
        cacheDir: "/root/cache",
        marketplaces: [],
      },
    });
    expect(detectRegistrationDrift(topology)).toEqual([]);
  });
});

describe("detectRegistrationDrift — single root", () => {
  it("returns empty when only one root exists (nothing to compare against)", () => {
    const topology = makeTopology({
      ccd: {
        pluginsRoot: "/root",
        knownMarketplacesPath: "/root/known_marketplaces.json",
        installedPluginsPath: "/root/installed_plugins.json",
        marketplacesDir: "/root/marketplaces",
        cacheDir: "/root/cache",
        marketplaces: [
          {
            name: "mp1",
            source: { kind: "github", raw: {} },
            raw: {},
          },
        ],
      },
    });
    // Only one root — mp1 is present in all roots (just the one)
    expect(detectRegistrationDrift(topology)).toEqual([]);
  });
});

describe("detectRegistrationDrift — multi-root drift", () => {
  it("emits drift when marketplace is in ccd but not a cowork root", () => {
    const topology = makeTopology({
      ccd: {
        pluginsRoot: "/root",
        knownMarketplacesPath: "/root/known_marketplaces.json",
        installedPluginsPath: "/root/installed_plugins.json",
        marketplacesDir: "/root/marketplaces",
        cacheDir: "/root/cache",
        marketplaces: [
          {
            name: "mp1",
            source: { kind: "github", raw: {} },
            raw: {},
          },
        ],
      },
      cowork: [
        {
          accountId: "acc1",
          orgId: "org1",
          rootPath: "/cowork1",
          hasCoworkPlugins: true,
          hasRpm: false,
          isMostRecent: true,
          marketplaces: [], // mp1 absent here
        },
      ],
    });
    const drifts = detectRegistrationDrift(topology);
    expect(drifts).toHaveLength(1);
    expect(drifts[0]?.kind).toBe("registration-drift");
    expect(drifts[0]?.scope).toBe("marketplace");
    expect(drifts[0]?.name).toBe("mp1");
    expect(drifts[0]?.presentIn).toHaveLength(1);
    expect(drifts[0]?.presentIn[0]).toEqual({ kind: "ccd" });
    expect(drifts[0]?.absentIn).toHaveLength(1);
    expect(drifts[0]?.absentIn[0]).toEqual({ kind: "cowork", accountId: "acc1", orgId: "org1" });
  });

  it("emits drift when marketplace is in one cowork but not another", () => {
    const topology = makeTopology({
      cowork: [
        {
          accountId: "acc1",
          orgId: "org1",
          rootPath: "/cowork1",
          hasCoworkPlugins: true,
          hasRpm: false,
          isMostRecent: true,
          marketplaces: [{ name: "mp-shared", source: { kind: "github", raw: {} }, raw: {} }],
        },
        {
          accountId: "acc2",
          orgId: "org2",
          rootPath: "/cowork2",
          hasCoworkPlugins: true,
          hasRpm: false,
          isMostRecent: false,
          marketplaces: [], // mp-shared absent
        },
      ],
    });
    const drifts = detectRegistrationDrift(topology);
    expect(drifts).toHaveLength(1);
    expect(drifts[0]?.name).toBe("mp-shared");
    expect(drifts[0]?.presentIn).toHaveLength(1);
    expect(drifts[0]?.absentIn).toHaveLength(1);
  });

  it("does NOT emit drift when marketplace is in all roots", () => {
    const topology = makeTopology({
      ccd: {
        pluginsRoot: "/root",
        knownMarketplacesPath: "/root/known_marketplaces.json",
        installedPluginsPath: "/root/installed_plugins.json",
        marketplacesDir: "/root/marketplaces",
        cacheDir: "/root/cache",
        marketplaces: [{ name: "mp1", source: { kind: "github", raw: {} }, raw: {} }],
      },
      cowork: [
        {
          accountId: "acc1",
          orgId: "org1",
          rootPath: "/cowork1",
          hasCoworkPlugins: true,
          hasRpm: false,
          isMostRecent: true,
          marketplaces: [{ name: "mp1", source: { kind: "github", raw: {} }, raw: {} }],
        },
      ],
    });
    expect(detectRegistrationDrift(topology)).toHaveLength(0);
  });

  it("emits one drift per missing marketplace when multiple are missing", () => {
    const topology = makeTopology({
      ccd: {
        pluginsRoot: "/root",
        knownMarketplacesPath: "/root/known_marketplaces.json",
        installedPluginsPath: "/root/installed_plugins.json",
        marketplacesDir: "/root/marketplaces",
        cacheDir: "/root/cache",
        marketplaces: [
          { name: "mp-a", source: { kind: "github", raw: {} }, raw: {} },
          { name: "mp-b", source: { kind: "github", raw: {} }, raw: {} },
        ],
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
    });
    const drifts = detectRegistrationDrift(topology);
    expect(drifts).toHaveLength(2);
    const names = drifts.map((d) => d.name);
    expect(names).toContain("mp-a");
    expect(names).toContain("mp-b");
  });
});
