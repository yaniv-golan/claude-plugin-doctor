/**
 * Unit tests for runVerifyInUi command (phase 8).
 *
 * Interactive mode is not tested here (requires spawning a pty).
 * We test:
 *   - JSON mode (stdin pipe): reads JSON, persists, returns report
 *   - Malformed pluginRef → E_VERIFY_IN_UI_INPUT
 *   - --quiet without --json → E_VERIFY_IN_UI_INPUT
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runVerifyInUi } from "../../../src/commands/verify-in-ui.js";
import { CpdError } from "../../../src/errors.js";

let tmpDir: string;
let originalStdin: NodeJS.ReadStream;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-viu-cmd-"));
  originalStdin = process.stdin;
});

afterEach(() => {
  Object.defineProperty(process, "stdin", { value: originalStdin, writable: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function mockStdin(data: string): void {
  const readable = Readable.from([data]);
  Object.defineProperty(process, "stdin", { value: readable, writable: true });
}

describe("runVerifyInUi — JSON mode", () => {
  it("reads JSON from stdin, persists, and returns a valid report", async () => {
    const input = JSON.stringify({ pluginListed: true, versionShown: "1.2.3" });
    mockStdin(input);

    const report = await runVerifyInUi({
      pluginRefStr: "my-plugin@my-mp",
      json: true,
      stateDir: tmpDir,
    });

    expect(report.schemaVersion).toBe("1.0");
    expect(report.pluginRefKey).toBe("my-plugin@my-mp");
    expect(report.captured.pluginListed).toBe(true);
    expect(report.captured.versionShown).toBe("1.2.3");
    expect(report.captured.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(report.exitCode).toBe(0);
    expect(report.persistedTo).toContain("ui-evidence.json");
    expect(fs.existsSync(report.persistedTo)).toBe(true);
  });

  it("captures all optional fields from JSON input", async () => {
    const input = JSON.stringify({
      pluginListed: true,
      versionShown: "2.0.0",
      updateAvailable: true,
      statusShown: "Installed",
    });
    mockStdin(input);

    const report = await runVerifyInUi({
      pluginRefStr: "plugin@mp",
      json: true,
      stateDir: tmpDir,
    });

    expect(report.captured.versionShown).toBe("2.0.0");
    expect(report.captured.updateAvailable).toBe(true);
    expect(report.captured.statusShown).toBe("Installed");
  });

  it("handles pluginListed: false correctly", async () => {
    mockStdin(JSON.stringify({ pluginListed: false }));

    const report = await runVerifyInUi({
      pluginRefStr: "plugin@mp",
      json: true,
      stateDir: tmpDir,
    });

    expect(report.captured.pluginListed).toBe(false);
    expect(report.captured.versionShown).toBeUndefined();
  });

  it("throws E_VERIFY_IN_UI_INPUT for empty stdin", async () => {
    mockStdin("");

    await expect(
      runVerifyInUi({ pluginRefStr: "plugin@mp", json: true, stateDir: tmpDir }),
    ).rejects.toThrow(CpdError);

    try {
      await runVerifyInUi({ pluginRefStr: "plugin@mp", json: true, stateDir: tmpDir });
    } catch (err) {
      expect((err as CpdError).code).toBe("E_VERIFY_IN_UI_INPUT");
    }
  });

  it("throws E_VERIFY_IN_UI_INPUT for malformed JSON", async () => {
    mockStdin("not-json");

    await expect(
      runVerifyInUi({ pluginRefStr: "plugin@mp", json: true, stateDir: tmpDir }),
    ).rejects.toMatchObject({ code: "E_VERIFY_IN_UI_INPUT" });
  });

  it("throws E_VERIFY_IN_UI_INPUT when stdin JSON is missing pluginListed", async () => {
    mockStdin(JSON.stringify({ versionShown: "1.0" }));

    await expect(
      runVerifyInUi({ pluginRefStr: "plugin@mp", json: true, stateDir: tmpDir }),
    ).rejects.toMatchObject({ code: "E_VERIFY_IN_UI_INPUT" });
  });

  // Audit issue #15: pre-fix this used `Boolean(inp.pluginListed)`, which
  // coerces the literal string "false" to true. The validator only saw the
  // post-coercion boolean, so wrong evidence was persisted with no error.
  it("throws E_VERIFY_IN_UI_INPUT when pluginListed is the string 'false'", async () => {
    mockStdin(JSON.stringify({ pluginListed: "false" }));
    await expect(
      runVerifyInUi({ pluginRefStr: "plugin@mp", json: true, stateDir: tmpDir }),
    ).rejects.toMatchObject({ code: "E_VERIFY_IN_UI_INPUT" });
  });

  it("throws E_VERIFY_IN_UI_INPUT when pluginListed is a number", async () => {
    mockStdin(JSON.stringify({ pluginListed: 1 }));
    await expect(
      runVerifyInUi({ pluginRefStr: "plugin@mp", json: true, stateDir: tmpDir }),
    ).rejects.toMatchObject({ code: "E_VERIFY_IN_UI_INPUT" });
  });
});

describe("runVerifyInUi — malformed pluginRef", () => {
  it("throws E_VERIFY_IN_UI_INPUT for missing @ separator", async () => {
    await expect(
      runVerifyInUi({ pluginRefStr: "badref", json: true, stateDir: tmpDir }),
    ).rejects.toMatchObject({ code: "E_VERIFY_IN_UI_INPUT" });
  });

  it("throws E_VERIFY_IN_UI_INPUT for leading @", async () => {
    await expect(
      runVerifyInUi({ pluginRefStr: "@marketplace", json: true, stateDir: tmpDir }),
    ).rejects.toMatchObject({ code: "E_VERIFY_IN_UI_INPUT" });
  });

  it("throws E_VERIFY_IN_UI_INPUT for trailing @", async () => {
    await expect(
      runVerifyInUi({ pluginRefStr: "plugin@", json: true, stateDir: tmpDir }),
    ).rejects.toMatchObject({ code: "E_VERIFY_IN_UI_INPUT" });
  });
});

describe("runVerifyInUi — quiet without json", () => {
  it("throws E_VERIFY_IN_UI_INPUT", async () => {
    await expect(
      runVerifyInUi({ pluginRefStr: "plugin@mp", json: false, quiet: true, stateDir: tmpDir }),
    ).rejects.toMatchObject({ code: "E_VERIFY_IN_UI_INPUT" });
  });
});

describe("runVerifyInUi — persistence", () => {
  it("writes ui-evidence.json under the given stateDir", async () => {
    mockStdin(JSON.stringify({ pluginListed: true, versionShown: "3.0.0" }));

    const report = await runVerifyInUi({
      pluginRefStr: "p@m",
      json: true,
      stateDir: tmpDir,
    });

    const evidencePath = path.join(tmpDir, "ui-evidence.json");
    expect(report.persistedTo).toBe(evidencePath);
    const raw = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as {
      schemaVersion: string;
      observations: Record<string, unknown>;
    };
    expect(raw.schemaVersion).toBe("1.0");
    expect(raw.observations["p@m"]).toBeDefined();
    const obs = raw.observations["p@m"] as { versionShown: string };
    expect(obs.versionShown).toBe("3.0.0");
  });
});
