import { describe, expect, it } from "vitest";
import { detectSourceAdvisory } from "../../../../src/drift/traps/source-advisory.js";
import type { PluginRef } from "../../../../src/types.js";

const pluginRef: PluginRef = {
  pluginName: "test-plugin",
  marketplace: "test-marketplace",
  root: { kind: "ccd" },
};

describe("detectSourceAdvisory", () => {
  it("emits unsupported-source for 'unsupported' kind", () => {
    const result = detectSourceAdvisory({
      pluginRef,
      pluginEntrySourceKind: "unrecognized-source-kind",
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("unsupported-source");
    expect(result[0]?.subject).toEqual({ kind: "plugin", ref: pluginRef });
  });

  it("emits npm-source-not-supported for 'npm' kind", () => {
    const result = detectSourceAdvisory({ pluginRef, pluginEntrySourceKind: "npm" });
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("npm-source-not-supported");
    expect(result[0]?.subject).toEqual({ kind: "plugin", ref: pluginRef });
  });

  it("returns empty for 'string' kind", () => {
    expect(detectSourceAdvisory({ pluginRef, pluginEntrySourceKind: "string" })).toEqual([]);
  });

  it("returns empty for 'github' kind", () => {
    expect(detectSourceAdvisory({ pluginRef, pluginEntrySourceKind: "github" })).toEqual([]);
  });

  it("returns empty for 'git-subdir' kind", () => {
    expect(detectSourceAdvisory({ pluginRef, pluginEntrySourceKind: "git-subdir" })).toEqual([]);
  });

  it("returns empty for 'url' kind", () => {
    expect(detectSourceAdvisory({ pluginRef, pluginEntrySourceKind: "url" })).toEqual([]);
  });
});
