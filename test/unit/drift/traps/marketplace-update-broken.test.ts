import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectMarketplaceUpdateBroken } from "../../../../src/drift/traps/marketplace-update-broken.js";
import type {
  MarketplaceCloneData,
  MarketplaceRef,
  UpstreamProbeResult,
} from "../../../../src/types.js";

const marketplaceRef: MarketplaceRef = {
  marketplace: "test-mp",
  root: { kind: "ccd" },
};

const freshUpstream: UpstreamProbeResult = {
  status: "fresh",
  head: "abc1234deadbeef",
  fetchedAt: new Date().toISOString(),
};

function makeCloneData(overrides: Partial<MarketplaceCloneData> = {}): MarketplaceCloneData {
  return {
    kind: "marketplace_clone",
    marketplace: "test-mp",
    cloneRoot: "/home/.claude/plugins/marketplaces/test-mp",
    marketplaceJsonPath:
      "/home/.claude/plugins/marketplaces/test-mp/.claude-plugin/marketplace.json",
    marketplaceJsonExists: true,
    headLocal: "oldsha",
    lastUpdatedAtMs: Date.now() - 2 * 24 * 60 * 60 * 1000, // 2 days ago
    ...overrides,
  };
}

describe("detectMarketplaceUpdateBroken", () => {
  it("returns trap when lastUpdated is recent AND heads diverge", () => {
    const result = detectMarketplaceUpdateBroken({
      marketplaceRef,
      cloneSnapshot: makeCloneData({ headLocal: "oldsha" }),
      upstream: { ...freshUpstream, head: "newsha" },
    });
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("marketplace-update-broken");
    expect(result?.headLocal).toBe("oldsha");
    expect(result?.headRemote).toBe("newsha");
  });

  it("returns null when heads match (up to date)", () => {
    const result = detectMarketplaceUpdateBroken({
      marketplaceRef,
      cloneSnapshot: makeCloneData({ headLocal: "samesha" }),
      upstream: { ...freshUpstream, head: "samesha" },
    });
    expect(result).toBeNull();
  });

  it("returns null when lastUpdatedAtMs is outside the window (old update)", () => {
    const result = detectMarketplaceUpdateBroken({
      marketplaceRef,
      cloneSnapshot: makeCloneData({
        headLocal: "oldsha",
        lastUpdatedAtMs: Date.now() - 14 * 24 * 60 * 60 * 1000, // 14 days ago
      }),
      upstream: { ...freshUpstream, head: "newsha" },
      windowDays: 7,
    });
    expect(result).toBeNull();
  });

  it("returns null when upstream is not fresh", () => {
    const result = detectMarketplaceUpdateBroken({
      marketplaceRef,
      cloneSnapshot: makeCloneData({ headLocal: "oldsha" }),
      upstream: { status: "unreachable", reason: "no-probe" },
    });
    expect(result).toBeNull();
  });

  it("returns null when upstream is missing", () => {
    const result = detectMarketplaceUpdateBroken({
      marketplaceRef,
      cloneSnapshot: makeCloneData({ headLocal: "oldsha" }),
      upstream: undefined,
    });
    expect(result).toBeNull();
  });

  it("returns null when lastUpdatedAtMs is missing", () => {
    const result = detectMarketplaceUpdateBroken({
      marketplaceRef,
      cloneSnapshot: makeCloneData({ lastUpdatedAtMs: undefined }),
      upstream: { ...freshUpstream, head: "newsha" },
    });
    expect(result).toBeNull();
  });

  it("returns null when headLocal is missing", () => {
    const result = detectMarketplaceUpdateBroken({
      marketplaceRef,
      cloneSnapshot: makeCloneData({ headLocal: undefined }),
      upstream: { ...freshUpstream, head: "newsha" },
    });
    expect(result).toBeNull();
  });

  it("respects custom windowDays", () => {
    // 10 days ago, but window is 14 days → should still trigger
    const result = detectMarketplaceUpdateBroken({
      marketplaceRef,
      cloneSnapshot: makeCloneData({
        headLocal: "oldsha",
        lastUpdatedAtMs: Date.now() - 10 * 24 * 60 * 60 * 1000,
      }),
      upstream: { ...freshUpstream, head: "newsha" },
      windowDays: 14,
    });
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("marketplace-update-broken");
  });

  it("emits correct subject shape", () => {
    const result = detectMarketplaceUpdateBroken({
      marketplaceRef,
      cloneSnapshot: makeCloneData({ headLocal: "oldsha" }),
      upstream: { ...freshUpstream, head: "newsha" },
    });
    expect(result?.subject).toEqual({ kind: "marketplace", ref: marketplaceRef });
  });
});
