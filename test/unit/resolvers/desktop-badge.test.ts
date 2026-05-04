import { describe, expect, it } from "vitest";
import { simulateDesktopBadge } from "../../../src/resolvers/desktop-badge.js";
import type { DesktopBadgeInput, PluginRef } from "../../../src/types.js";

// ──────────────────────────────────────────────────────────────────────────
// Synthetic fixture helpers
// ──────────────────────────────────────────────────────────────────────────

const pluginRef: PluginRef = {
  pluginName: "my-plugin",
  marketplace: "my-marketplace",
  root: { kind: "ccd" },
};

const baseEntry: DesktopBadgeInput["pluginEntry"] = {
  name: "my-plugin",
  sourceRaw: "plugins/my-plugin",
};

function makeStringInput(overrides: Partial<DesktopBadgeInput> = {}): DesktopBadgeInput {
  return {
    pluginRef,
    pluginEntrySourceKind: "string",
    pluginEntry: baseEntry,
    ...overrides,
  };
}

function makeGithubInput(overrides: Partial<DesktopBadgeInput> = {}): DesktopBadgeInput {
  return {
    pluginRef,
    pluginEntrySourceKind: "github",
    pluginEntry: baseEntry,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// String-source tests
// ──────────────────────────────────────────────────────────────────────────

describe("simulateDesktopBadge — string-source", () => {
  it("resolves from plugin.json-in-clone when present (wins over marketplace.json)", () => {
    const result = simulateDesktopBadge(
      makeStringInput({
        pluginJsonInClone: { version: "1.2.3", raw: {} },
        pluginEntry: { ...baseEntry, versionInMarketplaceJson: "0.9.0" },
      }),
    );
    expect(result.resolvedFrom).toBe("plugin.json-in-clone");
    expect(result.resolvedVersion).toBe("1.2.3");
    expect(result.unknowable).toBeUndefined();
  });

  it("falls back to marketplace.json when no in-clone plugin.json", () => {
    const result = simulateDesktopBadge(
      makeStringInput({
        pluginJsonInClone: undefined,
        pluginEntry: { ...baseEntry, versionInMarketplaceJson: "2.0.0" },
      }),
    );
    expect(result.resolvedFrom).toBe("marketplace.json");
    expect(result.resolvedVersion).toBe("2.0.0");
    expect(result.unknowable).toBeUndefined();
  });

  it("falls back to marketplace.json when in-clone plugin.json has no version field", () => {
    const result = simulateDesktopBadge(
      makeStringInput({
        pluginJsonInClone: { version: undefined, raw: {} },
        pluginEntry: { ...baseEntry, versionInMarketplaceJson: "3.0.0" },
      }),
    );
    expect(result.resolvedFrom).toBe("marketplace.json");
    expect(result.resolvedVersion).toBe("3.0.0");
  });

  it("returns unknown when neither source has a version", () => {
    const result = simulateDesktopBadge(
      makeStringInput({
        pluginJsonInClone: undefined,
        pluginEntry: { ...baseEntry, versionInMarketplaceJson: undefined },
      }),
    );
    expect(result.resolvedFrom).toBe("unknown");
    expect(result.resolvedVersion).toBeUndefined();
  });

  it("populates evidence correctly", () => {
    const result = simulateDesktopBadge(
      makeStringInput({
        marketplaceClone: {
          kind: "marketplace_clone",
          marketplace: "my-marketplace",
          cloneRoot: "/home/user/.claude/plugins/marketplaces/my-marketplace",
          marketplaceJsonPath:
            "/home/user/.claude/plugins/marketplaces/my-marketplace/.claude-plugin/marketplace.json",
          marketplaceJsonExists: true,
        },
        pluginJsonInClone: { version: "1.0.0", raw: {} },
        pluginEntry: { ...baseEntry, versionInMarketplaceJson: "0.9.0" },
      }),
    );
    expect(result.evidence.pluginEntrySourceKind).toBe("string");
    expect(result.evidence.cloneRoot).toBe(
      "/home/user/.claude/plugins/marketplaces/my-marketplace",
    );
    expect(result.evidence.pluginJsonInClone).toBe("1.0.0");
    expect(result.evidence.marketplaceJsonVersion).toBe("0.9.0");
    // Badge NEVER uses remote data — always undefined.
    expect(result.evidence.remotePluginJsonVersion).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Object-source tests
// ──────────────────────────────────────────────────────────────────────────

describe("simulateDesktopBadge — object-source (github)", () => {
  it("resolves from marketplace.json (badge cannot use remote data)", () => {
    const result = simulateDesktopBadge(
      makeGithubInput({
        pluginEntry: { ...baseEntry, versionInMarketplaceJson: "3.0.0" },
      }),
    );
    expect(result.resolvedFrom).toBe("marketplace.json");
    expect(result.resolvedVersion).toBe("3.0.0");
    expect(result.unknowable).toBeUndefined();
  });

  it("returns unknown when no marketplace.json version (badge has no other data source)", () => {
    const result = simulateDesktopBadge(
      makeGithubInput({
        pluginEntry: { ...baseEntry, versionInMarketplaceJson: undefined },
      }),
    );
    expect(result.resolvedFrom).toBe("unknown");
    expect(result.resolvedVersion).toBeUndefined();
  });

  it("evidence.remotePluginJsonVersion is always undefined for object-source badge", () => {
    const result = simulateDesktopBadge(
      makeGithubInput({
        pluginEntry: { ...baseEntry, versionInMarketplaceJson: "4.0.0" },
      }),
    );
    // Critical: badge NEVER uses remote-fetched data, even for object-source.
    expect(result.evidence.remotePluginJsonVersion).toBeUndefined();
    expect(result.resolvedFrom).not.toBe("remote-plugin.json");
  });
});

describe("simulateDesktopBadge — object-source (git-subdir)", () => {
  it("falls back to marketplace.json", () => {
    const result = simulateDesktopBadge({
      pluginRef,
      pluginEntrySourceKind: "git-subdir",
      pluginEntry: { ...baseEntry, versionInMarketplaceJson: "1.5.0" },
    });
    expect(result.resolvedFrom).toBe("marketplace.json");
    expect(result.resolvedVersion).toBe("1.5.0");
  });
});

describe("simulateDesktopBadge — object-source (url)", () => {
  it("falls back to marketplace.json", () => {
    const result = simulateDesktopBadge({
      pluginRef,
      pluginEntrySourceKind: "url",
      pluginEntry: { ...baseEntry, versionInMarketplaceJson: "2.2.0" },
    });
    expect(result.resolvedFrom).toBe("marketplace.json");
    expect(result.resolvedVersion).toBe("2.2.0");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Unsupported and npm source kinds
// ──────────────────────────────────────────────────────────────────────────

describe("simulateDesktopBadge — npm and unsupported source kinds", () => {
  it("returns unknowable for npm source", () => {
    const result = simulateDesktopBadge({
      pluginRef,
      pluginEntrySourceKind: "npm",
      pluginEntry: { ...baseEntry, versionInMarketplaceJson: "1.0.0" },
    });
    expect(result.resolvedFrom).toBe("unknown");
    expect(result.unknowable?.reason).toBe("npm-not-supported");
    expect(result.resolvedVersion).toBeUndefined();
  });

  it("returns unknowable for unsupported source", () => {
    const result = simulateDesktopBadge({
      pluginRef,
      pluginEntrySourceKind: "unrecognized-source-kind",
      pluginEntry: { ...baseEntry, versionInMarketplaceJson: "1.0.0" },
    });
    expect(result.resolvedFrom).toBe("unknown");
    expect(result.unknowable?.reason).toBe("unsupported-source");
    expect(result.resolvedVersion).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// CLI vs badge asymmetry — the badge-only-needed trap scenario
// ──────────────────────────────────────────────────────────────────────────

describe("simulateDesktopBadge — CLI vs badge asymmetry", () => {
  it("badge resolves marketplace.json while CLI would resolve remote (different versions = badge-only-needed trap)", () => {
    // This is the key scenario: remote plugin.json has bumped version but
    // marketplace.json hasn't been updated. CLI would fetch fresh (4.1.0),
    // badge only sees marketplace.json (4.0.0). Tier E detects the disagreement.
    const badgeResult = simulateDesktopBadge(
      makeGithubInput({
        pluginEntry: { ...baseEntry, versionInMarketplaceJson: "4.0.0" },
      }),
    );
    expect(badgeResult.resolvedFrom).toBe("marketplace.json");
    expect(badgeResult.resolvedVersion).toBe("4.0.0");
    // The CLI sim would return remote-plugin.json with "4.1.0" — tested
    // separately in cli-update.test.ts. The divergence is badge-only-needed.
  });
});
