import { describe, expect, it } from "vitest";
import type { VersionTrapInput } from "../../../../src/drift/traps/version-traps.js";
import { detectVersionTraps } from "../../../../src/drift/traps/version-traps.js";
import type {
  CliUpdateSim,
  DesktopBadgeSim,
  MarketplaceCloneData,
  PluginRef,
} from "../../../../src/types.js";

const pluginRef: PluginRef = {
  pluginName: "my-plugin",
  marketplace: "my-marketplace",
  root: { kind: "ccd" },
};

const installedSha = "aaabbbccc";
const cloneHeadSha = "dddeeefff";

function makeMarketplaceClone(headLocal: string): MarketplaceCloneData {
  return {
    kind: "marketplace_clone",
    marketplace: "my-marketplace",
    cloneRoot: "/home/.claude/plugins/marketplaces/my-marketplace",
    marketplaceJsonPath:
      "/home/.claude/plugins/marketplaces/my-marketplace/.claude-plugin/marketplace.json",
    marketplaceJsonExists: true,
    headLocal,
  };
}

function makeCli(
  resolvedVersion: string | undefined,
  overrides: Partial<CliUpdateSim> = {},
): CliUpdateSim {
  return {
    resolvedVersion,
    resolvedFrom: "plugin.json-in-clone",
    evidence: {
      pluginEntrySourceKind: "string",
    },
    ...overrides,
  };
}

function makeBadge(
  resolvedVersion: string | undefined,
  overrides: Partial<DesktopBadgeSim> = {},
): DesktopBadgeSim {
  return {
    resolvedVersion,
    resolvedFrom: "plugin.json-in-clone",
    evidence: {
      pluginEntrySourceKind: "string",
    },
    ...overrides,
  };
}

function makeInput(overrides: Partial<VersionTrapInput> = {}): VersionTrapInput {
  return {
    pluginRef,
    cli: makeCli("1.0.0"),
    badge: makeBadge("1.0.0"),
    marketplaceCloneStatus: "stale",
    installedVersion: "1.0.0",
    installedGitCommitSha: installedSha,
    marketplaceClone: makeMarketplaceClone(cloneHeadSha),
    ...overrides,
  };
}

describe("detectVersionTraps — refresh-needed", () => {
  it("detects refresh-needed when versions match and clone status is stale with diverged commits", () => {
    const traps = detectVersionTraps(makeInput({ marketplaceCloneStatus: "stale" }));
    expect(traps).toHaveLength(1);
    expect(traps[0]?.kind).toBe("refresh-needed");
    expect(traps[0]?.subject).toEqual({ kind: "plugin", ref: pluginRef });
  });

  it("does not emit refresh-needed when commits match", () => {
    const traps = detectVersionTraps(
      makeInput({
        installedGitCommitSha: cloneHeadSha, // same as clone head
        marketplaceCloneStatus: "stale",
      }),
    );
    expect(traps.filter((t) => t.kind === "refresh-needed")).toHaveLength(0);
  });

  it("does not emit refresh-needed when installed version differs from cli resolved", () => {
    const traps = detectVersionTraps(
      makeInput({
        installedVersion: "0.9.0",
        cli: makeCli("1.0.0"),
        marketplaceCloneStatus: "stale",
      }),
    );
    expect(traps.filter((t) => t.kind === "refresh-needed")).toHaveLength(0);
  });
});

describe("detectVersionTraps — bump-needed", () => {
  it("detects bump-needed when versions match and clone status is fresh with diverged commits", () => {
    const traps = detectVersionTraps(makeInput({ marketplaceCloneStatus: "fresh" }));
    expect(traps).toHaveLength(1);
    expect(traps[0]?.kind).toBe("bump-needed");
  });

  it("does not emit bump-needed when marketplaceCloneStatus is unknown", () => {
    const traps = detectVersionTraps(makeInput({ marketplaceCloneStatus: "unknown" }));
    expect(traps.filter((t) => t.kind === "bump-needed")).toHaveLength(0);
  });
});

describe("detectVersionTraps — badge-only-needed", () => {
  it("detects badge-only-needed when remote plugin.json version differs from marketplace.json version for object-source", () => {
    const cli = makeCli("2.0.0", {
      evidence: {
        pluginEntrySourceKind: "github",
        remotePluginJsonVersion: "2.0.0",
        marketplaceJsonVersion: "1.5.0",
      },
    });
    const badge = makeBadge("1.5.0", {
      evidence: {
        pluginEntrySourceKind: "github",
        marketplaceJsonVersion: "1.5.0",
      },
    });
    const traps = detectVersionTraps({
      pluginRef,
      cli,
      badge,
      marketplaceCloneStatus: "fresh",
      installedVersion: "2.0.0",
      installedGitCommitSha: cloneHeadSha,
      marketplaceClone: makeMarketplaceClone(cloneHeadSha),
    });
    expect(traps.filter((t) => t.kind === "badge-only-needed")).toHaveLength(1);
  });

  it("does NOT emit badge-only-needed for string-source plugins", () => {
    const cli = makeCli("2.0.0", {
      evidence: {
        pluginEntrySourceKind: "string",
        remotePluginJsonVersion: "2.0.0",
        marketplaceJsonVersion: "1.5.0",
      },
    });
    const badge = makeBadge("1.5.0", {
      evidence: {
        pluginEntrySourceKind: "string",
        marketplaceJsonVersion: "1.5.0",
      },
    });
    const traps = detectVersionTraps({
      pluginRef,
      cli,
      badge,
      marketplaceCloneStatus: "fresh",
      installedVersion: "2.0.0",
      installedGitCommitSha: cloneHeadSha,
      marketplaceClone: makeMarketplaceClone(cloneHeadSha),
    });
    expect(traps.filter((t) => t.kind === "badge-only-needed")).toHaveLength(0);
  });

  it("returns empty when neither trap condition is met", () => {
    const traps = detectVersionTraps({
      pluginRef,
      cli: makeCli("1.0.0"),
      badge: makeBadge("1.0.0"),
      marketplaceCloneStatus: "fresh",
      installedVersion: "1.0.0",
      installedGitCommitSha: cloneHeadSha,
      marketplaceClone: makeMarketplaceClone(cloneHeadSha), // same commit — no divergence
    });
    expect(traps).toHaveLength(0);
  });

  it("can return refresh-needed AND badge-only-needed together", () => {
    const cli = makeCli("1.0.0", {
      evidence: {
        pluginEntrySourceKind: "github",
        remotePluginJsonVersion: "1.0.0",
        marketplaceJsonVersion: "0.9.0",
      },
    });
    const badge = makeBadge("0.9.0", {
      evidence: {
        pluginEntrySourceKind: "github",
        marketplaceJsonVersion: "0.9.0",
      },
    });
    const traps = detectVersionTraps({
      pluginRef,
      cli,
      badge,
      marketplaceCloneStatus: "stale",
      installedVersion: "1.0.0",
      installedGitCommitSha: installedSha, // different from cloneHeadSha → diverged
      marketplaceClone: makeMarketplaceClone(cloneHeadSha),
    });
    const kinds = traps.map((t) => t.kind);
    expect(kinds).toContain("refresh-needed");
    expect(kinds).toContain("badge-only-needed");
  });
});
