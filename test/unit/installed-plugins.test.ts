import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { firstScope, parseInstalledPlugins, preferredScope } from "../../src/installed-plugins.js";
import type { InstalledPluginScope } from "../../src/types.js";

function writeJson(p: string, data: unknown) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
}

describe("parseInstalledPlugins", () => {
  it("returns absent state when file does not exist", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const r = parseInstalledPlugins(path.join(tmp, "missing.json"));
    expect(r.present).toBe(false);
    expect(r.plugins).toEqual([]);
  });

  it("requires the array shape (single Entry no longer accepted)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const file = path.join(tmp, "installed_plugins.json");
    writeJson(file, {
      version: 2,
      plugins: { "p@mp": { version: "1.0.0", installPath: "/x" } },
    });
    expect(() => parseInstalledPlugins(file)).toThrow(/installed_plugins\.json/);
  });

  it("flags unrecognized file version", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const file = path.join(tmp, "installed_plugins.json");
    writeJson(file, { version: 99, plugins: {} });
    const r = parseInstalledPlugins(file);
    expect(r.unknownFileVersion).toBe(true);
  });

  it("returns mtime from the file stat", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const file = path.join(tmp, "installed_plugins.json");
    writeJson(file, { version: 2, plugins: {} });
    const r = parseInstalledPlugins(file);
    expect(r.mtimeMs).toBeGreaterThan(0);
  });

  it("throws on malformed entries (missing version field inside array)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const file = path.join(tmp, "installed_plugins.json");
    writeJson(file, {
      version: 2,
      plugins: {
        "broken@mp": [{ installPath: "/x" }],
      },
    });
    expect(() => parseInstalledPlugins(file)).toThrow(/installed_plugins\.json/);
  });

  it("exposes all scopes with gitCommitSha and timestamps", () => {
    // Verified against Claude Desktop 1.5354.0.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const file = path.join(tmp, "installed_plugins.json");
    writeJson(file, {
      version: 2,
      plugins: {
        "founder-skills@lool-founder-skills": [
          {
            scope: "user",
            version: "0.2.0",
            installPath: "/Users/me/.claude/plugins/cache/lool-founder-skills/founder-skills/0.2.0",
            installedAt: "2026-04-21T14:32:08.000Z",
            lastUpdated: "2026-04-29T10:55:49.000Z",
            gitCommitSha: "205b6e0b30366a969412d9aab7b99bea99d58db1",
          },
        ],
      },
    });
    const r = parseInstalledPlugins(file);
    const p = r.plugins[0];
    expect(p?.scopes).toHaveLength(1);
    const primary = p?.scopes[0];
    expect(primary?.scope).toBe("user");
    expect(primary?.version).toBe("0.2.0");
    expect(primary?.gitCommitSha).toBe("205b6e0b30366a969412d9aab7b99bea99d58db1");
    expect(primary?.installedAt).toBe("2026-04-21T14:32:08.000Z");
    expect(primary?.lastUpdated).toBe("2026-04-29T10:55:49.000Z");
    expect(primary?.installPath).toContain("founder-skills/0.2.0");
  });

  it("preserves multiple scopes when present", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const file = path.join(tmp, "installed_plugins.json");
    writeJson(file, {
      version: 2,
      plugins: {
        "p@mp": [
          {
            scope: "user",
            version: "1.0.0",
            installPath: "/u/cache/p/1.0.0",
            gitCommitSha: "aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1",
          },
          {
            scope: "project",
            version: "1.0.0",
            installPath: "/proj/cache/p/1.0.0",
            gitCommitSha: "bbbbbbb1bbbbbbb1bbbbbbb1bbbbbbb1bbbbbbb1",
          },
        ],
      },
    });
    const r = parseInstalledPlugins(file);
    const p = r.plugins[0];
    expect(p?.scopes).toHaveLength(2);
    expect(p?.scopes.map((s) => s.scope)).toEqual(["user", "project"]);
    expect(p?.scopes[0]?.gitCommitSha).toBe("aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1");
  });
});

describe("preferredScope (audit issue #12)", () => {
  function s(scope: "user" | "project" | "local" | "managed", v: string): InstalledPluginScope {
    return { scope, version: v, installPath: `/x/${v}`, raw: {} };
  }

  it("prefers user over file-order when user is later in the array", () => {
    // file order: [local, user] — naive scopes[0] would pick local.
    const p = { scopes: [s("local", "1.0.0"), s("user", "0.9.0")] };
    expect(preferredScope(p).scope).toBe("user");
    expect(preferredScope(p).version).toBe("0.9.0");
    // firstScope still respects file order — escape hatch.
    expect(firstScope(p).scope).toBe("local");
  });

  it("falls through user → project → local → first", () => {
    expect(preferredScope({ scopes: [s("project", "p"), s("local", "l")] }).scope).toBe("project");
    expect(preferredScope({ scopes: [s("local", "l"), s("project", "p")] }).scope).toBe("project");
    expect(preferredScope({ scopes: [s("local", "l")] }).scope).toBe("local");
  });

  it("falls back to first scope when none of user/project/local match", () => {
    const p = { scopes: [s("managed", "m1"), s("managed", "m2")] };
    expect(preferredScope(p).version).toBe("m1");
  });

  it("returns identical result on single-scope inputs (regression guard)", () => {
    const p = { scopes: [s("local", "only")] };
    expect(preferredScope(p)).toBe(firstScope(p));
  });
});
