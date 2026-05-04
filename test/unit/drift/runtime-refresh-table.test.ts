import { describe, expect, it } from "vitest";
import {
  RUNTIME_REFRESH,
  computeRuntimeBoundary,
  strictestRefresh,
} from "../../../src/drift/runtime-refresh-table.js";
import type { SurfaceKind } from "../../../src/types.js";

describe("RUNTIME_REFRESH table", () => {
  it("has an entry for every SurfaceKind", () => {
    const expected: SurfaceKind[] = [
      "skill",
      "command",
      "agent",
      "hook",
      "mcp",
      "config",
      "plugin-itself",
    ];
    for (const s of expected) {
      expect(RUNTIME_REFRESH[s]).toBeDefined();
    }
  });

  it("mcp is in-task", () => {
    expect(RUNTIME_REFRESH.mcp).toBe("in-task");
  });

  it("config is ui-restart", () => {
    expect(RUNTIME_REFRESH.config).toBe("ui-restart");
  });

  it("skill, command, agent, hook, plugin-itself are new-task", () => {
    for (const s of ["skill", "command", "agent", "hook", "plugin-itself"] as SurfaceKind[]) {
      expect(RUNTIME_REFRESH[s]).toBe("new-task");
    }
  });
});

describe("strictestRefresh", () => {
  it("returns in-task for empty array", () => {
    expect(strictestRefresh([])).toBe("in-task");
  });

  it("returns in-task for a single mcp surface", () => {
    expect(strictestRefresh(["mcp"])).toBe("in-task");
  });

  it("returns new-task for a single skill surface", () => {
    expect(strictestRefresh(["skill"])).toBe("new-task");
  });

  it("returns ui-restart for a single config surface", () => {
    expect(strictestRefresh(["config"])).toBe("ui-restart");
  });

  it("ui-restart beats new-task", () => {
    expect(strictestRefresh(["skill", "config"])).toBe("ui-restart");
  });

  it("ui-restart beats in-task", () => {
    expect(strictestRefresh(["mcp", "config"])).toBe("ui-restart");
  });

  it("new-task beats in-task", () => {
    expect(strictestRefresh(["mcp", "command"])).toBe("new-task");
  });

  it("all surfaces → ui-restart", () => {
    expect(
      strictestRefresh(["skill", "command", "agent", "hook", "mcp", "config", "plugin-itself"]),
    ).toBe("ui-restart");
  });
});

describe("computeRuntimeBoundary", () => {
  it("returns null for empty surfaces", () => {
    expect(computeRuntimeBoundary([])).toBeNull();
  });

  it("returns the strictest refresh for non-empty surfaces", () => {
    expect(computeRuntimeBoundary(["mcp"])).toBe("in-task");
    expect(computeRuntimeBoundary(["skill"])).toBe("new-task");
    expect(computeRuntimeBoundary(["config"])).toBe("ui-restart");
  });
});
