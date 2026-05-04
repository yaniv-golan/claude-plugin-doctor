import { describe, expect, it } from "vitest";
import { probeBackend } from "../../../src/sources/backend.js";
import type { UpstreamProbeOpts } from "../../../src/types.js";

const opts: UpstreamProbeOpts = { network: true, timeoutMs: 5000 };

describe("probeBackend", () => {
  it("always returns unknowable/backend regardless of opts", () => {
    const result = probeBackend({ kind: "backend" }, opts);
    expect(result).toEqual({ status: "unknowable", reason: "backend" });
  });

  it("returns unknowable even with network disabled", () => {
    const result = probeBackend({ kind: "backend" }, { ...opts, network: false });
    expect(result).toEqual({ status: "unknowable", reason: "backend" });
  });
});
