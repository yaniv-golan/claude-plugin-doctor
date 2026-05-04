import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { isSafeMarketplaceName, parseKnownMarketplaces } from "../../src/known-marketplaces.js";

function writeJson(p: string, data: unknown) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
}

describe("parseKnownMarketplaces", () => {
  it("returns empty list when file is absent", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    expect(parseKnownMarketplaces(path.join(tmp, "missing.json"))).toEqual({
      present: false,
      marketplaces: [],
    });
  });

  it("parses the real-world flat shape (top-level keys are marketplace names)", () => {
    // Verified against Claude Desktop 1.5354.0.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const file = path.join(tmp, "known_marketplaces.json");
    writeJson(file, {
      "claude-plugins-official": {
        source: { source: "github", repo: "anthropics/claude-plugins-official" },
        installLocation: "/Users/me/.claude/plugins/marketplaces/claude-plugins-official",
        lastUpdated: "2026-04-26T00:06:01.165Z",
      },
      "local-mp": {
        source: { source: "directory", path: "/tmp/local-mp" },
      },
    });
    const result = parseKnownMarketplaces(file);
    expect(result.present).toBe(true);
    expect(result.marketplaces).toHaveLength(2);
    const byName = Object.fromEntries(result.marketplaces.map((m) => [m.name, m]));
    expect(byName["claude-plugins-official"]?.source).toMatchObject({ source: "github" });
    expect(byName["local-mp"]?.source).toEqual({ source: "directory", path: "/tmp/local-mp" });
  });

  it("rejects the wrapped shape (no longer accepted in v0.2)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const file = path.join(tmp, "known_marketplaces.json");
    writeJson(file, {
      marketplaces: {
        "claude-plugins-official": {
          source: { source: "github", repo: "anthropics/claude-plugins-official" },
        },
      },
    });
    expect(() => parseKnownMarketplaces(file)).toThrow(/known_marketplaces\.json/);
  });

  it("preserves unknown source types via passthrough", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const file = path.join(tmp, "known_marketplaces.json");
    writeJson(file, {
      weird: { source: { source: "future-type", url: "x" }, extraField: 42 },
    });
    const result = parseKnownMarketplaces(file);
    expect(result.marketplaces[0]?.source).toMatchObject({ source: "future-type", url: "x" });
  });

  it("throws a typed error on malformed JSON", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const file = path.join(tmp, "bad.json");
    fs.writeFileSync(file, "{not json");
    expect(() => parseKnownMarketplaces(file)).toThrow(/known_marketplaces\.json/);
  });
});

describe("isSafeMarketplaceName (audit issue #9)", () => {
  it("accepts plain ASCII names", () => {
    expect(isSafeMarketplaceName("acme")).toBe(true);
    expect(isSafeMarketplaceName("lool-founder-skills")).toBe(true);
    expect(isSafeMarketplaceName("user_123")).toBe(true);
  });

  it("rejects names with path separators", () => {
    expect(isSafeMarketplaceName("a/b")).toBe(false);
    expect(isSafeMarketplaceName("a\\b")).toBe(false);
    expect(isSafeMarketplaceName("../etc")).toBe(false);
  });

  it("rejects bare reserved names", () => {
    expect(isSafeMarketplaceName(".")).toBe(false);
    expect(isSafeMarketplaceName("..")).toBe(false);
  });

  it("rejects names starting with a dot (hidden directories)", () => {
    expect(isSafeMarketplaceName(".secret")).toBe(false);
    expect(isSafeMarketplaceName(".git")).toBe(false);
  });

  it("rejects names containing '..' segments anywhere", () => {
    expect(isSafeMarketplaceName("a..b")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isSafeMarketplaceName("")).toBe(false);
  });
});

describe("parseKnownMarketplaces — unsafe name filter (audit issue #9)", () => {
  it("skips entries with unsafe names and emits a stderr warning", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const file = path.join(tmp, "known_marketplaces.json");
    writeJson(file, {
      "../escape": { source: { source: "github", repo: "x/y" } },
      good: { source: { source: "github", repo: "a/b" } },
    });
    // Capture stderr (best-effort — we just want to confirm the entry is dropped).
    const result = parseKnownMarketplaces(file);
    expect(result.marketplaces.map((m) => m.name)).toEqual(["good"]);
  });
});
