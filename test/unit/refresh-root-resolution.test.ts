import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runRefresh } from "../../src/commands/refresh.js";

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  tmp.length = 0;
  vi.restoreAllMocks();
});

function gitInit(dir: string) {
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
}

function ccdWithDemo(home: string): { ccd: string; cwPlugins: string } {
  const ccd = path.join(home, ".claude", "plugins");
  const cwPlugins = path.join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "local-agent-mode-sessions",
    "acc1",
    "org1",
    "cowork_plugins",
  );
  fs.mkdirSync(ccd, { recursive: true });
  fs.mkdirSync(cwPlugins, { recursive: true });
  const clone = path.join(ccd, "marketplaces", "demo");
  gitInit(clone);
  fs.mkdirSync(path.join(clone, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(clone, ".claude-plugin", "marketplace.json"),
    JSON.stringify({ name: "demo", plugins: [] }),
  );
  fs.writeFileSync(
    path.join(ccd, "known_marketplaces.json"),
    JSON.stringify({ demo: { source: { source: "github", repo: "x/demo" } } }),
  );
  fs.writeFileSync(
    path.join(ccd, "installed_plugins.json"),
    JSON.stringify({ version: 1, plugins: {} }),
  );
  fs.writeFileSync(
    path.join(cwPlugins, "installed_plugins.json"),
    JSON.stringify({ version: 1, plugins: {} }),
  );
  // Cowork mtime newer than CCD (reporter actively using Cowork).
  const old = new Date(Date.now() - 3_600_000);
  const now = new Date();
  fs.utimesSync(path.join(ccd, "installed_plugins.json"), old, old);
  fs.utimesSync(path.join(cwPlugins, "installed_plugins.json"), now, now);
  return { ccd, cwPlugins };
}

const noopClaude = async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "" });

describe("runRefresh targets the root that owns the named marketplace (CCD vs Cowork)", () => {
  it("finds a CCD marketplace even when the Cowork root's mtime is newer", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-rr-"));
    tmp.push(home);
    const { cwPlugins } = ccdWithDemo(home);
    fs.writeFileSync(path.join(cwPlugins, "known_marketplaces.json"), JSON.stringify({}));

    const report = await runRefresh({
      home,
      platform: "darwin",
      env: { HOME: home },
      mode: "all",
      noNetwork: true,
      marketplaceName: "demo",
      claudeRunner: noopClaude,
    });

    // Pre-fix: rejected with E_USAGE "is not registered" (Cowork root resolved).
    expect(report.marketplace).toBe("demo");
    expect(report.before.layer1.evidence.cloneDir).toContain(
      path.join(".claude", "plugins", "marketplaces", "demo"),
    );
  });

  it("finds a Cowork-owned marketplace even when the CCD root's mtime is newer", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-rr-"));
    tmp.push(home);

    // CCD root: present but does NOT own "demo".
    const ccd = path.join(home, ".claude", "plugins");
    fs.mkdirSync(ccd, { recursive: true });
    fs.writeFileSync(path.join(ccd, "known_marketplaces.json"), JSON.stringify({}));
    fs.writeFileSync(
      path.join(ccd, "installed_plugins.json"),
      JSON.stringify({ version: 1, plugins: {} }),
    );

    // Cowork root: owns "demo".
    const cwPlugins = path.join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "local-agent-mode-sessions",
      "acc1",
      "org1",
      "cowork_plugins",
    );
    fs.mkdirSync(cwPlugins, { recursive: true });
    const clone = path.join(cwPlugins, "marketplaces", "demo");
    gitInit(clone);
    fs.mkdirSync(path.join(clone, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(clone, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "demo", plugins: [] }),
    );
    fs.writeFileSync(
      path.join(cwPlugins, "known_marketplaces.json"),
      JSON.stringify({ demo: { source: { source: "github", repo: "x/demo" } } }),
    );
    fs.writeFileSync(
      path.join(cwPlugins, "installed_plugins.json"),
      JSON.stringify({ version: 1, plugins: {} }),
    );

    // CCD mtime is NEWER than Cowork — old mtime-based detectMode would pick CCD
    // and miss "demo". This is the inverse of the CCD-owned test's mtime bias.
    const now = new Date();
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(path.join(ccd, "installed_plugins.json"), now, now);
    fs.utimesSync(path.join(cwPlugins, "installed_plugins.json"), old, old);

    const report = await runRefresh({
      home,
      platform: "darwin",
      env: { HOME: home },
      mode: "all",
      noNetwork: true,
      marketplaceName: "demo",
      claudeRunner: noopClaude,
    });

    expect(report.marketplace).toBe("demo");
    // Discriminating assertion: the inner scan resolved the COWORK clone, not a CCD path.
    expect(report.before.layer1.evidence.cloneDir).toContain(
      path.join("cowork_plugins", "marketplaces", "demo"),
    );
  });

  it("a corrupt unrelated Cowork known_marketplaces.json does not abort refresh of a CCD marketplace", async () => {
    // Relies on Phase A: discoverTopology no longer throws on the corrupt file,
    // and the resolver's own catch keeps it from being the first throw site.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-rr-"));
    tmp.push(home);
    const { cwPlugins } = ccdWithDemo(home);
    fs.writeFileSync(path.join(cwPlugins, "known_marketplaces.json"), "{ not json");

    const report = await runRefresh({
      home,
      platform: "darwin",
      env: { HOME: home },
      mode: "all",
      noNetwork: true,
      marketplaceName: "demo",
      claudeRunner: noopClaude,
    });
    expect(report.marketplace).toBe("demo");
  });

  it("honors an explicit --mode cowork instead of auto-redirecting to the owning root", async () => {
    // "demo" is owned by CCD. The user explicitly forces cowork mode. Auto-
    // resolution must be SKIPPED — explicit intent wins — so refresh looks only
    // in the cowork root (which does not register "demo") and reports it as not
    // registered, rather than silently redirecting to the CCD root.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-rr-"));
    tmp.push(home);
    const { cwPlugins } = ccdWithDemo(home);
    fs.writeFileSync(path.join(cwPlugins, "known_marketplaces.json"), JSON.stringify({}));

    await expect(
      runRefresh({
        home,
        platform: "darwin",
        env: { HOME: home },
        mode: "cowork",
        noNetwork: true,
        marketplaceName: "demo",
        claudeRunner: noopClaude,
      }),
    ).rejects.toThrow(/is not registered/i);
  });
});
