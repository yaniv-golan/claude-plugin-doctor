/**
 * Integration tests for the friendly missing-required-argument errors on
 * subcommands that take a positional `<pluginAtMarketplace>` or
 * `<marketplaceName>`. The default Commander error is a generic one-liner
 * (`error: missing required argument 'pluginAtMarketplace'`) that doesn't
 * help users discover the right invocation. cpd's `requireArg` helper in
 * `src/cli.ts` produces a multi-line message with examples + a hint.
 *
 * One test per affected command (check, refresh, verify-in-ui, watch).
 */

import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function buildIfNeeded(): void {
  if (!fs.existsSync(path.join(ROOT, "dist", "cli.js"))) {
    execSync("npm run build", { cwd: ROOT, stdio: "ignore" });
  }
}

function runCpd(args: string[]): { stdout: string; stderr: string; status: number | null } {
  buildIfNeeded();
  const r = spawnSync("node", [path.join(ROOT, "dist", "cli.js"), ...args], {
    encoding: "utf8",
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

describe("missing-arg UX", () => {
  it("`cpd check` (no arg) emits a friendly error with examples + hint, exits 64", () => {
    const r = runCpd(["check"]);
    expect(r.status).toBe(64);
    expect(r.stderr).toMatch(/cpd: error: missing required argument <pluginAtMarketplace>/);
    expect(r.stderr).toMatch(/Examples:/);
    expect(r.stderr).toMatch(/cpd check .+@.+/);
    expect(r.stderr).toMatch(/cpd list/);
    expect(r.stderr).toMatch(/whole-system scan/);
    // Must NOT be the raw Commander generic message.
    expect(r.stderr).not.toMatch(/^error: missing required argument 'pluginAtMarketplace'/m);
  });

  it("`cpd refresh` (no arg) emits a friendly error, exits 64", () => {
    const r = runCpd(["refresh"]);
    expect(r.status).toBe(64);
    expect(r.stderr).toMatch(/cpd: error: missing required argument <marketplaceName>/);
    expect(r.stderr).toMatch(/Examples:/);
    expect(r.stderr).toMatch(/cpd refresh \w+/);
    expect(r.stderr).toMatch(/cpd list/);
  });

  it("`cpd verify-in-ui` (no arg) emits a friendly error, exits 64", () => {
    const r = runCpd(["verify-in-ui"]);
    expect(r.status).toBe(64);
    expect(r.stderr).toMatch(/cpd: error: missing required argument <pluginAtMarketplace>/);
    expect(r.stderr).toMatch(/Examples:/);
    expect(r.stderr).toMatch(/cpd verify-in-ui/);
  });

  it("`cpd watch` (no arg) emits a friendly error, exits 64", () => {
    const r = runCpd(["watch"]);
    expect(r.status).toBe(64);
    expect(r.stderr).toMatch(/cpd: error: missing required argument <pluginAtMarketplace>/);
    expect(r.stderr).toMatch(/Examples:/);
    expect(r.stderr).toMatch(/cpd watch/);
    expect(r.stderr).toMatch(/cpd list/);
  });

  it("`cpd check <plugin>@<mp>` (with arg) does NOT trigger the friendly-error path", () => {
    // Use a non-existent plugin — cpd will produce its normal not-installed
    // output (or topology), but the missing-arg error must NOT fire.
    const r = runCpd([
      "check",
      "no-such-plugin@no-such-mp",
      "--json",
      "--no-progress",
      "--no-log-file",
    ]);
    expect(r.stderr).not.toMatch(/missing required argument/);
  });
});
