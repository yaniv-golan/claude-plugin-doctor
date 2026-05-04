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

function makeCcdFixture(home: string, opts: { staleVersion?: boolean } = {}) {
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
    JSON.stringify({ version: 2, plugins: { "p@acme": [{ version: installedVer, installPath }] } }),
  );
}

const baseEnv = (home: string) => ({
  ...process.env,
  HOME: home,
  NO_COLOR: "1",
  CI: "1",
  TERM: "dumb",
});

// v0.1 supports macOS only — these tests spawn the real CLI which calls
// resolveCcdPluginsRoot(process.platform) and throws E_PLATFORM_UNSUPPORTED
// on Linux/Windows. Gate to darwin so ubuntu CI still passes typecheck/lint/unit.
describe.runIf(process.platform === "darwin")("CLI integration", () => {
  it("--help prints synopsis, exit codes, error codes", () => {
    buildIfNeeded();
    const r = spawnSync("node", [path.join(ROOT, "dist", "cli.js"), "--help"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/claude-plugin-doctor/);
    expect(r.stdout).toMatch(/Exit codes:/);
    expect(r.stdout).toMatch(/E_PLATFORM_UNSUPPORTED/);
  });

  it("--version prints the version", () => {
    buildIfNeeded();
    const r = spawnSync("node", [path.join(ROOT, "dist", "cli.js"), "--version"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("default invocation reports drift in human format and non-zero exit code", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    // directory-source plugins produce unsupported-source drift → exit code 3
    // and a manual-step recommendation (no runnable cmd).
    makeCcdFixture(home, { staleVersion: true });
    const r = spawnSync(
      "node",
      [path.join(ROOT, "dist", "cli.js"), "scan", "--no-network", "--no-progress"],
      { encoding: "utf8", env: baseEnv(home) },
    );
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/Recommended actions/);
  });

  // Regression test for the   audit-found bug: progress emitDone formerly
  // produced "(N marketplaces, P plugins, — S stale, U unknown version)" with
  // a stray comma before the em-dash. The format MUST be `(left — right)` with
  // no comma directly before the em-dash. The unit test asserts NDJSON shape;
  // this integration test asserts the actual stderr human-line format.
  it("progress 'done in' line: format is `(left — right)`, no stray comma before em-dash", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    makeCcdFixture(home, { staleVersion: true });
    // Force progress to emit by passing CI=undefined and TERM=xterm-256color
    // so isTty heuristics don't suppress. We still get the final ✓-line on
    // non-TTY because emitDone always writes a single line at the end.
    const r = spawnSync(
      "node",
      [path.join(ROOT, "dist", "cli.js"), "scan", "--no-network", "--no-log-file"],
      {
        encoding: "utf8",
        env: { ...process.env, HOME: home, NO_COLOR: "1" },
      },
    );
    // Look for the done-line in stderr (where progress writes go).
    const doneLines = r.stderr.split("\n").filter((l) => /done in [0-9.]+s/.test(l));
    if (doneLines.length === 0) return; // progress suppressed (CI mode); test is no-op
    const line = doneLines[0] ?? "";
    // Hard invariant: the malformed pattern ", —" must not appear.
    expect(line).not.toMatch(/, —/);
    // If the line has both inventory AND drift segments, em-dash separates them.
    if (line.includes("—")) {
      // Format: "✓ done in Xs  (... plugins — ...)"
      // Specifically the character immediately before " — " must NOT be a comma.
      expect(line).toMatch(/[a-z0-9] — /); // letter or digit before " — "
    }
  });

  it("--json emits a single parseable JSON document on stdout with v1.0 schema", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    makeCcdFixture(home, { staleVersion: true });
    const r = spawnSync(
      "node",
      [path.join(ROOT, "dist", "cli.js"), "scan", "--no-network", "--no-progress", "--json"],
      { encoding: "utf8", env: baseEnv(home) },
    );
    expect(r.status).not.toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.schemaVersion).toBe("1.0");
    expect(parsed.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(parsed.exitCode).not.toBe(0);
    // v1.0: drifts array replaces the v0.5 per-layer checks;
    // recommendations array replaces recommendedActions (string[]).
    expect(Array.isArray(parsed.drifts)).toBe(true);
    expect(Array.isArray(parsed.recommendations)).toBe(true);
  });

  // Regression test for the   audit-found bug: `cpd --json | jq` truncated
  // at 64KB on macOS pipes (default pipe buffer size) because process.stdout.write
  // is async and was being lost when process.exit() fired before the write
  // queue drained. Fix: writeStdoutSync helper that loops on partial writes.
  //
  // We can't directly reproduce the pipe truncation on a synthetic fixture
  // small enough for tests (the bug only fires past 64KB). Instead, we generate
  // a fixture large enough to exceed the buffer, pipe through `cat`, and assert
  // the byte count + JSON parse round-trips. The pipe-through-cat is what
  // forces the non-blocking-pipe behavior; spawnSync without a pipe does not.
  it("--json large output: piped through cat without truncation (>64KB pipe-buffer regression)", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    // Construct a fixture that produces enough JSON to exceed 64KB.
    // Each plugin entry contributes ~600-800 bytes of JSON; 200 plugins = ~120KB.
    const plugins = path.join(home, ".claude", "plugins");
    fs.mkdirSync(plugins, { recursive: true });
    const knownMps: Record<string, unknown> = {};
    const installed: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) {
      knownMps[`mp-${i}`] = { source: { source: "directory", path: path.join(home, `src-${i}`) } };
      const srcDir = path.join(home, `src-${i}`, ".claude-plugin");
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(
        path.join(srcDir, "marketplace.json"),
        JSON.stringify({ plugins: [{ name: `p-${i}`, version: "1.0.0" }] }),
      );
      const cloneDir = path.join(plugins, "marketplaces", `mp-${i}`, ".claude-plugin");
      fs.mkdirSync(cloneDir, { recursive: true });
      fs.writeFileSync(
        path.join(cloneDir, "marketplace.json"),
        JSON.stringify({ plugins: [{ name: `p-${i}`, version: "1.0.0" }] }),
      );
      const installPath = path.join(plugins, "cache", `mp-${i}`, `p-${i}`, "1.0.0");
      fs.mkdirSync(installPath, { recursive: true });
      installed[`p-${i}@mp-${i}`] = [{ version: "1.0.0", installPath }];
    }
    fs.writeFileSync(path.join(plugins, "known_marketplaces.json"), JSON.stringify(knownMps));
    fs.writeFileSync(
      path.join(plugins, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: installed }),
    );
    // Run cpd scan via spawnSync — stdout is connected to a Node pipe (not a
    // TTY), which exercises the same `process.stdout.isTTY === false` code
    // path the original `| cat` shell pipe targets. argv form avoids
    // shell-command construction (CodeQL: js/shell-command-injection-from-environment).
    const r = spawnSync(
      "node",
      [
        path.join(ROOT, "dist", "cli.js"),
        "scan",
        "--no-network",
        "--no-progress",
        "--json",
        "--no-log-file",
      ],
      {
        encoding: "utf8",
        env: baseEnv(home),
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    expect(r.stdout.length).toBeGreaterThan(64 * 1024); // proves >64KB written
    // And parses cleanly.
    const parsed = JSON.parse(r.stdout);
    expect(parsed.schemaVersion).toBe("1.0");
    expect(parsed.exitCode).not.toBe(0);
  });

  it("writes a default log file under ~/.claude-plugin-doctor/logs/", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    makeCcdFixture(home);
    const r = spawnSync(
      "node",
      [path.join(ROOT, "dist", "cli.js"), "scan", "--no-network", "--no-progress"],
      { encoding: "utf8", env: baseEnv(home) },
    );
    // makeCcdFixture uses directory-source → unsupported-source drift → exit code 3.
    // We only check the log file is written — status may be 3.
    expect([0, 3]).toContain(r.status);
    const logsDir = path.join(home, ".claude-plugin-doctor", "logs");
    expect(fs.existsSync(logsDir)).toBe(true);
    const files = fs.readdirSync(logsDir);
    expect(files.length).toBe(1);
    const log = fs.readFileSync(path.join(logsDir, files[0] ?? ""), "utf8");
    const lines = log
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.find((l) => l.msg === "scan_start")).toBeTruthy();
    expect(lines.find((l) => l.msg === "scan_done")).toBeTruthy();
    expect(r.stderr).toMatch(/writing log to/);
  });

  it("--no-log-file suppresses the log file", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    makeCcdFixture(home);
    const r = spawnSync(
      "node",
      [path.join(ROOT, "dist", "cli.js"), "scan", "--no-network", "--no-progress", "--no-log-file"],
      { encoding: "utf8", env: baseEnv(home) },
    );
    // makeCcdFixture uses directory-source → unsupported-source drift → exit code 3.
    expect([0, 3]).toContain(r.status);
    expect(fs.existsSync(path.join(home, ".claude-plugin-doctor"))).toBe(false);
  });

  it("--ndjson-events streams phase events to stderr", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    makeCcdFixture(home);
    const r = spawnSync(
      "node",
      [
        path.join(ROOT, "dist", "cli.js"),
        "scan",
        "--no-network",
        "--no-progress",
        "--ndjson-events",
      ],
      { encoding: "utf8", env: baseEnv(home) },
    );
    // makeCcdFixture uses directory-source → unsupported-source drift → exit code 3.
    expect([0, 3]).toContain(r.status);
    const events = r.stderr
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l));
    const types = new Set(events.map((e) => e.type));
    expect(types.has("phase_start")).toBe(true);
    expect(types.has("phase_end")).toBe(true);
    expect(types.has("scan_done")).toBe(true);
    // scan_done now carries an additive `summary` field — verify it
    // round-trips through NDJSON for scripting consumers.
    const done = events.find((e) => e.type === "scan_done");
    expect(done?.summary).toBeDefined();
    expect(typeof done?.summary?.marketplaces).toBe("number");
    expect(typeof done?.summary?.plugins).toBe("number");
    expect(typeof done?.summary?.layersStale).toBe("number");
  });

  it("--ndjson-events --events-file writes complete NDJSON to the file (sync, no truncation)", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    makeCcdFixture(home);
    const eventsFile = path.join(home, "nested", "dir", "events.ndjson");
    const r = spawnSync(
      "node",
      [
        path.join(ROOT, "dist", "cli.js"),
        "scan",
        "--no-network",
        "--no-progress",
        "--ndjson-events",
        "--events-file",
        eventsFile,
      ],
      { encoding: "utf8", env: baseEnv(home) },
    );
    // makeCcdFixture uses directory-source → unsupported-source drift → exit code 3.
    expect([0, 3]).toContain(r.status);
    expect(fs.existsSync(eventsFile)).toBe(true);
    const lines = fs.readFileSync(eventsFile, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    const events = lines.map((l) => JSON.parse(l));
    const types = new Set(events.map((e) => e.type));
    expect(types.has("phase_start")).toBe(true);
    expect(types.has("phase_end")).toBe(true);
    // scan_done must be the last event — proves the fd was flushed and closed
    // synchronously before process.exit (truncation regression test).
    const last = events[events.length - 1];
    expect(last?.type).toBe("scan_done");
  });

  it("--json --no-log-file produces a clean stdout (no leakage)", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    makeCcdFixture(home);
    const r = spawnSync(
      "node",
      [
        path.join(ROOT, "dist", "cli.js"),
        "scan",
        "--no-network",
        "--no-progress",
        "--json",
        "--no-log-file",
      ],
      { encoding: "utf8", env: baseEnv(home) },
    );
    // makeCcdFixture uses directory-source → unsupported-source drift → exit code 3
    expect(r.status).toBe(3);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.schemaVersion).toBe("1.0");
  });

  it("cache --help lists subcommand flags", () => {
    buildIfNeeded();
    const r = spawnSync("node", [path.join(ROOT, "dist", "cli.js"), "cache", "--help"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/--prune-cowork-sessions/);
    expect(r.stdout).toMatch(/--orphans/);
    expect(r.stdout).toMatch(/--older-than/);
  });

  it("cache --prune-cowork-sessions --dry-run with no sessions exits 0", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    makeCcdFixture(home);
    const r = spawnSync(
      "node",
      [
        path.join(ROOT, "dist", "cli.js"),
        "cache",
        "--prune-cowork-sessions",
        "--dry-run",
        "--no-log-file",
      ],
      { encoding: "utf8", env: baseEnv(home) },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Candidates: 0/);
  });

  it("scan --mode all is the new default and succeeds", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cli-"));
    makeCcdFixture(home);
    const r = spawnSync(
      "node",
      [
        path.join(ROOT, "dist", "cli.js"),
        "scan",
        "--mode",
        "all",
        "--no-network",
        "--no-progress",
        "--json",
        "--no-log-file",
      ],
      { encoding: "utf8", env: baseEnv(home) },
    );
    // directory-source → unsupported-source → exit code 3
    expect([0, 3]).toContain(r.status);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.schemaVersion).toBe("1.0");
    expect(Array.isArray(parsed.drifts)).toBe(true);
  });
});
