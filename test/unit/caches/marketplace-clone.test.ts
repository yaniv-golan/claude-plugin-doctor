import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  checkMarketplaceClone,
  snapshotMarketplaceClone,
} from "../../../src/caches/marketplace-clone.js";

function writeJson(p: string, data: unknown) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
}

function gitInitWithCommit(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  execSync("git init -q && git commit -q --allow-empty -m init", {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  return execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
}

describe("checkMarketplaceClone", () => {
  it("returns missing when clone dir absent", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const result = await checkMarketplaceClone({
      pluginsRoot: tmp,
      marketplace: { name: "mp1", source: { source: "github", repo: "x/y" }, raw: {} },
      noNetwork: true,
    });
    expect(result.status).toBe("missing");
    expect(result.detail).toMatch(/clone missing/i);
  });

  it("returns unknowable for github clone with --no-network", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp1");
    const sha = gitInitWithCommit(cloneDir);
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), { plugins: [] });
    const result = await checkMarketplaceClone({
      pluginsRoot: tmp,
      marketplace: { name: "mp1", source: { source: "github", repo: "x/y" }, raw: {} },
      noNetwork: true,
    });
    expect(result.status).toBe("unknowable");
    expect(result.evidence.headLocal).toBe(sha);
    expect(result.detail).toMatch(/--no-network/);
  });

  it("returns missing when marketplace.json absent inside clone", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp1");
    gitInitWithCommit(cloneDir);
    const result = await checkMarketplaceClone({
      pluginsRoot: tmp,
      marketplace: { name: "mp1", source: { source: "github", repo: "x/y" }, raw: {} },
      noNetwork: true,
    });
    expect(result.status).toBe("missing");
    expect(result.detail).toMatch(/marketplace\.json/);
  });

  it("for directory source, returns fresh if path exists", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const dirPath = path.join(tmp, "local-mp");
    fs.mkdirSync(dirPath, { recursive: true });
    writeJson(path.join(dirPath, ".claude-plugin", "marketplace.json"), { plugins: [] });
    const cloneDir = path.join(tmp, "marketplaces", "local-mp");
    fs.mkdirSync(cloneDir, { recursive: true });
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), { plugins: [] });
    const result = await checkMarketplaceClone({
      pluginsRoot: tmp,
      marketplace: {
        name: "local-mp",
        source: { source: "directory", path: dirPath },
        raw: {},
      },
      noNetwork: true,
    });
    expect(result.status).toBe("fresh");
  });

  it("`marketplace-update-broken`: lastUpdated recent + clone behind remote", async () => {
    // Simulates Anthropic issue #46081: user ran `claude plugin marketplace
    // update <mp>` recently (lastUpdated bumped) but the clone HEAD didn't
    // actually advance. cpd should detect this and recommend the
    // `git fetch && git reset --hard` bypass instead of repeating the
    // broken `claude plugin marketplace update` cmd.
    vi.resetModules();
    vi.doMock("../../../src/git.js", () => ({
      isGitRepo: () => true,
      gitRevParseHead: () => "aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1",
      gitLsRemote: async () => ({
        ok: true,
        defaultBranchSha: "bbbbbbb1bbbbbbb1bbbbbbb1bbbbbbb1bbbbbbb1",
      }),
    }));
    const { checkMarketplaceClone: check } = await import(
      "../../../src/caches/marketplace-clone.js"
    );
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp1");
    fs.mkdirSync(cloneDir, { recursive: true });
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), { plugins: [] });
    // lastUpdated 2 days ago — well within the 7-day "recent" window.
    const lastUpdated = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const result = await check({
      pluginsRoot: tmp,
      marketplace: {
        name: "mp1",
        source: { source: "github", repo: "x/y" },
        raw: { lastUpdated },
      },
      noNetwork: false,
    });
    expect(result.status).toBe("stale");
    expect(result.evidence.versionTrapKind).toBe("marketplace-update-broken");
    expect(result.detail).toMatch(/Marketplace update is broken/);
    expect(result.detail).toMatch(/2d ago/);
    expect(result.recommendation?.cmd).toMatch(/git fetch origin/);
    expect(result.recommendation?.cmd).toMatch(/git reset --hard/);
    expect(result.recommendation?.risk).toBe("destructive");
    vi.doUnmock("../../../src/git.js");
  });

  it("does NOT flag marketplace-update-broken when lastUpdated is old (>7d)", async () => {
    vi.resetModules();
    vi.doMock("../../../src/git.js", () => ({
      isGitRepo: () => true,
      gitRevParseHead: () => "aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1",
      gitLsRemote: async () => ({
        ok: true,
        defaultBranchSha: "bbbbbbb1bbbbbbb1bbbbbbb1bbbbbbb1bbbbbbb1",
      }),
    }));
    const { checkMarketplaceClone: check } = await import(
      "../../../src/caches/marketplace-clone.js"
    );
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp1");
    fs.mkdirSync(cloneDir, { recursive: true });
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), { plugins: [] });
    // lastUpdated 14 days ago — outside the 7-day window.
    const lastUpdated = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const result = await check({
      pluginsRoot: tmp,
      marketplace: {
        name: "mp1",
        source: { source: "github", repo: "x/y" },
        raw: { lastUpdated },
      },
      noNetwork: false,
    });
    expect(result.status).toBe("stale");
    expect(result.evidence.versionTrapKind).toBeUndefined();
    expect(result.detail).not.toMatch(/Marketplace update is broken/);
    // Falls back to the standard refresh recommendation. Marketplace name is
    // shell-quoted so a hostile name with metacharacters can't turn the
    // copyable cmd into an injection vector (audit issue #11).
    expect(result.recommendation?.cmd).toBe("claude plugin marketplace update 'mp1'");
    vi.doUnmock("../../../src/git.js");
  });

  it("for remote source with no local lastSyncedSha, emits unknowable", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "remote-mp");
    fs.mkdirSync(cloneDir, { recursive: true });
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), { plugins: [] });
    const result = await checkMarketplaceClone({
      pluginsRoot: tmp,
      marketplace: { name: "remote-mp", source: { source: "remote" }, raw: {} },
      noNetwork: true,
    });
    expect(result.status).toBe("unknowable");
    //   copy: jargon "lastSyncedSha" replaced with plain language about
    // remote-source marketplaces having no local fingerprinting.
    expect(result.detail).toMatch(/Remote-source marketplace|local fingerprinting/i);
  });
});

// ── v1.0 snapshotMarketplaceClone ─────────────────────────────────────────────

describe("snapshotMarketplaceClone", () => {
  it("presence:absent when clone dir does not exist", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const snap = snapshotMarketplaceClone({
      pluginsRoot: tmp,
      marketplace: { name: "mp1", source: { source: "github", repo: "x/y" }, raw: {} },
      rootRef: { kind: "ccd" },
    });
    expect(snap.layer).toBe("marketplace_clone");
    expect(snap.presence).toBe("absent");
    expect(snap.data.kind).toBe("marketplace_clone");
    expect(snap.data.marketplace).toBe("mp1");
    expect(snap.data.marketplaceJsonExists).toBe(false);
    expect(snap.data.parsedMarketplace).toBeUndefined();
    expect(snap.subject).toMatchObject({ kind: "marketplace" });
  });

  it("presence:present when clone + marketplace.json exist", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp1");
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), {
      plugins: [{ name: "myplugin", version: "1.0.0", source: "./myplugin" }],
    });
    const snap = snapshotMarketplaceClone({
      pluginsRoot: tmp,
      marketplace: { name: "mp1", source: { source: "directory", path: cloneDir }, raw: {} },
      rootRef: { kind: "ccd" },
    });
    expect(snap.presence).toBe("present");
    expect(snap.data.marketplaceJsonExists).toBe(true);
    expect(snap.data.parsedMarketplace?.plugins).toHaveLength(1);
    expect(snap.data.parsedMarketplace?.plugins[0]?.name).toBe("myplugin");
  });

  it("records lastUpdatedAtMs when provided", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp1");
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), { plugins: [] });
    const lastUpdatedAtMs = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const snap = snapshotMarketplaceClone({
      pluginsRoot: tmp,
      marketplace: { name: "mp1", source: { source: "directory", path: cloneDir }, raw: {} },
      rootRef: { kind: "ccd" },
      lastUpdatedAtMs,
    });
    expect(snap.data.lastUpdatedAtMs).toBe(lastUpdatedAtMs);
  });

  it("rootRef is set correctly for cowork root", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const snap = snapshotMarketplaceClone({
      pluginsRoot: tmp,
      marketplace: { name: "mp1", source: { source: "github", repo: "x/y" }, raw: {} },
      rootRef: { kind: "cowork", accountId: "acc1", orgId: "org1" },
    });
    expect(snap.rootRef).toMatchObject({ kind: "cowork", accountId: "acc1", orgId: "org1" });
  });

  it("evidencePaths includes cloneRoot and marketplaceJsonPath when both exist", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp1");
    const marketplaceJsonPath = path.join(cloneDir, ".claude-plugin", "marketplace.json");
    writeJson(marketplaceJsonPath, { plugins: [] });
    const snap = snapshotMarketplaceClone({
      pluginsRoot: tmp,
      marketplace: { name: "mp1", source: { source: "directory", path: cloneDir }, raw: {} },
      rootRef: { kind: "ccd" },
    });
    expect(snap.evidencePaths).toContain(cloneDir);
    expect(snap.evidencePaths).toContain(marketplaceJsonPath);
  });
});
