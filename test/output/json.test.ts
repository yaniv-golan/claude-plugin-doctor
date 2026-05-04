import { describe, expect, it } from "vitest";
import { renderJson } from "../../src/output/json.js";
import type { ScanReport } from "../../src/types.js";

const sample: ScanReport = {
  schemaVersion: "1.0",
  mode: "ccd",
  roots: { ccdPlugins: "/r", coworkOther: [] },
  marketplaces: [],
  plugins: [],
  rpmPlugins: [],
  coworkRoots: [],
  recommendedActions: [],
  exitCode: 0,
  runId: "rid-1",
  startedAt: "2026-04-30T00:00:00.000Z",
  finishedAt: "2026-04-30T00:00:01.000Z",
};

describe("renderJson", () => {
  it("returns a single JSON document parseable by JSON.parse", () => {
    const out = renderJson(sample, { pretty: false });
    const parsed = JSON.parse(out);
    expect(parsed.schemaVersion).toBe("1.0");
    expect(parsed.runId).toBe("rid-1");
  });

  it("ends with a single newline (machine-friendly)", () => {
    const out = renderJson(sample, { pretty: false });
    expect(out.endsWith("\n")).toBe(true);
    expect(out.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
  });

  it("pretty-prints when requested and stays valid JSON", () => {
    const pretty = renderJson(sample, { pretty: true });
    expect(pretty).toContain("\n  ");
    JSON.parse(pretty);
  });
});
