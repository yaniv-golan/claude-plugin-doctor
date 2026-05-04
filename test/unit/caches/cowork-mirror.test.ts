import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { checkCoworkMirror, snapshotCoworkMirror } from "../../../src/caches/cowork-mirror.js";

function writeJson(p: string, data: unknown) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
}

describe("checkCoworkMirror", () => {
  it("skipped when mode is ccd", () => {
    const r = checkCoworkMirror({
      mode: "ccd",
      pluginId: "p@mp",
      pluginName: "p",
      marketplace: "mp",
      activeRoot: undefined,
      otherRoots: [],
    });
    expect(r.status).toBe("skipped");
    //   plain-language copy: "Active mode is CCD..." → "Plugin is installed in
    // Claude Code Desktop, not in a Claude Desktop session..."
    expect(r.detail).toMatch(/Claude Code Desktop|no session mirror/);
  });

  it("fresh when only one cowork root present", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const root = path.join(tmp, "acc", "org");
    writeJson(path.join(root, "cowork_plugins", "installed_plugins.json"), {
      version: 2,
      plugins: {
        "p@mp": [
          {
            version: "1.0.0",
            installPath: path.join(root, "cowork_plugins", "cache", "mp", "p", "1.0.0"),
          },
        ],
      },
    });
    const r = checkCoworkMirror({
      mode: "cowork",
      pluginId: "p@mp",
      pluginName: "p",
      marketplace: "mp",
      activeRoot: { path: root, accountId: "acc", orgId: "org" },
      otherRoots: [],
    });
    expect(r.status).toBe("fresh");
  });

  it("stale when versions disagree across roots", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const root1 = path.join(tmp, "acc", "org1");
    const root2 = path.join(tmp, "acc", "org2");
    writeJson(path.join(root1, "cowork_plugins", "installed_plugins.json"), {
      version: 2,
      plugins: { "p@mp": [{ version: "1.0.0", installPath: "/x" }] },
    });
    writeJson(path.join(root2, "cowork_plugins", "installed_plugins.json"), {
      version: 2,
      plugins: { "p@mp": [{ version: "0.9.0", installPath: "/y" }] },
    });
    const r = checkCoworkMirror({
      mode: "cowork",
      pluginId: "p@mp",
      pluginName: "p",
      marketplace: "mp",
      activeRoot: { path: root1, accountId: "acc", orgId: "org1" },
      otherRoots: [{ path: root2, accountId: "acc", orgId: "org2" }],
    });
    expect(r.status).toBe("stale");
    expect(r.detail).toMatch(/acc\/org2/);
  });

  it("fresh when other roots don't have the plugin at all", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const root1 = path.join(tmp, "acc", "org1");
    const root2 = path.join(tmp, "acc", "org2");
    writeJson(path.join(root1, "cowork_plugins", "installed_plugins.json"), {
      version: 2,
      plugins: { "p@mp": [{ version: "1.0.0", installPath: "/x" }] },
    });
    writeJson(path.join(root2, "cowork_plugins", "installed_plugins.json"), {
      version: 2,
      plugins: {},
    });
    const r = checkCoworkMirror({
      mode: "cowork",
      pluginId: "p@mp",
      pluginName: "p",
      marketplace: "mp",
      activeRoot: { path: root1, accountId: "acc", orgId: "org1" },
      otherRoots: [{ path: root2, accountId: "acc", orgId: "org2" }],
    });
    expect(r.status).toBe("fresh");
  });
});

// ── v1.0 snapshotCoworkMirror ─────────────────────────────────────────────────

describe("snapshotCoworkMirror", () => {
  it("presence:present when plugin found in cowork installed_plugins.json", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const rootPath = path.join(tmp, "acc", "org1");
    writeJson(path.join(rootPath, "cowork_plugins", "installed_plugins.json"), {
      version: 2,
      plugins: { "p@mp": [{ version: "1.0.0", installPath: "/x", scope: "user" }] },
    });
    const snap = snapshotCoworkMirror({
      cowork: { accountId: "acc", orgId: "org1", rootPath },
      pluginId: "p@mp",
    });
    expect(snap.layer).toBe("cowork_mirror");
    expect(snap.presence).toBe("present");
    expect(snap.data.kind).toBe("cowork_mirror");
    expect(snap.data.cowork.accountId).toBe("acc");
    expect(snap.data.cowork.orgId).toBe("org1");
    expect(snap.data.installedHere).toBeDefined();
    expect(snap.data.installedHere?.version).toBe("1.0.0");
  });

  it("presence:absent when plugin not in cowork installed_plugins.json", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const rootPath = path.join(tmp, "acc", "org1");
    writeJson(path.join(rootPath, "cowork_plugins", "installed_plugins.json"), {
      version: 2,
      plugins: {},
    });
    const snap = snapshotCoworkMirror({
      cowork: { accountId: "acc", orgId: "org1", rootPath },
      pluginId: "p@mp",
    });
    expect(snap.presence).toBe("absent");
    expect(snap.data.installedHere).toBeUndefined();
  });

  it("carries marketplaceCloneHead when provided", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const rootPath = path.join(tmp, "acc", "org1");
    writeJson(path.join(rootPath, "cowork_plugins", "installed_plugins.json"), {
      version: 2,
      plugins: {},
    });
    const sha = "abc1234abc1234abc1234abc1234abc1234abc12";
    const snap = snapshotCoworkMirror({
      cowork: { accountId: "acc", orgId: "org1", rootPath },
      pluginId: "p@mp",
      marketplaceCloneHead: sha,
    });
    expect(snap.data.marketplaceCloneHead).toBe(sha);
  });

  it("rootRef is cowork with correct accountId/orgId", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const rootPath = path.join(tmp, "acc", "org1");
    writeJson(path.join(rootPath, "cowork_plugins", "installed_plugins.json"), {
      version: 2,
      plugins: {},
    });
    const snap = snapshotCoworkMirror({
      cowork: { accountId: "acc", orgId: "org1", rootPath },
      pluginId: "p@mp",
    });
    expect(snap.rootRef).toMatchObject({ kind: "cowork", accountId: "acc", orgId: "org1" });
  });
});
