import { describe, expect, it } from "vitest";
import {
  marketplaceRefKey,
  parsePluginId,
  pluginRefKey,
  rootRefKey,
  rpmKey,
  stripRootSuffix,
} from "../../src/refs.js";

describe("rootRefKey", () => {
  it("encodes ccd as 'ccd'", () => {
    expect(rootRefKey({ kind: "ccd" })).toBe("ccd");
  });

  it("encodes cowork as 'cowork:<acc>:<org>'", () => {
    expect(rootRefKey({ kind: "cowork", accountId: "abc", orgId: "def" })).toBe("cowork:abc:def");
  });

  it("encodes skills-plugin-pair as 'skp:<org>:<acc>' (INVERTED vs cowork)", () => {
    expect(rootRefKey({ kind: "skills-plugin-pair", orgId: "def", accountId: "abc" })).toBe(
      "skp:def:abc",
    );
  });
});

describe("pluginRefKey", () => {
  it("composes plugin@marketplace#rootKey", () => {
    expect(
      pluginRefKey({
        pluginName: "founder-skills",
        marketplace: "lool-founder-skills",
        root: { kind: "ccd" },
      }),
    ).toBe("founder-skills@lool-founder-skills#ccd");
  });

  it("disambiguates same plugin across cowork orgs", () => {
    const a = pluginRefKey({
      pluginName: "p",
      marketplace: "mp",
      root: { kind: "cowork", accountId: "acc", orgId: "org-a" },
    });
    const b = pluginRefKey({
      pluginName: "p",
      marketplace: "mp",
      root: { kind: "cowork", accountId: "acc", orgId: "org-b" },
    });
    expect(a).not.toBe(b);
  });
});

describe("marketplaceRefKey", () => {
  it("composes marketplace#rootKey", () => {
    expect(marketplaceRefKey({ marketplace: "acme", root: { kind: "ccd" } })).toBe("acme#ccd");
  });

  it("does NOT contain '@' (disjoint from plugin keys)", () => {
    const k = marketplaceRefKey({
      marketplace: "acme",
      root: { kind: "cowork", accountId: "a", orgId: "o" },
    });
    expect(k).not.toContain("@");
  });
});

describe("rpmKey", () => {
  it("prefixes with 'rpm:' (disjoint from plugin/marketplace keys)", () => {
    const k = rpmKey({ kind: "cowork", accountId: "a", orgId: "o" }, "plugin_xxx");
    expect(k).toBe("rpm:cowork:a:o:plugin_xxx");
    expect(k.startsWith("rpm:")).toBe(true);
  });
});

describe("key namespace disjointness (load-bearing for ScanReport)", () => {
  it("plugin / marketplace / rpm keys never collide", () => {
    const cowork: { kind: "cowork"; accountId: string; orgId: string } = {
      kind: "cowork",
      accountId: "a",
      orgId: "o",
    };
    const p = pluginRefKey({ pluginName: "x", marketplace: "y", root: cowork });
    const m = marketplaceRefKey({ marketplace: "y", root: cowork });
    const r = rpmKey(cowork, "plugin_x");
    const all = new Set([p, m, r]);
    expect(all.size).toBe(3);
    // No two share a prefix that would cause Record<string,…> collision
    expect(p).toContain("@");
    expect(m).not.toContain("@");
    expect(m.startsWith("rpm:")).toBe(false);
    expect(r.startsWith("rpm:")).toBe(true);
  });
});

describe("parsePluginId (audit issue #13)", () => {
  it("splits on the LAST @ for scoped npm-style names", () => {
    expect(parsePluginId("@scope/foo@mp")).toEqual({
      pluginName: "@scope/foo",
      marketplace: "mp",
    });
  });

  it("handles plain name@mp", () => {
    expect(parsePluginId("plain@mp")).toEqual({ pluginName: "plain", marketplace: "mp" });
  });

  it("returns null for missing separator", () => {
    expect(parsePluginId("noatsign")).toBeNull();
  });

  it("returns null for leading @", () => {
    expect(parsePluginId("@orphan")).toBeNull();
  });

  it("returns null for trailing @", () => {
    expect(parsePluginId("name@")).toBeNull();
  });
});

describe("stripRootSuffix", () => {
  it("removes the #<rootKey> suffix from a pluginRefKey", () => {
    expect(stripRootSuffix("plugin@mp#ccd")).toBe("plugin@mp");
    expect(stripRootSuffix("plugin@mp#cowork:acc:org")).toBe("plugin@mp");
  });

  it("returns input unchanged when no # suffix exists", () => {
    expect(stripRootSuffix("plugin@mp")).toBe("plugin@mp");
  });

  it("composes with parsePluginId for scoped names with root suffix", () => {
    const k = "@scope/foo@mp#ccd";
    const parsed = parsePluginId(stripRootSuffix(k));
    expect(parsed).toEqual({ pluginName: "@scope/foo", marketplace: "mp" });
  });
});
