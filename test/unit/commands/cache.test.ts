import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runCacheOrphans, runCachePrune } from "../../../src/commands/cache.js";
import type { SessionLocalDir } from "../../../src/types.js";

// ── runCachePrune ──────────────────────────────────────────────────────────

describe("runCachePrune", () => {
  function makeDir(overrides: Partial<SessionLocalDir> = {}): SessionLocalDir {
    return {
      kind: "session-local",
      pathOnDisk: "/fake/dir",
      parentRoot: "/fake",
      lastModified: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days ago
      approxSizeBytes: 1024,
      ...overrides,
    };
  }

  it("skips dirs modified within 30 minutes (active-session heuristic)", () => {
    const recent = makeDir({ lastModified: Date.now() - 5 * 60 * 1000 }); // 5 min ago
    const report = runCachePrune({
      olderThanDays: 14,
      force: false,
      dryRun: true,
      yes: false,
      sessionLocals: [recent],
    });
    expect(report.candidates).toHaveLength(0);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]?.skipReason).toMatch(/active-session/);
  });

  it("skips dirs newer than olderThan threshold", () => {
    const newer = makeDir({ lastModified: Date.now() - 5 * 24 * 60 * 60 * 1000 }); // 5 days ago
    const report = runCachePrune({
      olderThanDays: 14,
      force: false,
      dryRun: true,
      yes: false,
      sessionLocals: [newer],
    });
    expect(report.candidates).toHaveLength(0);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]?.skipReason).toMatch(/newer-than/);
  });

  it("includes eligible dirs as candidates in dry-run mode", () => {
    const old = makeDir({ lastModified: Date.now() - 30 * 24 * 60 * 60 * 1000 });
    const report = runCachePrune({
      olderThanDays: 14,
      force: false,
      dryRun: true,
      yes: false,
      sessionLocals: [old],
    });
    expect(report.candidates).toHaveLength(1);
    expect(report.deleted).toHaveLength(0);
    expect(report.dryRun).toBe(true);
    expect(report.totalReclaimableBytes).toBe(1024);
  });

  it("does not delete without --yes even when dryRun is false", () => {
    const old = makeDir({ lastModified: Date.now() - 30 * 24 * 60 * 60 * 1000 });
    const report = runCachePrune({
      olderThanDays: 14,
      force: false,
      dryRun: false,
      yes: false, // no --yes → no deletion
      sessionLocals: [old],
    });
    expect(report.candidates).toHaveLength(1);
    expect(report.deleted).toHaveLength(0);
    expect(report.dryRun).toBe(true); // effective dry-run because yes=false
  });

  it("deletes dirs when --yes and !dryRun", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cache-test-"));
    const sessionDir = path.join(tmpDir, `local_${crypto.randomUUID()}`);
    fs.mkdirSync(sessionDir);
    // Set mtime to 30 days ago
    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(sessionDir, oldTime, oldTime);

    const dir: SessionLocalDir = {
      kind: "session-local",
      pathOnDisk: sessionDir,
      parentRoot: tmpDir,
      lastModified: oldTime.getTime(),
      approxSizeBytes: 64,
    };

    const report = runCachePrune({
      olderThanDays: 14,
      force: false,
      dryRun: false,
      yes: true,
      sessionLocals: [dir],
    });

    expect(report.deleted).toHaveLength(1);
    expect(report.dryRun).toBe(false);
    expect(fs.existsSync(sessionDir)).toBe(false);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips dirs with lockfile unless --force", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cache-test-"));
    const sessionDir = path.join(tmpDir, `local_${crypto.randomUUID()}`);
    fs.mkdirSync(sessionDir);
    fs.writeFileSync(path.join(sessionDir, "LOCK"), "");
    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(sessionDir, oldTime, oldTime);

    const dir: SessionLocalDir = {
      kind: "session-local",
      pathOnDisk: sessionDir,
      parentRoot: tmpDir,
      lastModified: oldTime.getTime(),
      approxSizeBytes: 64,
    };

    const withoutForce = runCachePrune({
      olderThanDays: 14,
      force: false,
      dryRun: true,
      yes: false,
      sessionLocals: [dir],
    });
    expect(withoutForce.candidates).toHaveLength(0);
    expect(withoutForce.skipped[0]?.skipReason).toMatch(/lockfile/);

    const withForce = runCachePrune({
      olderThanDays: 14,
      force: true,
      dryRun: true,
      yes: false,
      sessionLocals: [dir],
    });
    expect(withForce.candidates).toHaveLength(1);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns exitCode 0", () => {
    const report = runCachePrune({
      olderThanDays: 14,
      force: false,
      dryRun: true,
      yes: false,
      sessionLocals: [],
    });
    expect(report.exitCode).toBe(0);
  });
});

// ── runCacheOrphans ────────────────────────────────────────────────────────

describe("runCacheOrphans", () => {
  it("returns empty orphans when cache dir does not exist", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-orphan-"));
    // Write a minimal installed_plugins.json
    fs.writeFileSync(
      path.join(tmp, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: {} }),
    );
    const report = runCacheOrphans({ pluginsRoot: tmp });
    expect(report.orphans).toHaveLength(0);
    expect(report.exitCode).toBe(0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("identifies orphan version dirs not in installed_plugins.json", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-orphan-"));
    const installPath = path.join(tmp, "cache", "acme", "plugin", "1.0.0");
    fs.mkdirSync(installPath, { recursive: true });
    // installed_plugins.json references a different version
    const otherPath = path.join(tmp, "cache", "acme", "plugin", "0.9.0");
    fs.writeFileSync(
      path.join(tmp, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "plugin@acme": [{ version: "0.9.0", installPath: otherPath }] },
      }),
    );
    const report = runCacheOrphans({ pluginsRoot: tmp });
    expect(report.orphans).toHaveLength(1);
    expect(report.orphans[0]?.version).toBe("1.0.0");
    expect(report.exitCode).toBe(0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("does not flag referenced install paths as orphans", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-orphan-"));
    const installPath = path.join(tmp, "cache", "acme", "plugin", "1.0.0");
    fs.mkdirSync(installPath, { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "plugin@acme": [{ version: "1.0.0", installPath }] },
      }),
    );
    const report = runCacheOrphans({ pluginsRoot: tmp });
    expect(report.orphans).toHaveLength(0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("classifies temp_subdir_* dirs as stray staging dirs, not plugin orphans", () => {
    // Regression: the orphan walker used to treat any 3-deep dir under
    // cache/ as a plugin install, including temp_subdir_X/.git/hooks etc.
    // This produced bogus "orphan" entries with nonsense ids
    // (temp_subdir_X/.git@hooks) and inflated counts.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-orphan-"));
    fs.mkdirSync(path.join(tmp, "cache", "temp_subdir_1234_abc.clone", ".git", "hooks"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tmp, "cache", "temp_subdir_1234_abc.clone", ".git", "objects"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmp, "cache", "temp_subdir_1234_abc.clone", ".git", "objects", "pack.bin"),
      "x".repeat(1024),
    );
    fs.writeFileSync(
      path.join(tmp, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: {} }),
    );

    const report = runCacheOrphans({ pluginsRoot: tmp });
    expect(report.orphans).toHaveLength(0);
    expect(report.strayDirs).toHaveLength(1);
    expect(report.strayDirs[0]?.reason).toBe("temp-staging-dir");
    expect(report.strayDirs[0]?.strayPath).toContain("temp_subdir_1234_abc.clone");
    // Recursive size walk should pick up the 1024-byte pack file inside .git/objects.
    expect(report.strayDirs[0]?.approxSizeBytes).toBeGreaterThanOrEqual(1024);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("classifies cache subtrees for unknown marketplaces as stray dirs", () => {
    // When a marketplace is removed via `claude plugin marketplace remove`,
    // the upstream CLI does NOT clean up the cache/<mp>/ subtree. Those
    // dangling subtrees should be flagged as stray (unknown-marketplace),
    // not as plugin install orphans.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-orphan-"));
    fs.mkdirSync(path.join(tmp, "cache", "removed-mp", "old-plugin", "1.0.0"), {
      recursive: true,
    });
    // known_marketplaces.json knows ONLY about "still-here", not "removed-mp".
    fs.writeFileSync(
      path.join(tmp, "known_marketplaces.json"),
      JSON.stringify({ "still-here": { source: { source: "github", repo: "owner/repo" } } }),
    );
    fs.writeFileSync(
      path.join(tmp, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: {} }),
    );

    const report = runCacheOrphans({ pluginsRoot: tmp });
    expect(report.orphans).toHaveLength(0);
    expect(report.strayDirs).toHaveLength(1);
    expect(report.strayDirs[0]?.reason).toBe("unknown-marketplace");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("recursive size walk: correct byte total for nested orphan dirs", () => {
    // Regression: dirSizeBytes used to call fs.statSync(dir).size, which
    // returns the inode/dir-entry size (a few hundred bytes), NOT the
    // cumulative content size. A 100 MB orphan was reported as "224 B".
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-orphan-"));
    const orphanDir = path.join(tmp, "cache", "acme", "plugin", "1.0.0");
    fs.mkdirSync(path.join(orphanDir, "node_modules", "deep"), { recursive: true });
    fs.writeFileSync(path.join(orphanDir, "a.txt"), "a".repeat(2048));
    fs.writeFileSync(path.join(orphanDir, "node_modules", "b.txt"), "b".repeat(4096));
    fs.writeFileSync(path.join(orphanDir, "node_modules", "deep", "c.txt"), "c".repeat(8192));
    fs.writeFileSync(
      path.join(tmp, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: {} }),
    );

    const report = runCacheOrphans({ pluginsRoot: tmp });
    expect(report.orphans).toHaveLength(1);
    // 2048 + 4096 + 8192 = 14336 bytes minimum (plus dirent overhead which
    // we don't count). The buggy version returned ~224 B.
    expect(report.orphans[0]?.approxSizeBytes).toBeGreaterThanOrEqual(14336);
    expect(report.totalOrphanBytes).toBeGreaterThanOrEqual(14336);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
