import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeDirectory } from "../../../src/sources/directory.js";
import type { UpstreamProbeOpts } from "../../../src/types.js";

const opts: UpstreamProbeOpts = { network: true, timeoutMs: 5000 };

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-dir-probe-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("probeDirectory", () => {
  it("returns fresh with mtime-based head when directory exists", () => {
    const result = probeDirectory({ kind: "directory", path: tmp }, opts);
    expect(result.status).toBe("fresh");
    if (result.status === "fresh") {
      expect(result.head).toMatch(/^\d+(\.\d+)?$/);
      expect(Number(result.head)).toBeGreaterThan(0);
      expect(result.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.pluginJsonVersion).toBeUndefined();
    }
  });

  it("head matches the directory mtime in milliseconds", () => {
    const stat = fs.statSync(tmp);
    const result = probeDirectory({ kind: "directory", path: tmp }, opts);
    expect(result.status).toBe("fresh");
    if (result.status === "fresh") {
      expect(result.head).toBe(String(stat.mtimeMs));
    }
  });

  it("returns unreachable when path does not exist", () => {
    const missing = path.join(tmp, "nonexistent-subdir");
    const result = probeDirectory({ kind: "directory", path: missing }, opts);
    expect(result).toEqual({ status: "unreachable", reason: "directory-not-found" });
  });

  it("returns unreachable even when network is disabled (local I/O always runs)", () => {
    const missing = path.join(tmp, "ghost");
    const result = probeDirectory(
      { kind: "directory", path: missing },
      { ...opts, network: false },
    );
    expect(result).toEqual({ status: "unreachable", reason: "directory-not-found" });
  });

  it("fetchedAt is a valid ISO string close to now", () => {
    const before = Date.now();
    const result = probeDirectory({ kind: "directory", path: tmp }, opts);
    const after = Date.now();
    if (result.status === "fresh") {
      const ts = new Date(result.fetchedAt).getTime();
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after + 100);
    }
  });
});
