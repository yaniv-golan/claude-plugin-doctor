import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseRpmManifest } from "../../src/rpm-manifest.js";

function writeJson(p: string, data: unknown) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
}

describe("parseRpmManifest", () => {
  it("returns absent state when file is missing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const r = parseRpmManifest(path.join(tmp, "manifest.json"));
    expect(r.present).toBe(false);
    expect(r.entries).toEqual([]);
  });

  it("parses entries with installedBy and updatedAt", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const file = path.join(tmp, "manifest.json");
    writeJson(file, {
      plugins: {
        plugin_xxx: { installedBy: "auto", updatedAt: "2026-04-29T00:00:00Z" },
        plugin_yyy: { installedBy: "user", updatedAt: "2026-04-15T00:00:00Z" },
      },
    });
    const r = parseRpmManifest(file);
    expect(r.present).toBe(true);
    expect(r.entries).toHaveLength(2);
    const xxx = r.entries.find((e) => e.pluginId === "plugin_xxx");
    expect(xxx?.installedBy).toBe("auto");
    expect(xxx?.updatedAt).toBe("2026-04-29T00:00:00Z");
  });

  it("treats unknown installedBy values as 'unknown'", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const file = path.join(tmp, "manifest.json");
    writeJson(file, { plugins: { p1: { installedBy: "weird", updatedAt: "x" } } });
    const r = parseRpmManifest(file);
    expect(r.entries[0]?.installedBy).toBe("unknown");
  });

  it("v0.5.1 — accepts array-of-entries shape (Cowork ≥ 1.x)", () => {
    // Real shape observed against Claude Desktop 1.5354.0 / Cowork mid-2026:
    // `plugins` is an array, each entry self-describes its id via `id` field.
    // Pre-fix: parser threw E_USAGE on this shape, breaking `cpd check
    // --mode cowork` for any user with RPM-managed plugins.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const file = path.join(tmp, "manifest.json");
    writeJson(file, {
      lastUpdated: 1234567890,
      plugins: [
        {
          id: "plugin_01TGPuaRGgPuRDwV92iZbk2g",
          name: "skill-creator-plus",
          updatedAt: "2026-04-02T09:40:59.503477Z",
          marketplaceId: "marketplace_01KPC3RF1SR6zzYinC1iqSrf",
          marketplaceName: "skill-creator-plus",
          installedBy: "user",
          installationPreference: "available",
        },
        {
          id: "plugin_01ABC",
          installedBy: "auto",
        },
      ],
    });
    const r = parseRpmManifest(file);
    expect(r.entries).toHaveLength(2);
    expect(r.entries[0]?.pluginId).toBe("plugin_01TGPuaRGgPuRDwV92iZbk2g");
    expect(r.entries[0]?.installedBy).toBe("user");
    expect(r.entries[0]?.updatedAt).toBe("2026-04-02T09:40:59.503477Z");
    expect(r.entries[1]?.pluginId).toBe("plugin_01ABC");
    expect(r.entries[1]?.installedBy).toBe("auto");
  });

  it("v0.5.1 — array-form entries without `id` are skipped (malformed defensive)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const file = path.join(tmp, "manifest.json");
    writeJson(file, {
      plugins: [
        { id: "plugin_01OK", installedBy: "user" },
        { name: "no-id-here" }, // no id → skipped
      ],
    });
    const r = parseRpmManifest(file);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]?.pluginId).toBe("plugin_01OK");
  });
});
