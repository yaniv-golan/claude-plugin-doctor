import { describe, expect, it } from "vitest";
import { simulateSessionStart } from "../../../src/resolvers/session-start.js";
import type { InstalledPluginScope, PluginRef, SessionStartInput } from "../../../src/types.js";

// ──────────────────────────────────────────────────────────────────────────
// Synthetic fixture helpers
// ──────────────────────────────────────────────────────────────────────────

const pluginRef: PluginRef = {
  pluginName: "my-plugin",
  marketplace: "my-marketplace",
  root: { kind: "ccd" },
};

function makeScope(
  scope: InstalledPluginScope["scope"],
  version: string,
  installPath = `/home/user/.claude/plugins/cache/my-marketplace/my-plugin/${version}`,
): InstalledPluginScope {
  return {
    scope,
    version,
    installPath,
    raw: {},
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Empty scopes
// ──────────────────────────────────────────────────────────────────────────

describe("simulateSessionStart — empty scopes", () => {
  it("returns unknowable with reason not-installed when no scopes", () => {
    const result = simulateSessionStart({
      pluginRef,
      installedScopes: [],
    });
    expect(result.resolvedVersion).toBeUndefined();
    expect(result.installedPath).toBeUndefined();
    expect(result.unknowable?.reason).toBe("not-installed");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Single scope
// ──────────────────────────────────────────────────────────────────────────

describe("simulateSessionStart — single scope", () => {
  it("returns the user scope entry", () => {
    const result = simulateSessionStart({
      pluginRef,
      installedScopes: [makeScope("user", "1.0.0")],
    });
    expect(result.resolvedVersion).toBe("1.0.0");
    expect(result.installedPath).toContain("1.0.0");
    expect(result.unknowable).toBeUndefined();
  });

  it("returns the project scope entry", () => {
    const result = simulateSessionStart({
      pluginRef,
      installedScopes: [makeScope("project", "2.0.0")],
    });
    expect(result.resolvedVersion).toBe("2.0.0");
    expect(result.unknowable).toBeUndefined();
  });

  it("returns the local scope entry", () => {
    const result = simulateSessionStart({
      pluginRef,
      installedScopes: [makeScope("local", "3.0.0")],
    });
    expect(result.resolvedVersion).toBe("3.0.0");
    expect(result.unknowable).toBeUndefined();
  });

  it("returns the unknown scope entry", () => {
    const result = simulateSessionStart({
      pluginRef,
      installedScopes: [makeScope("unknown", "4.0.0")],
    });
    expect(result.resolvedVersion).toBe("4.0.0");
    expect(result.unknowable).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Multi-scope preference order: user > project > local > unknown
// ──────────────────────────────────────────────────────────────────────────

describe("simulateSessionStart — multi-scope preference order", () => {
  it("prefers user over project when both present", () => {
    const result = simulateSessionStart({
      pluginRef,
      installedScopes: [makeScope("project", "project-version"), makeScope("user", "user-version")],
    });
    expect(result.resolvedVersion).toBe("user-version");
  });

  it("prefers user over local when both present", () => {
    const result = simulateSessionStart({
      pluginRef,
      installedScopes: [makeScope("local", "local-version"), makeScope("user", "user-version")],
    });
    expect(result.resolvedVersion).toBe("user-version");
  });

  it("prefers user over unknown when both present", () => {
    const result = simulateSessionStart({
      pluginRef,
      installedScopes: [makeScope("unknown", "unknown-version"), makeScope("user", "user-version")],
    });
    expect(result.resolvedVersion).toBe("user-version");
  });

  it("prefers project over local when user absent", () => {
    const result = simulateSessionStart({
      pluginRef,
      installedScopes: [
        makeScope("local", "local-version"),
        makeScope("project", "project-version"),
      ],
    });
    expect(result.resolvedVersion).toBe("project-version");
  });

  it("prefers project over unknown when user absent", () => {
    const result = simulateSessionStart({
      pluginRef,
      installedScopes: [
        makeScope("unknown", "unknown-version"),
        makeScope("project", "project-version"),
      ],
    });
    expect(result.resolvedVersion).toBe("project-version");
  });

  it("prefers local over unknown when user and project absent", () => {
    const result = simulateSessionStart({
      pluginRef,
      installedScopes: [
        makeScope("unknown", "unknown-version"),
        makeScope("local", "local-version"),
      ],
    });
    expect(result.resolvedVersion).toBe("local-version");
  });

  it("user wins when all four scopes present with different versions", () => {
    const result = simulateSessionStart({
      pluginRef,
      installedScopes: [
        makeScope("unknown", "0.1.0"),
        makeScope("local", "0.2.0"),
        makeScope("project", "0.3.0"),
        makeScope("user", "0.4.0"),
      ],
    });
    expect(result.resolvedVersion).toBe("0.4.0");
  });

  it("populates installedPath from the winning scope", () => {
    const userScope = makeScope("user", "1.0.0", "/custom/install/path");
    const result = simulateSessionStart({
      pluginRef,
      installedScopes: [makeScope("project", "0.9.0"), userScope],
    });
    expect(result.installedPath).toBe("/custom/install/path");
  });

  it("cross-scope drift scenario: each scope has a different version", () => {
    // Tier E detects cross-scope drift separately — the session-start sim
    // simply picks the highest-priority scope. This test verifies the contract
    // that the sim does NOT throw or return unknowable in this scenario.
    const result = simulateSessionStart({
      pluginRef,
      installedScopes: [makeScope("local", "1.0.0"), makeScope("project", "2.0.0")],
    });
    expect(result.resolvedVersion).toBe("2.0.0"); // project > local
    expect(result.unknowable).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Interaction with other simulators
// ──────────────────────────────────────────────────────────────────────────

describe("simulateSessionStart — input contract", () => {
  it("does not use pluginRef — two plugins with identical scopes return the same result shape", () => {
    const input: SessionStartInput = {
      pluginRef,
      installedScopes: [makeScope("user", "1.2.3")],
    };
    const result = simulateSessionStart(input);
    const result2 = simulateSessionStart({
      ...input,
      pluginRef: { ...pluginRef, pluginName: "other-plugin" },
    });
    // Both return same resolvedVersion — pluginRef is carried for identity
    // tracking (tier E), not for version resolution.
    expect(result.resolvedVersion).toBe(result2.resolvedVersion);
  });
});
