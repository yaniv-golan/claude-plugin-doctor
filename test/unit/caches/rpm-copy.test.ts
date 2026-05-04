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
