/**
 * `cpd verify-in-ui` command — phase 8.
 *
 * Interactive walkthrough that captures what the user sees in Claude Desktop's
 * Settings → Plugins UI, persists the evidence, and returns a VerifyInUiReport.
 *
 * Source: SPEC-v1.0.md §8.4, §10.4.6.
 */

import { randomUUID } from "node:crypto";
import * as readline from "node:readline/promises";
import { CpdError } from "../errors.js";
import { writeObservation } from "../state/verify-in-ui-state.js";
import type { VerifyInUiReport } from "../types.js";

export type VerifyInUiArgs = {
  /** "<plugin>@<marketplace>" form from CLI argv. */
  pluginRefStr: string;
  json: boolean;
  quiet?: boolean;
  logFile?: string | undefined;
  /** Override for state directory (used in tests). */
  stateDir?: string;
  /** Optional progress sink for phase events (spec §10.4.3). */
  progress?: import("../progress.js").Progress;
};

/** JSON input shape for --json / agent-automation mode. */
type JsonModeInput = {
  pluginListed: boolean;
  versionShown?: string;
  updateAvailable?: boolean;
  statusShown?: string;
};

function parsePluginRef(str: string): { pluginName: string; marketplace: string } | null {
  const at = str.lastIndexOf("@");
  if (at <= 0 || at === str.length - 1) return null;
  const pluginName = str.slice(0, at).trim();
  const marketplace = str.slice(at + 1).trim();
  if (!pluginName || !marketplace) return null;
  return { pluginName, marketplace };
}

function promptYesNo(answer: string, defaultYes: boolean): boolean {
  const normalized = answer.trim().toLowerCase();
  if (!normalized) return defaultYes;
  return normalized === "y" || normalized === "yes";
}

export async function runVerifyInUi(args: VerifyInUiArgs): Promise<VerifyInUiReport> {
  const runId = randomUUID();

  // 1. Parse plugin ref.
  const parsed = parsePluginRef(args.pluginRefStr);
  if (!parsed) {
    throw new CpdError(
      "E_VERIFY_IN_UI_INPUT",
      `Invalid plugin reference: "${args.pluginRefStr}". Expected "<plugin>@<marketplace>" format.`,
      "Example: cpd verify-in-ui my-plugin@my-marketplace",
    );
  }
  const { pluginName, marketplace } = parsed;

  // Build a simplified pluginRefKey (no root suffix — verify-in-ui is cross-root).
  const pluginRefKey = `${pluginName}@${marketplace}`;

  let pluginListed: boolean;
  let versionShown: string | undefined;
  let updateAvailable: boolean | undefined;
  let statusShown: string | undefined;

  if (args.json) {
    // Non-interactive mode: read JSON from stdin.
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) {
      throw new CpdError(
        "E_VERIFY_IN_UI_INPUT",
        "--json mode requires JSON piped to stdin but stdin was empty.",
        "Pipe input like: echo '{\"pluginListed\":true}' | cpd verify-in-ui plugin@mp --json",
      );
    }
    let inputData: unknown;
    try {
      inputData = JSON.parse(raw);
    } catch {
      throw new CpdError(
        "E_VERIFY_IN_UI_INPUT",
        `--json mode: could not parse stdin as JSON: ${raw.slice(0, 200)}`,
      );
    }
    if (typeof inputData !== "object" || inputData === null || !("pluginListed" in inputData)) {
      throw new CpdError(
        "E_VERIFY_IN_UI_INPUT",
        '--json mode: input must be a JSON object with at least {"pluginListed": boolean}.',
      );
    }
    const inp = inputData as JsonModeInput;
    // Strict type check: `Boolean(inp.pluginListed)` would coerce the string
    // "false" to true (audit issue #15). The downstream `validateObservation`
    // only sees the post-coercion value, so the validator never catches the
    // error. Reject non-booleans here at the boundary.
    if (typeof inp.pluginListed !== "boolean") {
      throw new CpdError(
        "E_VERIFY_IN_UI_INPUT",
        `--json mode: \`pluginListed\` must be a boolean, got ${typeof inp.pluginListed} (${JSON.stringify(inp.pluginListed)}).`,
      );
    }
    pluginListed = inp.pluginListed;
    versionShown = typeof inp.versionShown === "string" ? inp.versionShown : undefined;
    updateAvailable = typeof inp.updateAvailable === "boolean" ? inp.updateAvailable : undefined;
    statusShown = typeof inp.statusShown === "string" ? inp.statusShown : undefined;
  } else if (args.quiet) {
    // --quiet without --json: error (no way to get input).
    throw new CpdError(
      "E_VERIFY_IN_UI_INPUT",
      "--quiet mode suppresses prompts. Pipe JSON input and use --json instead.",
    );
  } else {
    // Interactive mode.
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      // Intro.
      process.stdout.write(
        `\nOpen Claude Desktop → Settings → Plugins → "${marketplace}". ` +
          `Look for "${pluginName}" in the plugin list.\n\n`,
      );

      // Q1.
      const q1 = await rl.question(`Is "${pluginName}" in the plugin list? [Y/n] `);
      pluginListed = promptYesNo(q1, true);

      if (pluginListed) {
        // Q2.
        const q2 = await rl.question("What version is shown? ");
        versionShown = q2.trim() || undefined;

        // Q3.
        const q3 = await rl.question("Is there an 'Update available' badge? [Y/n] ");
        updateAvailable = promptYesNo(q3, true);

        // Q4.
        const q4 = await rl.question("Status shown (Installed / Available / ...): ");
        statusShown = q4.trim() || undefined;
      }
    } finally {
      rl.close();
    }
  }

  const capturedAt = new Date().toISOString();

  // Emit verify_in_ui_capture phase event (spec §10.4.3).
  const captureStartMs = Date.now();
  args.progress?.start("verify_in_ui_capture");

  // 4. Persist.
  const observation = {
    pluginListed,
    ...(versionShown !== undefined ? { versionShown } : {}),
    ...(updateAvailable !== undefined ? { updateAvailable } : {}),
    ...(statusShown !== undefined ? { statusShown } : {}),
    capturedAt,
  };

  const { persistedTo } = writeObservation({
    pluginRefKeyOrIdString: pluginRefKey,
    observation,
    ...(args.stateDir !== undefined ? { rootDir: args.stateDir } : {}),
  });

  args.progress?.end("verify_in_ui_capture", Date.now() - captureStartMs);

  // 5. Build report.
  const report: VerifyInUiReport = {
    schemaVersion: "1.0",
    runId,
    pluginRefKey,
    captured: {
      pluginListed,
      ...(versionShown !== undefined ? { versionShown } : {}),
      ...(updateAvailable !== undefined ? { updateAvailable } : {}),
      ...(statusShown !== undefined ? { statusShown } : {}),
      capturedAt,
    },
    persistedTo,
    exitCode: 0,
    ...(args.logFile !== undefined ? { logFile: args.logFile } : {}),
  };

  return report;
}
