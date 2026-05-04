import { describe, expect, it } from "vitest";
import { deriveChangedSurfaces } from "../../../src/drift/changed-surfaces.js";

function makePluginJson(raw: Record<string, unknown>) {
  return { raw };
}

describe("deriveChangedSurfaces — conservative fallback", () => {
  it("returns all 7 surfaces when installedPluginJson is missing", () => {
    const result = deriveChangedSurfaces({ resolvedPluginJson: makePluginJson({}) });
    expect(result.provenance).toBe("conservative-all-surfaces");
    expect(result.surfaces).toHaveLength(7);
    expect(result.surfaces).toContain("skill");
    expect(result.surfaces).toContain("command");
    expect(result.surfaces).toContain("agent");
    expect(result.surfaces).toContain("hook");
    expect(result.surfaces).toContain("mcp");
    expect(result.surfaces).toContain("config");
    expect(result.surfaces).toContain("plugin-itself");
  });

  it("returns all 7 surfaces when resolvedPluginJson is missing", () => {
    const result = deriveChangedSurfaces({ installedPluginJson: makePluginJson({}) });
    expect(result.provenance).toBe("conservative-all-surfaces");
    expect(result.surfaces).toHaveLength(7);
  });

  it("returns all 7 surfaces when both are missing", () => {
    const result = deriveChangedSurfaces({});
    expect(result.provenance).toBe("conservative-all-surfaces");
    expect(result.surfaces).toHaveLength(7);
  });
});

describe("deriveChangedSurfaces — diff mode", () => {
  it("returns empty when both plugin.json snapshots are identical", () => {
    const json = makePluginJson({ name: "foo", version: "1.0.0", commands: { test: "x" } });
    const result = deriveChangedSurfaces({
      installedPluginJson: json,
      resolvedPluginJson: json,
    });
    expect(result.provenance).toBe("diff-installed-vs-resolved");
    expect(result.surfaces).toHaveLength(0);
  });

  it("detects command surface change", () => {
    const installed = makePluginJson({ commands: { old: "x" } });
    const resolved = makePluginJson({ commands: { new: "y" } });
    const result = deriveChangedSurfaces({
      installedPluginJson: installed,
      resolvedPluginJson: resolved,
    });
    expect(result.surfaces).toContain("command");
    expect(result.provenance).toBe("diff-installed-vs-resolved");
  });

  it("detects skill surface added", () => {
    const installed = makePluginJson({});
    const resolved = makePluginJson({ skills: [{ name: "foo" }] });
    const result = deriveChangedSurfaces({
      installedPluginJson: installed,
      resolvedPluginJson: resolved,
    });
    expect(result.surfaces).toContain("skill");
  });

  it("detects agent surface removed", () => {
    const installed = makePluginJson({ agents: ["agent1"] });
    const resolved = makePluginJson({});
    const result = deriveChangedSurfaces({
      installedPluginJson: installed,
      resolvedPluginJson: resolved,
    });
    expect(result.surfaces).toContain("agent");
  });

  it("detects hook surface change", () => {
    const installed = makePluginJson({ hooks: { pre: "a" } });
    const resolved = makePluginJson({ hooks: { pre: "b" } });
    const result = deriveChangedSurfaces({
      installedPluginJson: installed,
      resolvedPluginJson: resolved,
    });
    expect(result.surfaces).toContain("hook");
  });

  it("detects mcp surface via mcpServers key", () => {
    const installed = makePluginJson({});
    const resolved = makePluginJson({ mcpServers: { server1: {} } });
    const result = deriveChangedSurfaces({
      installedPluginJson: installed,
      resolvedPluginJson: resolved,
    });
    expect(result.surfaces).toContain("mcp");
  });

  it("detects plugin-itself when version changes", () => {
    const installed = makePluginJson({ name: "foo", version: "1.0.0" });
    const resolved = makePluginJson({ name: "foo", version: "2.0.0" });
    const result = deriveChangedSurfaces({
      installedPluginJson: installed,
      resolvedPluginJson: resolved,
    });
    expect(result.surfaces).toContain("plugin-itself");
  });

  it("detects config surface for unknown top-level key change", () => {
    const installed = makePluginJson({ permissions: { read: true } });
    const resolved = makePluginJson({ permissions: { read: false } });
    const result = deriveChangedSurfaces({
      installedPluginJson: installed,
      resolvedPluginJson: resolved,
    });
    expect(result.surfaces).toContain("config");
  });

  it("detects multiple surfaces in one diff", () => {
    const installed = makePluginJson({ commands: { a: "1" } });
    const resolved = makePluginJson({ commands: { b: "2" }, skills: [{}] });
    const result = deriveChangedSurfaces({
      installedPluginJson: installed,
      resolvedPluginJson: resolved,
    });
    expect(result.surfaces).toContain("command");
    expect(result.surfaces).toContain("skill");
  });
});
