// Subprocess wrapper for the `claude` binary.
//
// Read-side scope: we deliberately do NOT use `claude plugin list` for any
// inventory or drift detection. That subprocess can hang when run inside an
// active Claude Code / Desktop session (Desktop wraps with 60s timeout, exits
// 143 on SIGTERM; `--available` adds per-marketplace network roundtrips —
// Anthropic issue #49627). Inventory comes from `installed-plugins.ts` which
// reads the registry file directly; see that module's header for the full
// rationale.
//
// Write-side scope: this module is invoked by the v0.2 `cpd fix` runner to
// delegate registry mutations to `claude plugin install/update/uninstall` and
// marketplace mutations to `claude plugin marketplace update/remove`. We
// never write to `installed_plugins.json` / `marketplaces/<mp>/` /
// `known_marketplaces.json` ourselves; we shell out. Timeouts and structured
// argv (no string parsing) protect against the official CLI's silent-failure
// exit codes (some `update`/`install` paths return 0 on visible failure).
import { spawn } from "node:child_process";

export type ClaudeCliResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
};

const CLAUDE_TIMEOUT_MS = 60_000;

/**
 * Spawn the `claude` binary with the given args. Async + streamed so we don't
 * block the event loop (the caller's spinner keeps animating). Captures stdout
 * and stderr separately. Times out after 60s.
 */
export function runClaudeCli(args: string[]): Promise<ClaudeCliResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] });

    const settle = (result: ClaudeCliResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      settle({
        ok: false,
        exitCode: -1,
        stdout,
        stderr: `${stderr}\nclaude command timed out after ${CLAUDE_TIMEOUT_MS}ms`,
      });
    }, CLAUDE_TIMEOUT_MS);

    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      settle({
        ok: false,
        exitCode: -1,
        stdout,
        stderr: `${stderr}\n${err.message}`,
      });
    });
    child.on("close", (code) => {
      settle({ ok: code === 0, exitCode: code ?? -1, stdout, stderr });
    });
  });
}
