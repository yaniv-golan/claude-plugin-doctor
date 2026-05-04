import { describe, expect, it } from "vitest";
import { simulateCliUpdate } from "../../../src/resolvers/cli-update.js";
import type { CliUpdateInput, PluginRef } from "../../../src/types.js";

// ──────────────────────────────────────────────────────────────────────────
// Synthetic fixture helpers
// ──────────────────────────────────────────────────────────────────────────

const pluginRef: PluginRef = {
  pluginName: "my-plugin",
  marketplace: "my-marketplace",
  root: { kind: "ccd" },
};

const baseEntry: CliUpdateInput["pluginEntry"] = {
  name: "my-plugin",
  sourceRaw: "plugins/my-plugin",
};

function makeStringInput(overrides: Partial<CliUpdateInput> = {}): CliUpdateInput {
  return {
    pluginRef,
    pluginEntrySourceKind: "string",
    pluginEntry: baseEntry,
    upstreamStatus: "fresh",
    ...overrides,
  };
}

function makeGithubInput(overrides: Partial<CliUpdateInput> = {}): CliUpdateInput {
  return {
    pluginRef,
    pluginEntrySourceKind: "github",
    pluginEntry: baseEntry,
    upstreamStatus: "fresh",
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// String-source tests
// ──────────────────────────────────────────────────────────────────────────

describe("simulateCliUpdate — string-source", () => {
  it("resolves from plugin.json-in-clone when present (wins over marketplace.json)", () => {
    const result = simulateCliUpdate(
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
    const result = simulateCliUpdate(
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
    const result = simulateCliUpdate(
      makeStringInput({
        pluginJsonInClone: { version: undefined, raw: {} },
        pluginEntry: { ...baseEntry, versionInMarketplaceJson: "3.0.0" },
      }),
    );
    expect(result.resolvedFrom).toBe("marketplace.json");
    expect(result.resolvedVersion).toBe("3.0.0");
  });

  it("returns unknown when neither source has a version", () => {
    const result = simulateCliUpdate(
      makeStringInput({
        pluginJsonInClone: undefined,
        pluginEntry: { ...baseEntry, versionInMarketplaceJson: undefined },
      }),
    );
    expect(result.resolvedFrom).toBe("unknown");
    expect(result.resolvedVersion).toBeUndefined();
  });

  it("populates evidence with pluginEntrySourceKind and available versions", () => {
    const result = simulateCliUpdate(
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
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Object-source tests — github
// ──────────────────────────────────────────────────────────────────────────

describe("simulateCliUpdate — object-source (github)", () => {
  it("resolves from remote-plugin.json when upstream is fresh and version present", () => {
    const result = simulateCliUpdate(
      makeGithubInput({
        upstreamStatus: "fresh",
        remotePluginJsonVersion: "4.0.0",
        pluginEntry: { ...baseEntry, versionInMarketplaceJson: "3.0.0" },
      }),
    );
    expect(result.resolvedFrom).toBe("remote-plugin.json");
    expect(result.resolvedVersion).toBe("4.0.0");
    expect(result.unknowable).toBeUndefined();
  });

  it("falls back to marketplace.json when upstream is fresh but no remotePluginJsonVersion", () => {
    const result = simulateCliUpdate(
      makeGithubInput({
        upstreamStatus: "fresh",
        remotePluginJsonVersion: undefined,
        pluginEntry: { ...baseEntry, versionInMarketplaceJson: "3.5.0" },
      }),
    );
    expect(result.resolvedFrom).toBe("marketplace.json");
    expect(result.resolvedVersion).toBe("3.5.0");
    expect(result.unknowable).toBeUndefined();
  });

  it("returns unknown when upstream fresh and neither remote version nor marketplace version", () => {
    const result = simulateCliUpdate(
      makeGithubInput({
        upstreamStatus: "fresh",
        remotePluginJsonVersion: undefined,
        pluginEntry: { ...baseEntry, versionInMarketplaceJson: undefined },
      }),
    );
    expect(result.resolvedFrom).toBe("unknown");
    expect(result.resolvedVersion).toBeUndefined();
  });

  it("returns indeterminate-no-network when upstreamStatus is no-network", () => {
    const result = simulateCliUpdate(
      makeGithubInput({
        upstreamStatus: "no-network",
        // Even with local data available, must be indeterminate.
        pluginEntry: { ...baseEntry, versionInMarketplaceJson: "3.0.0" },
      }),
    );
    expect(result.resolvedFrom).toBe("indeterminate-no-network");
    expect(result.unknowable?.reason).toBe("upstream-unreachable");
    expect(result.resolvedVersion).toBeUndefined();
  });

  it("returns indeterminate-no-network when upstreamStatus is unreachable", () => {
    const result = simulateCliUpdate(
      makeGithubInput({
        upstreamStatus: "unreachable",
        remotePluginJsonVersion: undefined,
        pluginEntry: { ...baseEntry, versionInMarketplaceJson: "2.0.0" },
      }),
    );
    expect(result.resolvedFrom).toBe("indeterminate-no-network");
    expect(result.unknowable?.reason).toBe("upstream-unreachable");
  });

  it("returns indeterminate-no-network when upstreamStatus is unknowable", () => {
    const result = simulateCliUpdate(
      makeGithubInput({
        upstreamStatus: "unknowable",
        pluginEntry: { ...baseEntry, versionInMarketplaceJson: "2.0.0" },
      }),
    );
    expect(result.resolvedFrom).toBe("indeterminate-no-network");
    expect(result.unknowable?.reason).toBe("upstream-unreachable");
  });

  it("populates evidence.remotePluginJsonVersion", () => {
    const result = simulateCliUpdate(
      makeGithubInput({
        upstreamStatus: "fresh",
        remotePluginJsonVersion: "5.1.0",
        pluginEntry: { ...baseEntry, versionInMarketplaceJson: "5.0.0" },
      }),
    );
    expect(result.evidence.remotePluginJsonVersion).toBe("5.1.0");
    expect(result.evidence.marketplaceJsonVersion).toBe("5.0.0");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Object-source tests — git-subdir and url (same branch as github)
// ──────────────────────────────────────────────────────────────────────────

describe("simulateCliUpdate — object-source (git-subdir, url)", () => {
  it("git-subdir: fresh + remoteVersion → remote-plugin.json", () => {
    const result = simulateCliUpdate({
      pluginRef,
      pluginEntrySourceKind: "git-subdir",
      pluginEntry: { ...baseEntry, versionInMarketplaceJson: "1.0.0" },
      remotePluginJsonVersion: "1.1.0",
      upstreamStatus: "fresh",
    });
    expect(result.resolvedFrom).toBe("remote-plugin.json");
    expect(result.resolvedVersion).toBe("1.1.0");
  });

  it("url: no-network → indeterminate", () => {
    const result = simulateCliUpdate({
      pluginRef,
      pluginEntrySourceKind: "url",
      pluginEntry: { ...baseEntry, versionInMarketplaceJson: "1.0.0" },
      upstreamStatus: "no-network",
    });
    expect(result.resolvedFrom).toBe("indeterminate-no-network");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Unsupported and npm source kinds
// ──────────────────────────────────────────────────────────────────────────

describe("simulateCliUpdate — npm and unsupported source kinds", () => {
  it("returns unknowable for npm source", () => {
    const result = simulateCliUpdate({
      pluginRef,
      pluginEntrySourceKind: "npm",
      pluginEntry: { ...baseEntry, versionInMarketplaceJson: "1.0.0" },
      upstreamStatus: "fresh",
    });
    expect(result.resolvedFrom).toBe("unknown");
    expect(result.unknowable?.reason).toBe("npm-not-supported");
    expect(result.resolvedVersion).toBeUndefined();
  });

  it("returns unknowable for unsupported source", () => {
    const result = simulateCliUpdate({
      pluginRef,
      pluginEntrySourceKind: "unrecognized-source-kind",
      pluginEntry: { ...baseEntry, versionInMarketplaceJson: "1.0.0" },
      upstreamStatus: "fresh",
    });
    expect(result.resolvedFrom).toBe("unknown");
    expect(result.unknowable?.reason).toBe("unsupported-source");
    expect(result.resolvedVersion).toBeUndefined();
  });
});
