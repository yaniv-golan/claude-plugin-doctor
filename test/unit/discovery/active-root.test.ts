import { describe, expect, it } from "vitest";
import { pickMostRecentCoworkRoot } from "../../../src/discovery/active-root.js";
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

describe("pickMostRecentCoworkRoot", () => {
  it("returns undefined for an empty array", () => {
    expect(pickMostRecentCoworkRoot([])).toBeUndefined();
  });

  it("returns undefined when no root has a defined mtime", () => {
    const roots = [makeRoot(), makeRoot({ accountId: "acc2", orgId: "org2" })];
    expect(pickMostRecentCoworkRoot(roots)).toBeUndefined();
  });

  it("returns the single root with a defined mtime", () => {
    const root = makeRoot({ installedPluginsMtime: 1000 });
    expect(pickMostRecentCoworkRoot([root])).toBe(root);
  });

  it("returns the root with the largest mtime", () => {
    const older = makeRoot({ accountId: "acc1", orgId: "org1", installedPluginsMtime: 1000 });
    const newer = makeRoot({ accountId: "acc2", orgId: "org2", installedPluginsMtime: 5000 });
    const oldest = makeRoot({
      accountId: "acc3",
      orgId: "org3",
      installedPluginsMtime: 100,
    });
    expect(pickMostRecentCoworkRoot([older, newer, oldest])).toBe(newer);
  });

  it("tie-breaks on first occurrence (insertion order)", () => {
    const first = makeRoot({ accountId: "acc1", orgId: "org1", installedPluginsMtime: 9999 });
    const second = makeRoot({ accountId: "acc2", orgId: "org2", installedPluginsMtime: 9999 });
    // Same mtime — first one wins.
    expect(pickMostRecentCoworkRoot([first, second])).toBe(first);
  });

  it("ignores roots with undefined mtime when other roots have mtime", () => {
    const withMtime = makeRoot({ accountId: "acc1", orgId: "org1", installedPluginsMtime: 1000 });
    const withoutMtime = makeRoot({ accountId: "acc2", orgId: "org2" });
    expect(pickMostRecentCoworkRoot([withoutMtime, withMtime])).toBe(withMtime);
  });
});
