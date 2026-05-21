import { describe, expect, it } from "vitest";
import {
  effectiveActiveMtime,
  pickMostRecentCoworkRoot,
} from "../../../src/discovery/active-root.js";
import type { CoworkRoot } from "../../../src/types.js";

function makeRoot(overrides: Partial<CoworkRoot> = {}): CoworkRoot {
  return {
    accountId: "acc1",
    orgId: "org1",
    rootPath: "/tmp/acc1/org1",
    hasCoworkPlugins: false,
    hasRpm: false,
    isMostRecent: false,
    marketplaces: [],
    ...overrides,
  };
}

describe("effectiveActiveMtime", () => {
  it("returns undefined when both mtimes are undefined", () => {
    expect(effectiveActiveMtime({})).toBeUndefined();
  });

  it("returns installedPluginsMtime when only that is defined", () => {
    expect(effectiveActiveMtime({ installedPluginsMtime: 1000 })).toBe(1000);
  });

  it("returns rpmManifestMtime when only that is defined", () => {
    expect(effectiveActiveMtime({ rpmManifestMtime: 2000 })).toBe(2000);
  });

  it("returns the max when both are defined", () => {
    expect(effectiveActiveMtime({ installedPluginsMtime: 1000, rpmManifestMtime: 2000 })).toBe(
      2000,
    );
    expect(effectiveActiveMtime({ installedPluginsMtime: 9000, rpmManifestMtime: 2000 })).toBe(
      9000,
    );
  });
});

describe("pickMostRecentCoworkRoot", () => {
  it("returns undefined for an empty array", () => {
    expect(pickMostRecentCoworkRoot([])).toBeUndefined();
  });

  it("returns undefined when no root has any defined mtime", () => {
    const roots = [makeRoot(), makeRoot({ accountId: "acc2", orgId: "org2" })];
    expect(pickMostRecentCoworkRoot(roots)).toBeUndefined();
  });

  it("returns the single root with a defined installed_plugins mtime", () => {
    const root = makeRoot({ installedPluginsMtime: 1000 });
    expect(pickMostRecentCoworkRoot([root])).toBe(root);
  });

  it("returns the single root with a defined rpm-manifest mtime", () => {
    const root = makeRoot({ rpmManifestMtime: 1000 });
    expect(pickMostRecentCoworkRoot([root])).toBe(root);
  });

  it("returns the root with the largest installed_plugins mtime", () => {
    const older = makeRoot({ accountId: "acc1", orgId: "org1", installedPluginsMtime: 1000 });
    const newer = makeRoot({ accountId: "acc2", orgId: "org2", installedPluginsMtime: 5000 });
    const oldest = makeRoot({
      accountId: "acc3",
      orgId: "org3",
      installedPluginsMtime: 100,
    });
    expect(pickMostRecentCoworkRoot([older, newer, oldest])).toBe(newer);
  });

  it("breaks installed_plugins ties using rpm-manifest mtime (the user's repro)", () => {
    // Both sessions have the same installed_plugins.json mtime, but the second
    // had a Personal-plugins install that touched only rpm/manifest.json.
    const ccdLike = makeRoot({
      accountId: "acc1",
      orgId: "org1",
      installedPluginsMtime: 5000,
      rpmManifestMtime: 1000,
    });
    const liveRpm = makeRoot({
      accountId: "acc2",
      orgId: "org2",
      installedPluginsMtime: 5000,
      rpmManifestMtime: 9999,
    });
    expect(pickMostRecentCoworkRoot([ccdLike, liveRpm])).toBe(liveRpm);
  });

  it("rpm-manifest mtime wins over a lower installed_plugins mtime in a different root", () => {
    const olderInstalled = makeRoot({
      accountId: "acc1",
      orgId: "org1",
      installedPluginsMtime: 3000,
    });
    const newerRpmOnly = makeRoot({
      accountId: "acc2",
      orgId: "org2",
      rpmManifestMtime: 9000,
    });
    expect(pickMostRecentCoworkRoot([olderInstalled, newerRpmOnly])).toBe(newerRpmOnly);
  });

  it("tie-breaks on first occurrence (insertion order)", () => {
    const first = makeRoot({ accountId: "acc1", orgId: "org1", installedPluginsMtime: 9999 });
    const second = makeRoot({ accountId: "acc2", orgId: "org2", installedPluginsMtime: 9999 });
    // Same effective mtime — first one wins.
    expect(pickMostRecentCoworkRoot([first, second])).toBe(first);
  });

  it("ignores roots with no defined mtime when other roots have any mtime", () => {
    const withMtime = makeRoot({ accountId: "acc1", orgId: "org1", installedPluginsMtime: 1000 });
    const withoutMtime = makeRoot({ accountId: "acc2", orgId: "org2" });
    expect(pickMostRecentCoworkRoot([withoutMtime, withMtime])).toBe(withMtime);
  });
});
