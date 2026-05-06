/**
 * Tests for `src/discovery/extra-known-marketplaces.ts`.
 *
 * Covers reader, drop-in enumeration, cross-cutting orchestration, merge,
 * and the security rejection of unsafe marketplace names. Tests are
 * hermetic — settings paths are injected via SystemContext + env vars
 * (CLAUDE_CONFIG_DIR for userSettings, CLAUDE_MANAGED_SETTINGS_DIR for
 * policySettings, ctx.cwd for project/local settings).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  enumerateDropIns,
  mergeMarketplaceDeclarations,
  readCrossCuttingExtraKnownMarketplaces,
  readExtraKnownMarketplacesFrom,
  resolveSettingsPaths,
} from "../../../src/discovery/extra-known-marketplaces.js";
import type { KnownMarketplaceEntry } from "../../../src/types.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-extra-mp-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeJson(p: string, data: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

describe("readExtraKnownMarketplacesFrom", () => {
  it("returns [] when the file is absent", () => {
    const result = readExtraKnownMarketplacesFrom(
      path.join(tmp, "nonexistent.json"),
      "userSettings",
    );
    expect(result).toEqual([]);
  });

  it("returns [] when the file has no extraKnownMarketplaces key", () => {
    const settings = path.join(tmp, "settings.json");
    writeJson(settings, { theme: "dark", model: "sonnet" });
    expect(readExtraKnownMarketplacesFrom(settings, "userSettings")).toEqual([]);
  });

  it("returns [] when the file is empty", () => {
    const settings = path.join(tmp, "settings.json");
    fs.writeFileSync(settings, "");
    expect(readExtraKnownMarketplacesFrom(settings, "userSettings")).toEqual([]);
  });

  it("parses extraKnownMarketplaces and tags declaredIn", () => {
    const settings = path.join(tmp, "settings.json");
    writeJson(settings, {
      extraKnownMarketplaces: {
        "my-org-mp": {
          source: { source: "github", repo: "my-org/marketplace" },
        },
      },
      // Other settings keys ignored.
      theme: "dark",
    });
    const result = readExtraKnownMarketplacesFrom(settings, "policySettings");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "my-org-mp",
      declaredIn: "policySettings",
      source: { kind: "github" },
    });
  });

  it("rejects unsafe marketplace names with a stderr warning", () => {
    const settings = path.join(tmp, "settings.json");
    writeJson(settings, {
      extraKnownMarketplaces: {
        "../escape": { source: { source: "github", repo: "evil/x" } },
        "..": { source: { source: "github", repo: "also-evil/x" } },
        "ok-name": { source: { source: "github", repo: "good/x" } },
      },
    });
    // Capture stderr writes.
    const writes: string[] = [];
    const orig = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      const result = readExtraKnownMarketplacesFrom(settings, "userSettings");
      expect(result.map((r) => r.name)).toEqual(["ok-name"]);
      expect(writes.join("")).toMatch(/unsafe name "..\/escape"/);
      expect(writes.join("")).toMatch(/unsafe name ".."/);
    } finally {
      process.stderr.write = orig;
    }
  });

  it("throws on malformed JSON", () => {
    const settings = path.join(tmp, "settings.json");
    fs.writeFileSync(settings, "{ not valid json");
    expect(() => readExtraKnownMarketplacesFrom(settings, "userSettings")).toThrow(
      /Malformed settings JSON/,
    );
  });
});

describe("enumerateDropIns", () => {
  it("returns [] when directory is absent", () => {
    expect(enumerateDropIns(path.join(tmp, "missing"))).toEqual([]);
  });

  it("returns sorted .json entries only", () => {
    const dir = path.join(tmp, "drop-in");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "10-zeta.json"), "{}");
    fs.writeFileSync(path.join(dir, "01-alpha.json"), "{}");
    fs.writeFileSync(path.join(dir, "05-beta.json"), "{}");
    fs.writeFileSync(path.join(dir, "README.md"), "ignored");
    fs.writeFileSync(path.join(dir, "backup.json.bak"), "ignored");

    const result = enumerateDropIns(dir);
    expect(result.map((p) => path.basename(p))).toEqual([
      "01-alpha.json",
      "05-beta.json",
      "10-zeta.json",
    ]);
  });
});

describe("resolveSettingsPaths", () => {
  it("throws on non-darwin platform", () => {
    expect(() => resolveSettingsPaths({ platform: "linux" })).toThrow(/macOS only/);
  });

  it("uses CLAUDE_CONFIG_DIR for userSettings when set", () => {
    const customConfig = path.join(tmp, "custom-config");
    const paths = resolveSettingsPaths({
      platform: "darwin",
      home: tmp,
      env: { CLAUDE_CONFIG_DIR: customConfig },
      cwd: tmp,
    });
    expect(paths.userSettings).toBe(path.join(customConfig, "settings.json"));
  });

  it("uses CLAUDE_MANAGED_SETTINGS_DIR for policySettings when set (hermetic)", () => {
    const customPolicy = path.join(tmp, "custom-policy");
    const paths = resolveSettingsPaths({
      platform: "darwin",
      home: tmp,
      env: { CLAUDE_MANAGED_SETTINGS_DIR: customPolicy },
      cwd: tmp,
    });
    expect(paths.policySettingsBase).toBe(path.join(customPolicy, "managed-settings.json"));
    expect(paths.policySettingsDropInDir).toBe(path.join(customPolicy, "managed-settings.d"));
  });

  it("defaults to canonical macOS paths when env vars absent", () => {
    const paths = resolveSettingsPaths({
      platform: "darwin",
      home: tmp,
      env: {},
      cwd: tmp,
    });
    expect(paths.userSettings).toBe(path.join(tmp, ".claude", "settings.json"));
    expect(paths.projectSettings).toBe(path.join(tmp, ".claude", "settings.json"));
    expect(paths.localSettings).toBe(path.join(tmp, ".claude", "settings.local.json"));
    expect(paths.policySettingsBase).toBe(
      "/Library/Application Support/ClaudeCode/managed-settings.json",
    );
  });
});

describe("readCrossCuttingExtraKnownMarketplaces (orchestration)", () => {
  it("merges entries from all four cross-cutting sources with declaredIn tags", () => {
    const home = path.join(tmp, "home");
    const cwd = path.join(tmp, "project");
    const policy = path.join(tmp, "policy");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });

    writeJson(path.join(home, ".claude", "settings.json"), {
      extraKnownMarketplaces: {
        user: { source: { source: "github", repo: "u/u" } },
      },
    });
    writeJson(path.join(cwd, ".claude", "settings.json"), {
      extraKnownMarketplaces: {
        project: { source: { source: "github", repo: "p/p" } },
      },
    });
    writeJson(path.join(cwd, ".claude", "settings.local.json"), {
      extraKnownMarketplaces: {
        local: { source: { source: "github", repo: "l/l" } },
      },
    });
    writeJson(path.join(policy, "managed-settings.json"), {
      extraKnownMarketplaces: {
        policy: { source: { source: "github", repo: "po/po" } },
      },
    });
    // Drop-in adding another policy entry.
    writeJson(path.join(policy, "managed-settings.d", "10-extra.json"), {
      extraKnownMarketplaces: {
        "policy-dropin": { source: { source: "github", repo: "pd/pd" } },
      },
    });

    const result = readCrossCuttingExtraKnownMarketplaces({
      platform: "darwin",
      home,
      env: { CLAUDE_MANAGED_SETTINGS_DIR: policy },
      cwd,
    });

    const byName = new Map(result.map((r) => [r.name, r]));
    expect(byName.get("user")?.declaredIn).toBe("userSettings");
    expect(byName.get("project")?.declaredIn).toBe("projectSettings");
    expect(byName.get("local")?.declaredIn).toBe("localSettings");
    expect(byName.get("policy")?.declaredIn).toBe("policySettings");
    expect(byName.get("policy-dropin")?.declaredIn).toBe("policySettings");
    expect(result).toHaveLength(5);
  });

  it("returns [] silently on non-darwin (degrades, doesn't throw)", () => {
    const result = readCrossCuttingExtraKnownMarketplaces({
      platform: "linux",
      home: tmp,
      env: {},
      cwd: tmp,
    });
    expect(result).toEqual([]);
  });

  it("returns [] when no settings files exist", () => {
    const result = readCrossCuttingExtraKnownMarketplaces({
      platform: "darwin",
      home: tmp,
      env: { CLAUDE_MANAGED_SETTINGS_DIR: path.join(tmp, "absent-policy") },
      cwd: tmp,
    });
    expect(result).toEqual([]);
  });
});

describe("mergeMarketplaceDeclarations", () => {
  function knownEntry(name: string): KnownMarketplaceEntry {
    return {
      name,
      source: { kind: "github", raw: { source: "github", repo: `${name}/${name}` } },
      raw: { source: { source: "github", repo: `${name}/${name}` } },
    };
  }

  it("known-only entry: declaredIn=[known_marketplaces], hasClone=true", () => {
    const result = mergeMarketplaceDeclarations([knownEntry("a")], []);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "a",
      declaredIn: ["known_marketplaces"],
      hasClone: true,
    });
  });

  it("settings-only entry: declaredIn=[settingsSource], hasClone=false", () => {
    const result = mergeMarketplaceDeclarations(
      [],
      [
        {
          name: "user-only",
          source: { kind: "github", raw: { source: "github", repo: "u/u" } },
          declaredIn: "userSettings",
          raw: { source: { source: "github", repo: "u/u" } },
        },
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "user-only",
      declaredIn: ["userSettings"],
      hasClone: false,
    });
  });

  it("entry in both: declaredIn includes both, hasClone=true (known wins)", () => {
    const result = mergeMarketplaceDeclarations(
      [knownEntry("both")],
      [
        {
          name: "both",
          source: { kind: "github", raw: { source: "github", repo: "u/u" } },
          declaredIn: "userSettings",
          raw: {},
        },
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.hasClone).toBe(true);
    // declaredIn should include both sources.
    expect(result[0]?.declaredIn).toContain("known_marketplaces");
    expect(result[0]?.declaredIn).toContain("userSettings");
  });

  it("entry from multiple settings sources: declaredIn accumulates", () => {
    const result = mergeMarketplaceDeclarations(
      [],
      [
        {
          name: "multi",
          source: { kind: "github", raw: { source: "github", repo: "u/u" } },
          declaredIn: "userSettings",
          raw: {},
        },
        {
          name: "multi",
          source: { kind: "github", raw: { source: "github", repo: "u/u" } },
          declaredIn: "policySettings",
          raw: {},
        },
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.hasClone).toBe(false);
    expect(result[0]?.declaredIn).toEqual(
      expect.arrayContaining(["userSettings", "policySettings"]),
    );
  });

  it("dedupes same source listed twice (e.g. policy base + drop-in)", () => {
    const result = mergeMarketplaceDeclarations(
      [],
      [
        {
          name: "dup",
          source: { kind: "github", raw: {} },
          declaredIn: "policySettings",
          raw: {},
        },
        {
          name: "dup",
          source: { kind: "github", raw: {} },
          declaredIn: "policySettings",
          raw: {},
        },
      ],
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.declaredIn).toEqual(["policySettings"]);
  });
});
