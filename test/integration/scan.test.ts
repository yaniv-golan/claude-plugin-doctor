import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runScan } from "../../src/commands/scan.js";

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

describe("runScan integration (CCD)", () => {
  it("detects resolver-disagreement when installed version differs from marketplace version", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-home-"));
    const plugins = path.join(home, ".claude", "plugins");
    fs.mkdirSync(plugins, { recursive: true });
    writeJson(path.join(plugins, "known_marketplaces.json"), {
      acme: { source: { source: "github", repo: "acme/marketplace" } },
    });
    const cloneDir = path.join(plugins, "marketplaces", "acme");
    gitInitWithCommit(cloneDir);
    // Marketplace claims version 0.4.0; install snapshot has 0.3.1 →
    // resolver-disagreement (cli resolves 0.4.0, sessionStart resolves 0.3.1).
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), {
      plugins: [
        {
          name: "proof-engine",
          version: "0.4.0",
          source: { source: "github", repo: "acme/proof-engine" },
        },
      ],
    });
    const installPath = path.join(plugins, "cache", "acme", "proof-engine", "0.3.1");
    fs.mkdirSync(installPath, { recursive: true });
    writeJson(path.join(plugins, "installed_plugins.json"), {
      version: 2,
      plugins: { "proof-engine@acme": [{ version: "0.3.1", installPath }] },
    });
    const report = await runScan({
      home,
      platform: "darwin",
      env: {},
      mode: "auto",
      noNetwork: true,
    });
    expect(report.schemaVersion).toBe("1.0");
    // v1.0: topology.ccd exists (not cowork-only)
    expect(report.topology.ccd).toBeDefined();
    // Plugin cache entry is present
    expect(Object.keys(report.caches)).toContain("proof-engine@acme#ccd");
    // A resolver disagreement drift is detected (cli=0.4.0 vs sessionStart=0.3.1)
    expect(report.drifts.some((d) => d.kind === "resolver-disagreement")).toBe(true);
  });

  it("returns exit code 0 when the fixture is fully fresh", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-home-"));
    const plugins = path.join(home, ".claude", "plugins");
    fs.mkdirSync(plugins, { recursive: true });
    writeJson(path.join(plugins, "known_marketplaces.json"), {
      acme: { source: { source: "github", repo: "acme/repo" } },
    });
    const cloneDir = path.join(plugins, "marketplaces", "acme");
    gitInitWithCommit(cloneDir);
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), {
      plugins: [{ name: "p", version: "1.0.0", source: { source: "github", repo: "acme/p" } }],
    });
    const installPath = path.join(plugins, "cache", "acme", "p", "1.0.0");
    fs.mkdirSync(installPath, { recursive: true });
    writeJson(path.join(plugins, "installed_plugins.json"), {
      version: 2,
      plugins: { "p@acme": [{ version: "1.0.0", installPath }] },
    });
    const report = await runScan({
      home,
      platform: "darwin",
      env: {},
      mode: "auto",
      noNetwork: true,
    });
    expect(report.schemaVersion).toBe("1.0");
    // When installed version matches marketplace version, no actionable drift →
    // exit code 0 (resolver-disagreement and runtime-boundary are informational).
    expect(report.exitCode).toBe(0);
  });

  it("detects cowork roots when cowork root is present", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-home-"));
    const plugins = path.join(home, ".claude", "plugins");
    fs.mkdirSync(plugins, { recursive: true });
    writeJson(path.join(plugins, "known_marketplaces.json"), {});
    writeJson(path.join(plugins, "installed_plugins.json"), { version: 2, plugins: {} });
    fs.utimesSync(
      path.join(plugins, "installed_plugins.json"),
      new Date(2020, 0, 1),
      new Date(2020, 0, 1),
    );
    const cwRoot = path.join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "local-agent-mode-sessions",
      "acc",
      "org",
    );
    const cwPlugins = path.join(cwRoot, "cowork_plugins");
    fs.mkdirSync(cwPlugins, { recursive: true });
    writeJson(path.join(cwPlugins, "known_marketplaces.json"), {});
    writeJson(path.join(cwPlugins, "installed_plugins.json"), { version: 2, plugins: {} });
    const report = await runScan({
      home,
      platform: "darwin",
      env: {},
      mode: "auto",
      noNetwork: true,
    });
    // v1.0: topology.cowork lists the cowork roots
    expect(report.schemaVersion).toBe("1.0");
    expect(report.topology.cowork.length).toBeGreaterThan(0);
    expect(report.topology.cowork[0]?.accountId).toBe("acc");
    expect(report.topology.cowork[0]?.orgId).toBe("org");
  });

  // Regression test for the source-kind taxonomy refactor.
  //
  // Scenario: a `directory:` source marketplace was registered but its source
  // dir got deleted, leaving orphaned plugin entries in installed_plugins.json
  // pointing at a marketplace cpd can't read. The previous behavior conflated
  // three distinct meanings under `pluginEntrySourceKind: "unsupported"`, and
  // emitted a spurious "Upgrade Claude Code" advisory for every orphan.
  //
  // Expected after the refactor:
  //  - Layer-1 marketplace_clone fires "missing" / stale (canonical signal).
  //  - Per-plugin source-advisory stays SILENT — no `unsupported-source` drift
  //    for these orphans, since the underlying problem is the missing
  //    marketplace clone (already flagged), not a futuristic source kind.
  //  - The user's recommendation list does NOT contain "Upgrade Claude Code".
  it("orphaned plugins from a deleted directory: marketplace produce no spurious unsupported-source advisory", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-orphan-"));
    const plugins = path.join(home, ".claude", "plugins");
    fs.mkdirSync(plugins, { recursive: true });
    // Register a directory: marketplace whose source dir doesn't exist.
    const missingDir = path.join(home, "deleted-source-dir");
    writeJson(path.join(plugins, "known_marketplaces.json"), {
      "local-mp": { source: { source: "directory", path: missingDir } },
    });
    // Note: NOT calling gitInitWithCommit(cloneDir) — the marketplace's
    // local clone dir under ~/.claude/plugins/marketplaces/ also doesn't
    // exist, and there's no marketplace.json to read.
    // installed_plugins.json points at orphan entries.
    const installPath = path.join(plugins, "cache", "local-mp", "orphan-a", "0.1.0");
    fs.mkdirSync(installPath, { recursive: true });
    const installPath2 = path.join(plugins, "cache", "local-mp", "orphan-b", "0.2.0");
    fs.mkdirSync(installPath2, { recursive: true });
    writeJson(path.join(plugins, "installed_plugins.json"), {
      version: 2,
      plugins: {
        "orphan-a@local-mp": [{ version: "0.1.0", installPath }],
        "orphan-b@local-mp": [{ version: "0.2.0", installPath: installPath2 }],
      },
    });
    const report = await runScan({
      home,
      platform: "darwin",
      env: {},
      mode: "auto",
      noNetwork: true,
    });

    // Layer-1 marketplace_clone fires for the missing marketplace.
    const mpCacheKey = Object.keys(report.marketplaceCaches).find((k) => k.startsWith("local-mp"));
    expect(mpCacheKey).toBeDefined();

    // No `unsupported-source` drift for either orphan plugin.
    // (This is the regression — before the refactor, the default
    //  pluginEntrySourceKind = "unsupported" caused the source-advisory
    //  detector to fire for every plugin in a missing-marketplace.)
    const unsupportedDrifts = report.drifts.filter((d) => d.kind === "unsupported-source");
    expect(unsupportedDrifts).toHaveLength(0);

    // The recommendations list is silent on "Upgrade Claude Code" too.
    const upgradeRecs = report.recommendations.filter((r) =>
      r.description.includes("Upgrade Claude Code"),
    );
    expect(upgradeRecs).toHaveLength(0);

    // pluginEntrySourceKind for the orphan plugins is the new sentinel,
    // distinct from values that fire the advisory.
    for (const pkKey of ["orphan-a@local-mp#ccd", "orphan-b@local-mp#ccd"]) {
      const snaps = report.caches[pkKey];
      const installSnap = snaps?.find((s) => s.layer === "install_snapshot");
      if (installSnap?.layer === "install_snapshot") {
        expect(installSnap.data.pluginEntrySourceKind).toBe("clone-unreadable");
      }
    }
  });
});
