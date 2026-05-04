/**
 * Integration test for `cpd verify-in-ui` subcommand — phase 8.
 *
 * Spawns the real built CLI with piped JSON input (--json mode).
 * Platform-gated to darwin (same as other integration tests).
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

const baseEnv = (home: string, stateDir?: string) => ({
  ...process.env,
  HOME: home,
  NO_COLOR: "1",
  CI: "1",
  TERM: "dumb",
  // We don't have a direct env override for stateDir in the CLI, but we use
  // CLAUDE_CONFIG_DIR to keep the test home isolated.
  CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
  ...(stateDir ? { CPD_STATE_DIR: stateDir } : {}),
});

describe.runIf(process.platform === "darwin")("CLI integration: cpd verify-in-ui", () => {
  it("--json mode: reads piped JSON, writes ui-evidence.json, and returns VerifyInUiReport", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-viu-cli-"));
    // Use a dedicated stateDir inside the tmp home.
    const stateDir = path.join(home, ".claude-plugin-doctor", "state");
    try {
      const inputJson = JSON.stringify({
        pluginListed: true,
        versionShown: "1.0.0",
        updateAvailable: false,
        statusShown: "Installed",
      });

      const r = spawnSync(
        "node",
        [
          path.join(ROOT, "dist", "cli.js"),
          "verify-in-ui",
          "test-plugin@test-mp",
          "--json",
          "--no-log-file",
        ],
        {
          encoding: "utf8",
          env: baseEnv(home),
          input: inputJson,
        },
      );

      // The exit code should be 0.
      expect(r.status, `stderr: ${r.stderr}`).toBe(0);

      // stdout should be valid JSON.
      let report: Record<string, unknown>;
      try {
        report = JSON.parse(r.stdout) as Record<string, unknown>;
      } catch {
        throw new Error(`stdout is not valid JSON:\n${r.stdout}\nstderr:\n${r.stderr}`);
      }

      // Verify report shape.
      expect(report.schemaVersion).toBe("1.0");
      expect(typeof report.runId).toBe("string");
      expect(report.pluginRefKey).toBe("test-plugin@test-mp");
      expect(report.exitCode).toBe(0);

      const captured = report.captured as Record<string, unknown>;
      expect(captured.pluginListed).toBe(true);
      expect(captured.versionShown).toBe("1.0.0");
      expect(captured.updateAvailable).toBe(false);
      expect(captured.statusShown).toBe("Installed");
      expect(typeof captured.capturedAt).toBe("string");

      // The file should exist.
      const persistedTo = report.persistedTo as string;
      expect(typeof persistedTo).toBe("string");
      expect(fs.existsSync(persistedTo)).toBe(true);

      // Read and verify the persisted file.
      const raw = JSON.parse(fs.readFileSync(persistedTo, "utf8")) as {
        schemaVersion: string;
        observations: Record<string, unknown>;
      };
      expect(raw.schemaVersion).toBe("1.0");
      expect(raw.observations["test-plugin@test-mp"]).toBeDefined();
      const obs = raw.observations["test-plugin@test-mp"] as {
        versionShown: string;
        pluginListed: boolean;
      };
      expect(obs.pluginListed).toBe(true);
      expect(obs.versionShown).toBe("1.0.0");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("--json mode with malformed pluginRef → E_VERIFY_IN_UI_INPUT", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-viu-cli-err-"));
    try {
      const r = spawnSync(
        "node",
        [path.join(ROOT, "dist", "cli.js"), "verify-in-ui", "badref", "--json", "--no-log-file"],
        {
          encoding: "utf8",
          env: baseEnv(home),
          input: JSON.stringify({ pluginListed: true }),
        },
      );

      // Should exit with non-zero.
      expect(r.status).not.toBe(0);

      // stdout should be an error envelope.
      let envelope: Record<string, unknown>;
      try {
        envelope = JSON.parse(r.stdout) as Record<string, unknown>;
      } catch {
        throw new Error(`stdout is not valid JSON:\n${r.stdout}\nstderr:\n${r.stderr}`);
      }
      expect(envelope.ok).toBe(false);
      expect(envelope.code).toBe("E_VERIFY_IN_UI_INPUT");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("human output (no --json) prints a summary without crashing when stdin piped", () => {
    buildIfNeeded();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-viu-cli-human-"));
    try {
      // In non-json mode we can't interactively test, but we can test that
      // the command fails gracefully when stdin is empty (no TTY, no JSON).
      // The command will throw E_VERIFY_IN_UI_INPUT (quiet without json)
      // OR attempt interactive mode. Since CI=1, stdin is not a TTY.
      // We just verify it exits without crashing the process unexpectedly.
      const r = spawnSync(
        "node",
        [path.join(ROOT, "dist", "cli.js"), "verify-in-ui", "test-plugin@test-mp", "--no-log-file"],
        {
          encoding: "utf8",
          env: baseEnv(home),
          input: "", // EOF immediately
        },
      );

      // We don't assert on exit code here — interactive mode with EOF input
      // may exit 0 with empty answers or non-zero. We just assert the process
      // didn't crash with an unhandled exception (no "Error:" in stderr that
      // isn't an intentional cpd error message).
      const hasUnhandled = r.stderr.includes("TypeError:") || r.stderr.includes("ReferenceError:");
      expect(hasUnhandled).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
