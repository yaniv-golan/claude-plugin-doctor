import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { checkRpmCopy, snapshotRpmCopy } from "../../../src/caches/rpm-copy.js";

describe("checkRpmCopy", () => {
  it("returns fresh when plugin dir exists", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    fs.mkdirSync(path.join(tmp, "plugin_xxx"), { recursive: true });
    const r = checkRpmCopy({
      rpmRoot: tmp,
      entry: {
        pluginId: "plugin_xxx",
        installedBy: "auto",
        updatedAt: "2026-04-29T00:00:00Z",
        raw: {},
      },
    });
    expect(r.status).toBe("fresh");
    expect(r.evidence.installedBy).toBe("auto");
  });

  it("returns missing when plugin dir absent", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const r = checkRpmCopy({
      rpmRoot: tmp,
      entry: {
        pluginId: "plugin_yyy",
        installedBy: "user",
        updatedAt: "2026-04-15T00:00:00Z",
        raw: {},
      },
    });
    expect(r.status).toBe("missing");
    expect(r.recommendation?.reason).toMatch(/dir/i);
  });

  // ── Phase 2: Layer 5 freshness via marketplace-clone version comparison ────

  function writeRpmPluginJson(dir: string, version: string): void {
    fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "proof-engine", version }),
    );
  }

  it("returns stale when RPM plugin.json#version is behind the marketplace clone", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const pluginDir = path.join(tmp, "plugin_xxx");
    writeRpmPluginJson(pluginDir, "1.41.0");
    const r = checkRpmCopy({
      rpmRoot: tmp,
      entry: {
        pluginId: "plugin_xxx",
        installedBy: "user",
        raw: { name: "proof-engine" },
      },
      marketplaceClone: { version: "1.42.0", clonePath: "/fake/clone" },
    });
    expect(r.status).toBe("stale");
    expect(r.detail).toContain("1.41.0");
    expect(r.detail).toContain("1.42.0");
    expect(r.recommendation?.risk).toBe("safe");
    expect(r.evidence.rpmVersion).toBe("1.41.0");
    expect(r.evidence.cloneVersion).toBe("1.42.0");
  });

  it("returns fresh when RPM plugin.json#version equals the marketplace clone", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const pluginDir = path.join(tmp, "plugin_xxx");
    writeRpmPluginJson(pluginDir, "1.42.0");
    const r = checkRpmCopy({
      rpmRoot: tmp,
      entry: { pluginId: "plugin_xxx", installedBy: "user", raw: {} },
      marketplaceClone: { version: "1.42.0" },
    });
    expect(r.status).toBe("fresh");
    expect(r.detail).toMatch(/matches/);
    expect(r.recommendation).toBeUndefined();
  });

  it("returns fresh (ahead-of-marketplace) when RPM > clone", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const pluginDir = path.join(tmp, "plugin_xxx");
    writeRpmPluginJson(pluginDir, "1.43.0");
    const r = checkRpmCopy({
      rpmRoot: tmp,
      entry: { pluginId: "plugin_xxx", installedBy: "user", raw: {} },
      marketplaceClone: { version: "1.42.0" },
    });
    expect(r.status).toBe("fresh");
    expect(r.detail).toMatch(/ahead/i);
  });

  it("uses numeric collation so 1.10.0 > 1.9.0", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const pluginDir = path.join(tmp, "plugin_xxx");
    writeRpmPluginJson(pluginDir, "1.9.0");
    const r = checkRpmCopy({
      rpmRoot: tmp,
      entry: { pluginId: "plugin_xxx", installedBy: "user", raw: {} },
      marketplaceClone: { version: "1.10.0" },
    });
    expect(r.status).toBe("stale");
  });

  it("returns unknowable when marketplace clone lookup failed", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const pluginDir = path.join(tmp, "plugin_xxx");
    writeRpmPluginJson(pluginDir, "1.41.0");
    const r = checkRpmCopy({
      rpmRoot: tmp,
      entry: { pluginId: "plugin_xxx", installedBy: "user", raw: {} },
      marketplaceClone: {
        lookupFailure: "marketplace-clone-unavailable",
        clonePath: "/fake/missing",
      },
    });
    expect(r.status).toBe("unknowable");
    expect(r.evidence.skipReason).toBe("marketplace-clone-unavailable");
    expect(r.evidence.rpmVersion).toBe("1.41.0");
  });

  it("returns unknowable when RPM plugin.json is missing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    // Create plugin dir but no .claude-plugin/plugin.json
    fs.mkdirSync(path.join(tmp, "plugin_xxx"), { recursive: true });
    const r = checkRpmCopy({
      rpmRoot: tmp,
      entry: { pluginId: "plugin_xxx", installedBy: "user", raw: {} },
      marketplaceClone: { version: "1.42.0" },
    });
    expect(r.status).toBe("unknowable");
    expect(r.evidence.skipReason).toBe("rpm-plugin-json-missing");
  });

  it("falls back to legacy dir-existence verdict when marketplaceClone is omitted", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    fs.mkdirSync(path.join(tmp, "plugin_xxx"), { recursive: true });
    const r = checkRpmCopy({
      rpmRoot: tmp,
      entry: { pluginId: "plugin_xxx", installedBy: "user", raw: {} },
    });
    expect(r.status).toBe("fresh");
  });
});

// ── v1.0 snapshotRpmCopy ──────────────────────────────────────────────────────

describe("snapshotRpmCopy", () => {
  it("presence:present when plugin dir exists", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    fs.mkdirSync(path.join(tmp, "plugin_xxx"), { recursive: true });
    const snap = snapshotRpmCopy({
      rpmRoot: tmp,
      entry: {
        pluginId: "plugin_xxx",
        installedBy: "auto",
        updatedAt: "2026-04-29T00:00:00Z",
        raw: {},
      },
      cowork: { accountId: "acc", orgId: "org" },
    });
    expect(snap.layer).toBe("rpm_copy");
    expect(snap.presence).toBe("present");
    expect(snap.data.kind).toBe("rpm_copy");
    expect(snap.data.pluginId).toBe("plugin_xxx");
    expect(snap.data.pluginDirExists).toBe(true);
    expect(snap.data.manifestEntry?.installedBy).toBe("auto");
    expect(snap.subject).toMatchObject({ kind: "rpm-plugin", pluginId: "plugin_xxx" });
  });

  it("presence:absent when plugin dir does not exist", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const snap = snapshotRpmCopy({
      rpmRoot: tmp,
      entry: { pluginId: "plugin_yyy", installedBy: "user", raw: {} },
      cowork: { accountId: "acc", orgId: "org" },
    });
    expect(snap.presence).toBe("absent");
    expect(snap.data.pluginDirExists).toBe(false);
  });

  it("records optional marketplaceId and marketplaceName when provided", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    fs.mkdirSync(path.join(tmp, "plugin_zzz"), { recursive: true });
    const snap = snapshotRpmCopy({
      rpmRoot: tmp,
      entry: { pluginId: "plugin_zzz", installedBy: "auto", raw: {} },
      cowork: { accountId: "acc", orgId: "org" },
      marketplaceId: "mp_id_123",
      marketplaceName: "my-marketplace",
    });
    expect(snap.data.marketplaceId).toBe("mp_id_123");
    expect(snap.data.marketplaceName).toBe("my-marketplace");
  });

  it("emits versionDelta when both versions resolve", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const pluginDir = path.join(tmp, "plugin_xxx");
    fs.mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ version: "1.41.0" }),
    );
    const snap = snapshotRpmCopy({
      rpmRoot: tmp,
      entry: { pluginId: "plugin_xxx", installedBy: "user", raw: {} },
      cowork: { accountId: "acc", orgId: "org" },
      marketplaceClone: { version: "1.42.0", clonePath: "/fake/clone" },
    });
    expect(snap.data.versionDelta).toEqual({
      rpm: "1.41.0",
      clone: "1.42.0",
      comparison: -1,
    });
    expect(snap.data.versionDeltaSkipReason).toBeUndefined();
  });

  it("records versionDeltaSkipReason when clone version is unavailable", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const pluginDir = path.join(tmp, "plugin_xxx");
    fs.mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ version: "1.41.0" }),
    );
    const snap = snapshotRpmCopy({
      rpmRoot: tmp,
      entry: { pluginId: "plugin_xxx", installedBy: "user", raw: {} },
      cowork: { accountId: "acc", orgId: "org" },
      marketplaceClone: { lookupFailure: "marketplace-clone-unavailable" },
    });
    expect(snap.data.versionDelta).toBeUndefined();
    expect(snap.data.versionDeltaSkipReason).toBe("marketplace-clone-unavailable");
  });

  it("rootRef is cowork with correct accountId/orgId", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const snap = snapshotRpmCopy({
      rpmRoot: tmp,
      entry: { pluginId: "plugin_xxx", installedBy: "auto", raw: {} },
      cowork: { accountId: "myacc", orgId: "myorg" },
    });
    expect(snap.rootRef).toMatchObject({ kind: "cowork", accountId: "myacc", orgId: "myorg" });
    expect(snap.data.cowork.accountId).toBe("myacc");
    expect(snap.data.cowork.orgId).toBe("myorg");
  });
});
