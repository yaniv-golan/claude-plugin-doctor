/**
 * Persistence module for verify-in-ui evidence — phase 8.
 *
 * Reads/writes ~/.claude-plugin-doctor/state/ui-evidence.json.
 * Source: SPEC-v1.0.md §8.5.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CpdError } from "../errors.js";

export type UiEvidence = {
  schemaVersion: "1.0";
  /** Map from PluginRefKey (or pluginIdString fallback) to evidence. */
  observations: Record<string, UiObservation>;
};

export type UiObservation = {
  pluginListed: boolean;
  versionShown?: string;
  updateAvailable?: boolean;
  statusShown?: string;
  capturedAt: string; // ISO
};

const DEFAULT_STATE_DIR = path.join(os.homedir(), ".claude-plugin-doctor", "state");
const FILE_NAME = "ui-evidence.json";

export function uiEvidencePath(rootDir?: string): string {
  return path.join(rootDir ?? DEFAULT_STATE_DIR, FILE_NAME);
}

/**
 * Read persisted evidence.
 * Returns null when:
 *   - file doesn't exist
 *   - malformed JSON (warns to stderr)
 *   - schemaVersion is unrecognized (warns to stderr)
 */
export function readEvidence(rootDir?: string): UiEvidence | null {
  const filePath = uiEvidencePath(rootDir);
  if (!fs.existsSync(filePath)) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    process.stderr.write(`cpd: warning: could not read ui-evidence file at ${filePath}\n`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write(
      `cpd: warning: ui-evidence file at ${filePath} contains malformed JSON — ignoring\n`,
    );
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || !("schemaVersion" in parsed)) {
    process.stderr.write(
      `cpd: warning: ui-evidence file at ${filePath} is missing schemaVersion — ignoring\n`,
    );
    return null;
  }

  const sv = (parsed as Record<string, unknown>).schemaVersion;
  if (sv !== "1.0") {
    process.stderr.write(
      `cpd: warning: ui-evidence file at ${filePath} has unknown schemaVersion "${String(sv)}" — ignoring (was it written by a newer cpd?)\n`,
    );
    return null;
  }

  const observations = (parsed as Record<string, unknown>).observations ?? {};
  if (typeof observations !== "object" || observations === null) {
    process.stderr.write(
      `cpd: warning: ui-evidence file at ${filePath} has invalid observations field — ignoring\n`,
    );
    return null;
  }

  return {
    schemaVersion: "1.0",
    observations: observations as Record<string, UiObservation>,
  };
}

/**
 * Validates a UiObservation shape before writing.
 * Throws E_UI_EVIDENCE_SCHEMA on invalid input (§10.4.2).
 */
function validateObservation(obs: unknown): asserts obs is UiObservation {
  if (typeof obs !== "object" || obs === null) {
    throw new CpdError(
      "E_UI_EVIDENCE_SCHEMA",
      "UiObservation must be a non-null object.",
      "Expected shape: { pluginListed: boolean, capturedAt: string, versionShown?: string, updateAvailable?: boolean, statusShown?: string }",
    );
  }
  const o = obs as Record<string, unknown>;
  if (typeof o.pluginListed !== "boolean") {
    throw new CpdError(
      "E_UI_EVIDENCE_SCHEMA",
      `UiObservation.pluginListed must be a boolean, got ${typeof o.pluginListed}.`,
    );
  }
  if (typeof o.capturedAt !== "string" || !o.capturedAt) {
    throw new CpdError(
      "E_UI_EVIDENCE_SCHEMA",
      `UiObservation.capturedAt must be a non-empty ISO string, got ${JSON.stringify(o.capturedAt)}.`,
    );
  }
  if (o.versionShown !== undefined && typeof o.versionShown !== "string") {
    throw new CpdError(
      "E_UI_EVIDENCE_SCHEMA",
      `UiObservation.versionShown must be a string or undefined, got ${typeof o.versionShown}.`,
    );
  }
  if (o.updateAvailable !== undefined && typeof o.updateAvailable !== "boolean") {
    throw new CpdError(
      "E_UI_EVIDENCE_SCHEMA",
      `UiObservation.updateAvailable must be a boolean or undefined, got ${typeof o.updateAvailable}.`,
    );
  }
  if (o.statusShown !== undefined && typeof o.statusShown !== "string") {
    throw new CpdError(
      "E_UI_EVIDENCE_SCHEMA",
      `UiObservation.statusShown must be a string or undefined, got ${typeof o.statusShown}.`,
    );
  }
}

/**
 * Persist a single observation; merges into existing file (replaces matching key).
 * Creates the state directory if it doesn't exist.
 * Throws E_UI_EVIDENCE_SCHEMA when the observation shape is invalid.
 */
export function writeObservation(args: {
  pluginRefKeyOrIdString: string;
  observation: UiObservation;
  rootDir?: string;
}): { persistedTo: string } {
  const { pluginRefKeyOrIdString, observation, rootDir } = args;
  // Validate the input shape before writing — emit E_UI_EVIDENCE_SCHEMA on failure.
  validateObservation(observation);
  const stateDir = rootDir ?? DEFAULT_STATE_DIR;
  fs.mkdirSync(stateDir, { recursive: true });

  const filePath = uiEvidencePath(rootDir);

  // Read existing file; if unreadable/missing/schema-mismatch, start fresh.
  const existing = readEvidence(rootDir);
  const observations: Record<string, UiObservation> = existing ? { ...existing.observations } : {};

  observations[pluginRefKeyOrIdString] = observation;

  const evidence: UiEvidence = {
    schemaVersion: "1.0",
    observations,
  };

  fs.writeFileSync(filePath, JSON.stringify(evidence, null, 2), "utf8");
  return { persistedTo: filePath };
}
