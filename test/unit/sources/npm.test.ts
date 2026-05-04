import { describe, expect, it } from "vitest";
import { probeNpm } from "../../../src/sources/npm.js";
import type { UpstreamProbeOpts } from "../../../src/types.js";

const opts: UpstreamProbeOpts = { network: true, timeoutMs: 5000 };

describe("probeNpm", () => {
  it("always returns unknowable/npm-not-implemented", () => {
    const result = probeNpm({ kind: "npm", package: "some-pkg" }, opts);
    expect(result).toEqual({ status: "unknowable", reason: "npm-not-implemented" });
  });

  it("returns unknowable even with version and registry specified", () => {
    const result = probeNpm(
      {
        kind: "npm",
        package: "some-pkg",
        version: "1.0.0",
        registry: "https://registry.npmjs.org",
      },
      opts,
    );
    expect(result).toEqual({ status: "unknowable", reason: "npm-not-implemented" });
  });

  it("returns unknowable when network is disabled", () => {
    const result = probeNpm({ kind: "npm", package: "some-pkg" }, { ...opts, network: false });
    expect(result).toEqual({ status: "unknowable", reason: "npm-not-implemented" });
  });
});
