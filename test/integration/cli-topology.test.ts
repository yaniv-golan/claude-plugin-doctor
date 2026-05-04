/**
 * Integration test for `cpd topology` subcommand.
 *
 * Spawns the real built CLI against a synthetic Claude userData tree under a
 * fresh tmpdir. Gated to darwin (same as the existing CLI integration tests)
 * because topology relies on platform-specific path resolution.
 */

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

/**
 * Creates a synthetic Claude userData tree under `home`:
 *   ~/.claude/plugins/           — CCD root
 *   ~/Library/Application Support/Claude/local-agent-mode-sessions/
 *     acc1/org1/                 — cowork root
 *     acc1/org2/cowork_plugins/  — cowork root with installed_plugins.json
 *     skills-plugin/org1/acc1/   — skills-plugin pair
 *     acc1/local_<UUID>/         — session-local dir
 */
function makeFullFixture(home: string) {
  // CCD root
  const ccdPlugins = path.join(home, ".claude", "plugins");
  fs.mkdirSync(ccdPlugins, { recursive: true });
  fs.writeFileSync(
    path.join(ccdPlugins, "known_marketplaces.json"),
    JSON.stringify({
      "test-mp": { source: { source: "directory", path: "/tmp/test-mp" } },
    }),
  );

  // userData dir
  const sessions = path.join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "local-agent-mode-sessions",
  );

  // Cowork root 1 (no installed_plugins.json)
  fs.mkdirSync(path.join(sessions, "acc1", "org1"), { recursive: true });

  // Cowork root 2 (has cowork_plugins + installed_plugins.json)
  const cp2 = path.join(sessions, "acc1", "org2", "cowork_plugins");
  fs.mkdirSync(cp2, { recursive: true });
  fs.writeFileSync(
    path.join(cp2, "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: {} }),
  );

  // skills-plugin
  fs.mkdirSync(path.join(sessions, "skills-plugin", "org1", "acc1", "skills"), {
    recursive: true,
  });

  // session-local dir
  fs.mkdirSync(path.join(sessions, "acc1", "local_550e8400-e29b-41d4-a716-446655440000"), {
    recursive: true,
  });
}

const baseEnv = (home: string) => ({
  ...process.env,
  HOME: home,
  NO_COLOR: "1",
  CI: "1",
  TERM: "dumb",
});

describe.runIf(process.platform === "darwin")("CLI integration: cpd topology", () => {
  it("--json emits a parseable TopologyReport with schemaVersion 1.0", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-topo-cli-"));
    try {
      makeFullFixture(home);

      const r = spawnSync(
        "node",
        [
          path.join(ROOT, "dist", "cli.js"),
          "topology",
          "--json",
          "--no-network",
          "--no-progress",
          "--no-log-file",
        ],
        { encoding: "utf8", env: baseEnv(home) },
      );

      expect(r.status).toBe(0);

      let parsed: unknown;
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        throw new Error(`stdout is not valid JSON:\n${r.stdout}\nstderr:\n${r.stderr}`);
      }

      const report = parsed as Record<string, unknown>;
      expect(report.schemaVersion).toBe("1.0");
      expect(report.exitCode).toBe(0);
      expect(typeof report.runId).toBe("string");
      expect(report.runId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );

      const topology = report.topology as Record<string, unknown>;
      expect(topology).not.toBeUndefined();
      expect(typeof topology.scannedAt).toBe("string");

      // CCD root should be present.
      expect(topology.ccd).not.toBeUndefined();

      // Two cowork roots.
      expect(Array.isArray(topology.cowork)).toBe(true);
      expect((topology.cowork as unknown[]).length).toBe(2);

      // Skills-plugin present.
      expect(topology.skillsPlugin).not.toBeUndefined();

      // One session-local dir.
      expect(Array.isArray(topology.sessionLocals)).toBe(true);
      expect((topology.sessionLocals as unknown[]).length).toBe(1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("human output (no --json) prints a topology summary without crashing", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-topo-cli-human-"));
    try {
      makeFullFixture(home);

      const r = spawnSync(
        "node",
        [
          path.join(ROOT, "dist", "cli.js"),
          "topology",
          "--no-network",
          "--no-progress",
          "--no-log-file",
        ],
        { encoding: "utf8", env: baseEnv(home) },
      );

      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/Topology:/);
      expect(r.stdout).toMatch(/Standalone Claude Code/);
      expect(r.stdout).toMatch(/Claude Cowork roots/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("exits 0 when no roots are found", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-topo-cli-empty-"));
    try {
      // No fixtures — empty machine.
      const r = spawnSync(
        "node",
        [
          path.join(ROOT, "dist", "cli.js"),
          "topology",
          "--json",
          "--no-network",
          "--no-progress",
          "--no-log-file",
        ],
        { encoding: "utf8", env: baseEnv(home) },
      );

      expect(r.status).toBe(0);
      const report = JSON.parse(r.stdout) as Record<string, unknown>;
      expect(report.exitCode).toBe(0);
      expect(report.schemaVersion).toBe("1.0");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
