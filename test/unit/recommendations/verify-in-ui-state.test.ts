/**
 * Unit tests for verify-in-ui-state persistence module (phase 8).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiObservation } from "../../../src/state/verify-in-ui-state.js";
import {
  readEvidence,
  uiEvidencePath,
  writeObservation,
} from "../../../src/state/verify-in-ui-state.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-ui-state-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const sampleObs: UiObservation = {
  pluginListed: true,
  versionShown: "1.2.3",
  updateAvailable: false,
  statusShown: "Installed",
  capturedAt: "2026-05-01T10:00:00.000Z",
};

describe("uiEvidencePath", () => {
  it("returns a path ending with ui-evidence.json under the given rootDir", () => {
    const p = uiEvidencePath("/some/dir");
    expect(p).toBe("/some/dir/ui-evidence.json");
  });

  it("defaults to ~/.claude-plugin-doctor/state/ui-evidence.json", () => {
    const p = uiEvidencePath();
    expect(p).toContain("ui-evidence.json");
    expect(p).toContain(".claude-plugin-doctor");
  });
});

describe("readEvidence — file missing", () => {
  it("returns null when the file does not exist", () => {
    const result = readEvidence(tmpDir);
    expect(result).toBeNull();
  });
});

describe("readEvidence — malformed JSON", () => {
  it("returns null and warns to stderr for malformed JSON", () => {
    fs.writeFileSync(path.join(tmpDir, "ui-evidence.json"), "not-json", "utf8");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = readEvidence(tmpDir);
    expect(result).toBeNull();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("malformed JSON"));
  });
});

describe("readEvidence — unknown schemaVersion", () => {
  it("returns null and warns to stderr for unknown schemaVersion", () => {
    fs.writeFileSync(
      path.join(tmpDir, "ui-evidence.json"),
      JSON.stringify({ schemaVersion: "99.0", observations: {} }),
      "utf8",
    );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = readEvidence(tmpDir);
    expect(result).toBeNull();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("unknown schemaVersion"));
  });
});

describe("writeObservation + readEvidence round-trip", () => {
  it("persists a single observation and reads it back", () => {
    const { persistedTo } = writeObservation({
      pluginRefKeyOrIdString: "my-plugin@my-mp",
      observation: sampleObs,
      rootDir: tmpDir,
    });

    expect(persistedTo).toBe(path.join(tmpDir, "ui-evidence.json"));
    expect(fs.existsSync(persistedTo)).toBe(true);

    const evidence = readEvidence(tmpDir);
    expect(evidence).not.toBeNull();
    expect(evidence?.schemaVersion).toBe("1.0");
    expect(evidence?.observations["my-plugin@my-mp"]).toEqual(sampleObs);
  });

  it("merges a second observation without dropping the first", () => {
    writeObservation({
      pluginRefKeyOrIdString: "plugin-a@mp",
      observation: sampleObs,
      rootDir: tmpDir,
    });

    const obs2: UiObservation = {
      pluginListed: false,
      capturedAt: "2026-05-02T10:00:00.000Z",
    };
    writeObservation({
      pluginRefKeyOrIdString: "plugin-b@mp",
      observation: obs2,
      rootDir: tmpDir,
    });

    const evidence = readEvidence(tmpDir);
    expect(evidence).not.toBeNull();
    expect(Object.keys(evidence?.observations)).toHaveLength(2);
    expect(evidence?.observations["plugin-a@mp"]).toEqual(sampleObs);
    expect(evidence?.observations["plugin-b@mp"]).toEqual(obs2);
  });

  it("replaces an existing observation for the same key", () => {
    writeObservation({
      pluginRefKeyOrIdString: "my-plugin@mp",
      observation: sampleObs,
      rootDir: tmpDir,
    });

    const updated: UiObservation = {
      pluginListed: true,
      versionShown: "2.0.0",
      capturedAt: "2026-05-03T00:00:00.000Z",
    };
    writeObservation({
      pluginRefKeyOrIdString: "my-plugin@mp",
      observation: updated,
      rootDir: tmpDir,
    });

    const evidence = readEvidence(tmpDir);
    expect(evidence?.observations["my-plugin@mp"]).toEqual(updated);
    expect(Object.keys(evidence?.observations)).toHaveLength(1);
  });

  it("creates the state directory if it doesn't exist", () => {
    const nestedDir = path.join(tmpDir, "nested", "state");
    expect(fs.existsSync(nestedDir)).toBe(false);

    writeObservation({
      pluginRefKeyOrIdString: "p@mp",
      observation: sampleObs,
      rootDir: nestedDir,
    });

    expect(fs.existsSync(nestedDir)).toBe(true);
    expect(fs.existsSync(path.join(nestedDir, "ui-evidence.json"))).toBe(true);
  });
});

describe("readEvidence — valid 1.0 file", () => {
  it("returns parsed UiEvidence for a well-formed 1.0 file", () => {
    fs.writeFileSync(
      path.join(tmpDir, "ui-evidence.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        observations: {
          "my-plugin@mp": sampleObs,
        },
      }),
      "utf8",
    );

    const result = readEvidence(tmpDir);
    expect(result).not.toBeNull();
    expect(result?.schemaVersion).toBe("1.0");
    expect(result?.observations["my-plugin@mp"]).toEqual(sampleObs);
  });
});
