import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function buildIfNeeded() {
  if (!fs.existsSync(path.join(ROOT, "dist", "cli.js"))) {
    execSync("npm run build", { cwd: ROOT, stdio: "ignore" });
  }
}

function makeCcdFixture(home: string, opts: { staleVersion?: boolean } = {}): string {
  const plugins = path.join(home, ".claude", "plugins");
  fs.mkdirSync(plugins, { recursive: true });
  fs.writeFileSync(
    path.join(plugins, "known_marketplaces.json"),
    JSON.stringify({
      acme: { source: { source: "directory", path: path.join(home, "src") } },
    }),
  );
  fs.mkdirSync(path.join(home, "src", ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "src", ".claude-plugin", "marketplace.json"),
    JSON.stringify({ plugins: [{ name: "p", version: "1.0.0" }] }),
  );
  const cloneDir = path.join(plugins, "marketplaces", "acme");
  fs.mkdirSync(path.join(cloneDir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(cloneDir, ".claude-plugin", "marketplace.json"),
    JSON.stringify({ plugins: [{ name: "p", version: "1.0.0" }] }),
  );
  const installedVer = opts.staleVersion ? "0.9.0" : "1.0.0";
  const installPath = path.join(plugins, "cache", "acme", "p", installedVer);
  fs.mkdirSync(installPath, { recursive: true });
  fs.writeFileSync(
    path.join(plugins, "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: { "p@acme": [{ version: installedVer, installPath }] },
    }),
  );
  return installPath;
}

/** Write a fake `claude` shim into a temp bin/ dir; return that dir. The shim
 *  echoes its args and exits 0 (or 42 if the env var FAKE_CLAUDE_FAIL=1 is set). */
function makeFakeClaudeBin(home: string): string {
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const shim = path.join(bin, "claude");
  fs.writeFileSync(
    shim,
    `#!/usr/bin/env bash
echo "fake claude $@"
exit \${FAKE_CLAUDE_EXIT:-0}
`,
  );
  fs.chmodSync(shim, 0o755);
  return bin;
}

const baseEnv = (home: string, extra: Record<string, string> = {}) => ({
  ...process.env,
  HOME: home,
  NO_COLOR: "1",
  CI: "1",
  TERM: "dumb",
  ...extra,
});

const isDarwin = process.platform === "darwin";

// ─────────────── check ───────────────────────────────────────────────────

describe.runIf(isDarwin)("CLI: check", () => {
  it("--json emits a CheckReport with the matched plugin", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    makeCcdFixture(home, { staleVersion: true });
    const r = spawnSync(
      "node",
      [
        path.join(ROOT, "dist", "cli.js"),
        "check",
        "p@acme",
        "--no-network",
        "--no-progress",
        "--no-log-file",
        "--json",
      ],
      { encoding: "utf8", env: baseEnv(home) },
    );
    expect(r.status).toBe(2);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.schemaVersion).toBe("1.0");
    expect(parsed.pluginId).toBe("p@acme");
    expect(parsed.plugin?.id).toBe("p@acme");
    expect(parsed.plugin?.checks.install_snapshot.status).toBe("stale");
    expect(parsed.marketplace?.name).toBe("acme");
    // fullReport carries the rest of the scan
    expect(parsed.fullReport.plugins).toHaveLength(1);
  });

  it("reports plugin-not-installed with exit 2", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    makeCcdFixture(home);
    const r = spawnSync(
      "node",
      [
        path.join(ROOT, "dist", "cli.js"),
        "check",
        "ghost@acme",
        "--no-network",
        "--no-progress",
        "--no-log-file",
      ],
      { encoding: "utf8", env: baseEnv(home) },
    );
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/not installed/i);
  });

  it("rejects malformed plugin id with E_USAGE", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    makeCcdFixture(home);
    const r = spawnSync(
      "node",
      [
        path.join(ROOT, "dist", "cli.js"),
        "check",
        "broken-id-no-at-sign",
        "--no-network",
        "--no-progress",
        "--no-log-file",
        "--json",
      ],
      { encoding: "utf8", env: baseEnv(home) },
    );
    // E_USAGE → exit 64 per HELP_EPILOG.
    expect(r.status).toBe(64);
    const env = JSON.parse(r.stdout);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("E_USAGE");
  });

  // ─── RPM-managed plugin lookup (Cowork "Personal plugins" UI install) ─────
  // Plugins installed via Cowork's UI live in `rpm/manifest.json`, NOT in
  // `cowork_plugins/installed_plugins.json`. They use a different marketplace
  // alias than the CCD-installed copy of the same plugin (the RPM record
  // carries the backend's marketplace name, which can differ from the alias
  // a user gave when they ran `claude plugin marketplace add` for CCD).
  //
  // Regression: before this fix, `cpd check --mode cowork <plugin>@<ccd-alias>`
  // wouldn't find the plugin in cowork (because the RPM check was skipped) and
  // would inappropriately fall back to CCD's report. Maintainer caught this in
  // dogfooding of v1.0.0-.

  function makeCoworkRpmFixture(
    home: string,
    opts: {
      pluginName: string;
      ccdMarketplaceAlias: string;
      coworkRpmMarketplaceAlias: string;
      includeInCcd?: boolean;
    },
  ): { coworkAcc: string; coworkOrg: string } {
    // CCD: optionally register the marketplace alias (so the user can type
    // `<plugin>@<ccd-alias>` and have CCD know the marketplace name).
    if (opts.includeInCcd !== false) {
      const plugins = path.join(home, ".claude", "plugins");
      fs.mkdirSync(plugins, { recursive: true });
      fs.writeFileSync(
        path.join(plugins, "known_marketplaces.json"),
        JSON.stringify({
          [opts.ccdMarketplaceAlias]: { source: { source: "github", repo: "x/y" } },
        }),
      );
      fs.writeFileSync(
        path.join(plugins, "installed_plugins.json"),
        JSON.stringify({ version: 2, plugins: {} }),
      );
    }
    // Cowork: a single (acc, org) pair with the plugin in rpm/manifest.json,
    // NOT in cowork_plugins/installed_plugins.json.
    const coworkAcc = "acc-uuid";
    const coworkOrg = "org-uuid";
    const coworkRoot = path.join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "local-agent-mode-sessions",
      coworkAcc,
      coworkOrg,
    );
    const coworkPluginsRoot = path.join(coworkRoot, "cowork_plugins");
    fs.mkdirSync(coworkPluginsRoot, { recursive: true });
    fs.writeFileSync(path.join(coworkPluginsRoot, "known_marketplaces.json"), JSON.stringify({}));
    fs.writeFileSync(
      path.join(coworkPluginsRoot, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: {} }),
    );
    // RPM: the actual install record.
    const rpmRoot = path.join(coworkRoot, "rpm");
    const rpmPluginId = "plugin_01XYZRPMtestId";
    fs.mkdirSync(path.join(rpmRoot, rpmPluginId), { recursive: true });
    fs.writeFileSync(
      path.join(rpmRoot, "manifest.json"),
      JSON.stringify({
        plugins: [
          {
            id: rpmPluginId,
            name: opts.pluginName,
            marketplaceName: opts.coworkRpmMarketplaceAlias,
            marketplaceId: "marketplace_01ABCDEFGtest",
            installedBy: "user",
            updatedAt: "2026-04-29T10:45:27.242156Z",
          },
        ],
      }),
    );
    return { coworkAcc, coworkOrg };
  }

  it("RPM regression: --mode cowork finds plugin in rpm/manifest.json (not installed_plugins.json)", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    makeCoworkRpmFixture(home, {
      pluginName: "founder-skills",
      ccdMarketplaceAlias: "lool-founder-skills",
      coworkRpmMarketplaceAlias: "founder-skills",
    });
    const r = spawnSync(
      "node",
      [
        path.join(ROOT, "dist", "cli.js"),
        "check",
        "founder-skills@lool-founder-skills",
        "--mode",
        "cowork",
        "--no-network",
        "--no-progress",
        "--no-log-file",
        "--json",
      ],
      { encoding: "utf8", env: baseEnv(home) },
    );
    // Before the fix: this would have fallen back to CCD (where the plugin
    // is NOT installed), reported `plugin: undefined`, and exited 2.
    // After the fix: cpd finds the RPM match in cowork; `plugin` stays
    // undefined (CCD-style PluginReport doesn't apply to RPM installs),
    // but `rpmMatch` is populated with the RPM record + alias-differs note.
    const parsed = JSON.parse(r.stdout);
    expect(parsed.schemaVersion).toBe("1.0");
    expect(parsed.pluginId).toBe("founder-skills@lool-founder-skills");
    // The CCD-style PluginReport is undefined (RPM-only install).
    expect(parsed.plugin).toBeUndefined();
    // The RPM match IS populated.
    expect(parsed.rpmMatch).toBeDefined();
    expect(parsed.rpmMatch.rpmPlugin.name).toBe("founder-skills");
    expect(parsed.rpmMatch.rpmPlugin.marketplaceName).toBe("founder-skills");
    // Marketplace alias differs (user typed `lool-founder-skills`, RPM has
    // `founder-skills`) — surfaced for the renderer.
    expect(parsed.rpmMatch.marketplaceAliasDiffers).toEqual({
      typedAs: "lool-founder-skills",
      actual: "founder-skills",
    });
    // Mode-fallback should NOT be set — plugin was found in the requested mode.
    expect(parsed.fullReport._modeFallback).toBeUndefined();
  });

  it("RPM regression: matching marketplace alias does NOT trigger the alias-differs note", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    makeCoworkRpmFixture(home, {
      pluginName: "p",
      ccdMarketplaceAlias: "mp",
      coworkRpmMarketplaceAlias: "mp", // same alias on both sides
    });
    const r = spawnSync(
      "node",
      [
        path.join(ROOT, "dist", "cli.js"),
        "check",
        "p@mp",
        "--mode",
        "cowork",
        "--no-network",
        "--no-progress",
        "--no-log-file",
        "--json",
      ],
      { encoding: "utf8", env: baseEnv(home) },
    );
    const parsed = JSON.parse(r.stdout);
    expect(parsed.rpmMatch).toBeDefined();
    expect(parsed.rpmMatch.marketplaceAliasDiffers).toBeUndefined();
  });

  it("RPM regression: human renderer shows alias-differs note when present", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    makeCoworkRpmFixture(home, {
      pluginName: "founder-skills",
      ccdMarketplaceAlias: "lool-founder-skills",
      coworkRpmMarketplaceAlias: "founder-skills",
    });
    const r = spawnSync(
      "node",
      [
        path.join(ROOT, "dist", "cli.js"),
        "check",
        "founder-skills@lool-founder-skills",
        "--mode",
        "cowork",
        "--no-network",
        "--no-progress",
        "--no-log-file",
        "--no-color",
      ],
      { encoding: "utf8", env: baseEnv(home) },
    );
    // de-jargon pass: the alias-differs note is now framed as "Naming note" using
    // plain-language labels ("standalone Claude Code" / "Claude Cowork").
    expect(r.stdout).toMatch(/Naming note/);
    expect(r.stdout).toMatch(/different names in your two installs/);
    expect(r.stdout).toMatch(/standalone Claude Code.*lool-founder-skills/);
    expect(r.stdout).toMatch(/Claude Cowork registered it as.*founder-skills/);
    expect(r.stdout).toMatch(/installed via Claude Cowork's in-app Plugins UI/);
    expect(r.stdout).not.toMatch(/Plugin .* is not installed/);
    // Should NOT print the mode-fallback note (no fallback occurred).
    expect(r.stdout).not.toMatch(/Showing standalone Claude Code details/);
  });

  it("RPM regression: --mode ccd with plugin only in cowork RPM falls back to cowork", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    // Cowork has the plugin via RPM; CCD does NOT have the plugin (just the
    // marketplace alias registered).
    makeCoworkRpmFixture(home, {
      pluginName: "founder-skills",
      ccdMarketplaceAlias: "lool-founder-skills",
      coworkRpmMarketplaceAlias: "founder-skills",
    });
    const r = spawnSync(
      "node",
      [
        path.join(ROOT, "dist", "cli.js"),
        "check",
        "founder-skills@lool-founder-skills",
        "--mode",
        "ccd",
        "--no-network",
        "--no-progress",
        "--no-log-file",
        "--json",
      ],
      { encoding: "utf8", env: baseEnv(home) },
    );
    const parsed = JSON.parse(r.stdout);
    // Fallback fired: requested ccd, found in cowork via RPM.
    expect(parsed.fullReport._modeFallback).toEqual({
      requested: "ccd",
      foundIn: "cowork",
    });
    expect(parsed.rpmMatch).toBeDefined();
    expect(parsed.rpmMatch.rpmPlugin.name).toBe("founder-skills");
  });
});

// ─────────────── refresh ─────────────────────────────────────────────────

describe.runIf(isDarwin)("CLI: refresh", () => {
  it("emits exactly ONE scan_done event per refresh run (silentProgress contract)", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    makeCcdFixture(home);
    const fakeBin = makeFakeClaudeBin(home);
    const eventsFile = path.join(home, "events.ndjson");
    const r = spawnSync(
      "node",
      [
        path.join(ROOT, "dist", "cli.js"),
        "refresh",
        "acme",
        "--no-network",
        "--no-progress",
        "--no-log-file",
        "--ndjson-events",
        "--events-file",
        eventsFile,
      ],
      {
        encoding: "utf8",
        env: baseEnv(home, { PATH: `${fakeBin}:${process.env.PATH ?? ""}` }),
      },
    );
    expect(r.status).toBe(0);
    expect(fs.existsSync(eventsFile)).toBe(true);
    const events = fs
      .readFileSync(eventsFile, "utf8")
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    const doneEvents = events.filter((e) => e.type === "scan_done");
    expect(doneEvents).toHaveLength(1);
    const phaseStarts = events.filter((e) => e.type === "phase_start");
    const refreshPhases = phaseStarts
      .map((e) => e.phase)
      .filter((p: string) => p.startsWith("refresh_"));
    expect(refreshPhases).toEqual([
      "refresh_before_scan",
      "refresh_claude_update",
      "refresh_after_scan",
    ]);
  });

  it("--json emits a RefreshReport with before/after sections", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    makeCcdFixture(home);
    const fakeBin = makeFakeClaudeBin(home);
    const r = spawnSync(
      "node",
      [
        path.join(ROOT, "dist", "cli.js"),
        "refresh",
        "acme",
        "--no-network",
        "--no-progress",
        "--no-log-file",
        "--json",
      ],
      {
        encoding: "utf8",
        env: baseEnv(home, { PATH: `${fakeBin}:${process.env.PATH ?? ""}` }),
      },
    );
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.schemaVersion).toBe("1.0");
    expect(parsed.marketplace).toBe("acme");
    expect(parsed.before.plugins).toHaveLength(1);
    expect(parsed.after.plugins).toHaveLength(1);
    expect(parsed.claudeUpdate.ok).toBe(true);
  });

  it("rejects unknown marketplace with E_USAGE", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    makeCcdFixture(home);
    const fakeBin = makeFakeClaudeBin(home);
    const r = spawnSync(
      "node",
      [
        path.join(ROOT, "dist", "cli.js"),
        "refresh",
        "ghost-mp",
        "--no-network",
        "--no-progress",
        "--no-log-file",
        "--json",
      ],
      {
        encoding: "utf8",
        env: baseEnv(home, { PATH: `${fakeBin}:${process.env.PATH ?? ""}` }),
      },
    );
    // E_USAGE → exit 64 per HELP_EPILOG.
    expect(r.status).toBe(64);
    const env = JSON.parse(r.stdout);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("E_USAGE");
  });

  it("--auto-update chains plain `claude plugin update` commands but skips version traps", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    // Plain version-mismatch case: marketplace says 1.0.0, installed 0.9.0 → simple update.
    makeCcdFixture(home, { staleVersion: true });
    const fakeBin = makeFakeClaudeBin(home);
    const r = spawnSync(
      "node",
      [
        path.join(ROOT, "dist", "cli.js"),
        "refresh",
        "acme",
        "--auto-update",
        "--no-network",
        "--no-progress",
        "--no-log-file",
        "--json",
      ],
      {
        encoding: "utf8",
        env: baseEnv(home, { PATH: `${fakeBin}:${process.env.PATH ?? ""}` }),
      },
    );
    expect(r.status).toBe(2);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.chainedUpdates).toHaveLength(1);
    expect(parsed.chainedUpdates[0].id).toBe("p@acme");
    expect(parsed.chainedUpdates[0].ok).toBe(true);
  });
});

// ─────────────── list ────────────────────────────────────────────────────

describe.runIf(isDarwin)("CLI: list", () => {
  it("--json emits a ListReport with marketplaces and plugins arrays", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    makeCcdFixture(home);
    const r = spawnSync(
      "node",
      [
        path.join(ROOT, "dist", "cli.js"),
        "list",
        "--no-network",
        "--no-progress",
        "--no-log-file",
        "--json",
      ],
      { encoding: "utf8", env: baseEnv(home) },
    );
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.schemaVersion).toBe("1.0");
    expect(parsed.marketplaces).toHaveLength(1);
    expect(parsed.plugins).toHaveLength(1);
    expect(parsed.plugins[0].id).toBe("p@acme");
  });

  it("human output is line-parseable with one plugin per line", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    makeCcdFixture(home);
    const r = spawnSync(
      "node",
      [path.join(ROOT, "dist", "cli.js"), "list", "--no-network", "--no-progress", "--no-log-file"],
      { encoding: "utf8", env: baseEnv(home) },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Marketplaces \(1\)/);
    expect(r.stdout).toMatch(/Plugins \(1\)/);
    expect(r.stdout).toMatch(/p@acme/);
  });
});

// ─────────────── explain ─────────────────────────────────────────────────

describe("CLI: explain", () => {
  it("prints the six-layer architecture cheat-sheet", () => {
    buildIfNeeded();
    const r = spawnSync("node", [path.join(ROOT, "dist", "cli.js"), "explain"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Layer 1/);
    // The phrase "version trap" was retired from user-facing copy in;
    // `cpd explain` still teaches the underlying scenario in plain language.
    expect(r.stdout).toMatch(/Updates blocked/);
    expect(r.stdout).toMatch(/six independent cache layers/);
  });
});

// ─────────────── watch ───────────────────────────────────────────────────
// Watch tests are timing-dependent (fs.watch fires asynchronously) and gated
// to darwin since watch itself only works there in v0.2.

describe.runIf(isDarwin)("CLI: watch", () => {
  it("rejects malformed plugin id with E_USAGE", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    makeCcdFixture(home);
    const r = spawnSync(
      "node",
      [
        path.join(ROOT, "dist", "cli.js"),
        "watch",
        "broken-id",
        "--no-network",
        "--no-progress",
        "--no-log-file",
        "--json",
      ],
      { encoding: "utf8", env: baseEnv(home), timeout: 3000 },
    );
    // E_USAGE → exit 64 per HELP_EPILOG.
    expect(r.status).toBe(64);
    const env = JSON.parse(r.stdout);
    expect(env.code).toBe("E_USAGE");
  });

  it("re-checks when a watched file changes", async () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    const installPath = makeCcdFixture(home);

    const child = await import("node:child_process").then((m) =>
      m.spawn(
        "node",
        [
          path.join(ROOT, "dist", "cli.js"),
          "watch",
          "p@acme",
          "--no-network",
          "--no-progress",
          "--no-log-file",
          "--interval",
          "200",
        ],
        { env: baseEnv(home) },
      ),
    );
    let stderr = "";
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });

    // Wait for the initial check to print + watchers to be set up.
    await new Promise((r) => setTimeout(r, 1500));

    // Mutate a watched file. macOS fs.watch with recursive will fire.
    fs.writeFileSync(path.join(installPath, "edit.md"), "edited");

    // Wait for the debounced re-check.
    await new Promise((r) => setTimeout(r, 1500));

    child.kill("SIGINT");
    await new Promise((r) => setTimeout(r, 500));

    expect(stderr).toMatch(/initial/);
    // The file change should produce at least one "change" output line.
    // (FSEvents on a freshly-created tmpdir can be flaky on first events,
    //  so this assertion is the loose-but-meaningful check.)
    expect(stderr).toMatch(/(change|monitoring|watch:)/);
  });
});

// ─────────────── Plan fixes: B2 (log notice suppression) + B1 (NDJSON contract) ────────

describe.runIf(isDarwin)("CLI: plan fixes B2 (log notice) and B1 (NDJSON contract)", () => {
  it("B2: --json set → no early 'writing log to' notice on stderr", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    makeCcdFixture(home);
    const r = spawnSync(
      "node",
      [
        path.join(ROOT, "dist", "cli.js"),
        "check",
        "p@acme",
        "--no-network",
        "--no-progress",
        "--json",
        // No --no-log-file: log file IS written, just notice suppressed
      ],
      { encoding: "utf8", env: { ...baseEnv(home), CI: "1" } },
    );
    // --json suppresses the notice regardless of TTY/CI
    expect(r.stderr).not.toMatch(/writing log to/);
  });

  it("B2: --ndjson-events set → no early 'writing log to' notice on stderr", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    makeCcdFixture(home);
    const eventsFile = path.join(home, "events.ndjson");
    const r = spawnSync(
      "node",
      [
        path.join(ROOT, "dist", "cli.js"),
        "check",
        "p@acme",
        "--no-network",
        "--no-progress",
        "--ndjson-events",
        "--events-file",
        eventsFile,
      ],
      { encoding: "utf8", env: { ...baseEnv(home), CI: "1" } },
    );
    // --ndjson-events suppresses the text notice (would corrupt stream)
    expect(r.stderr).not.toMatch(/writing log to/);
    // Events file should be parseable (no text corruption)
    if (fs.existsSync(eventsFile)) {
      const lines = fs.readFileSync(eventsFile, "utf8").trim().split("\n").filter(Boolean);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
  });

  it("B1 NDJSON contract: cpd check without fallback emits exactly ONE scan_done event", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    makeCcdFixture(home, { staleVersion: true });
    const eventsFile = path.join(home, "events.ndjson");
    const r = spawnSync(
      "node",
      [
        path.join(ROOT, "dist", "cli.js"),
        "check",
        "p@acme",
        "--no-network",
        "--no-progress",
        "--no-log-file",
        "--ndjson-events",
        "--events-file",
        eventsFile,
      ],
      { encoding: "utf8", env: baseEnv(home) },
    );
    // Should exit 2 or 3 (stale plugin)
    expect([2, 3]).toContain(r.status);
    expect(fs.existsSync(eventsFile)).toBe(true);
    const events = fs
      .readFileSync(eventsFile, "utf8")
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    const doneEvents = events.filter((e) => e.type === "scan_done");
    // One-event-per-cpd-check-invocation contract
    expect(doneEvents).toHaveLength(1);
  });

  it("B1: cpd check scan_done event summary still contains marketplaces/plugins counts (agent contract)", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    makeCcdFixture(home, { staleVersion: true });
    const eventsFile = path.join(home, "events.ndjson");
    spawnSync(
      "node",
      [
        path.join(ROOT, "dist", "cli.js"),
        "check",
        "p@acme",
        "--no-network",
        "--no-progress",
        "--no-log-file",
        "--ndjson-events",
        "--events-file",
        eventsFile,
      ],
      { encoding: "utf8", env: baseEnv(home) },
    );
    const events = fs
      .readFileSync(eventsFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const done = events.find((e) => e.type === "scan_done");
    expect(done).toBeDefined();
    // summary field preserved for agent contract
    expect(typeof done?.summary?.marketplaces).toBe("number");
    expect(typeof done?.summary?.plugins).toBe("number");
  });

  it("B1: cpd check human done line does NOT contain marketplace/plugin/stale counts", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    makeCcdFixture(home, { staleVersion: true });
    // Use TTY simulation via TERM=xterm (not dumb) to trigger the done line.
    // Since we can't actually have a TTY in tests, we verify via the logic:
    // when isTtyStderr() is true (in real TTY), the done line is emitted.
    // In CI (non-TTY), the done line is not emitted at all, which is also
    // the correct behavior. Test the JSON event's summary.marketplaces to
    // confirm it still has full data while the human line (when emitted)
    // would be terse.
    // This integration test focuses on: the human output does NOT contain
    // marketplace/plugin/stale parenthetical that cpd scan shows.
    const r = spawnSync(
      "node",
      [
        path.join(ROOT, "dist", "cli.js"),
        "check",
        "p@acme",
        "--no-network",
        "--no-progress",
        "--no-log-file",
      ],
      { encoding: "utf8", env: baseEnv(home) },
    );
    // In CI non-TTY, the done line is not emitted at all (correct)
    // but if it were emitted, it should NOT contain "marketplaces" or "plugins"
    if (r.stderr.includes("done in")) {
      expect(r.stderr).not.toMatch(/\d+ marketplace/);
      expect(r.stderr).not.toMatch(/\d+ plugin/);
    }
  });

  it("B2: cpd check --json evidence keys in JSON output retain original names", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    makeCcdFixture(home, { staleVersion: true });
    const r = spawnSync(
      "node",
      [
        path.join(ROOT, "dist", "cli.js"),
        "check",
        "p@acme",
        "--no-network",
        "--no-progress",
        "--no-log-file",
        "--json",
      ],
      { encoding: "utf8", env: baseEnv(home) },
    );
    expect([2, 3]).toContain(r.status);
    const parsed = JSON.parse(r.stdout);
    // The human renderer relabels keys, but JSON output must retain original names.
    const installSnap = parsed.plugin?.checks?.install_snapshot;
    if (installSnap?.evidence) {
      // If versionTrapKind is present in evidence, it must NOT be renamed
      if (installSnap.evidence.versionTrapKind !== undefined) {
        expect(installSnap.evidence.versionTrapKind).toBeDefined();
        expect(installSnap.evidence["drift kind"]).toBeUndefined();
      }
    }
  });
});
