import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { type ClaudeCliResult, runClaudeCli } from "../claude-cli.js";
import { CpdError } from "../errors.js";
import { Logger } from "../logger.js";
import { Progress } from "../progress.js";
import { resolveTargetRootForMarketplace } from "../target-root.js";
import type { CheckResult, PluginReport } from "../types.js";
import { type RunScanOpts, runV05Scan } from "./scan.js";

export type RunRefreshOpts = RunScanOpts & {
  marketplaceName: string;
  /** When true, after the marketplace refresh, run `claude plugin update` for any
   * stale plugins whose recommendation cmd is a single `claude plugin update <id>`.
   * Intentionally skips version-trap recommendations (which need a manual
   * `npm version patch` first). */
  autoUpdate?: boolean;
  /** v0.5: bypass the (potentially-broken) `claude plugin marketplace update`
   *  call by running `git fetch && git reset --hard origin/<branch>` directly
   *  on the marketplace clone. The fix for Anthropic issue #46081 (silent-
   *  cooldown / stale-cache absorbed). Backs up `.git/HEAD` and the origin
   *  ref before resetting; only runs when the user passes both `--force-fetch`
   *  AND `--yes` (the latter at the CLI layer). Only applicable to github/git
   *  source marketplaces. */
  forceFetch?: boolean;
  /** Test seam: lets unit tests inject a fake `claude` runner. */
  claudeRunner?: (args: string[]) => Promise<ClaudeCliResult>;
  /** Test seam: inject a fake git runner for force-fetch path. Returns
   *  stdout/stderr/exitCode for each git invocation. */
  gitRunner?: (
    args: string[],
    cwd: string,
  ) => Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string }>;
};

export type RefreshReport = {
  schemaVersion: "1.0";
  marketplace: string;
  before: { layer1: CheckResult; plugins: PluginReport[] };
  /** v0.5: which path performed the refresh. Renderer uses this to label the
   *  "Running:" line. JSON consumers can branch on it for log analysis. */
  refreshMethod: "claude-cli" | "force-fetch";
  claudeUpdate: { ok: boolean; exitCode: number; stderr: string };
  after: { layer1: CheckResult; plugins: PluginReport[] };
  chainedUpdates?: { id: string; ok: boolean; exitCode: number; stderr: string }[];
  exitCode: 0 | 2 | 3;
  runId: string;
  startedAt: string;
  finishedAt: string;
  logFile?: string;
};

function silentProgress(): Progress {
  return new Progress({ enabled: false, isTty: false });
}

/**
 * Combine the post-mutation scan exit code with the success/failure of the
 * mutations themselves (audit issues #3, #4). Either a failed
 * `claude plugin marketplace update` or any failed chained `claude plugin
 * update` lifts the verdict to 3, even when the post-scan is otherwise clean.
 *
 * Exported for unit testing — see `test/unit/refresh-exit-code.test.ts`.
 */
export function computeRefreshExitCode(
  postScanExitCode: 0 | 2 | 3,
  claudeUpdateOk: boolean,
  anyChainFailure: boolean,
): 0 | 2 | 3 {
  return Math.max(postScanExitCode, !claudeUpdateOk ? 3 : 0, anyChainFailure ? 3 : 0) as 0 | 2 | 3;
}

/** Default git runner: spawn the system `git` binary. Tests can override
 *  via opts.gitRunner. Bounded by GIT_FETCH_TIMEOUT_MS so a hung fetch
 *  can't deadlock the refresh path; same pattern as `gitLsRemote` in git.ts. */
const GIT_FETCH_TIMEOUT_MS = 30_000;
function defaultGitRunner(
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result: {
      ok: boolean;
      exitCode: number;
      stdout: string;
      stderr: string;
    }): void => {
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
        stdout: "",
        stderr: `git ${args[0] ?? ""} timed out after ${GIT_FETCH_TIMEOUT_MS}ms`,
      });
    }, GIT_FETCH_TIMEOUT_MS);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      const exitCode = code ?? -1;
      settle({ ok: exitCode === 0, exitCode, stdout, stderr });
    });
    child.on("error", () => {
      settle({ ok: false, exitCode: -1, stdout: "", stderr: "git binary not found" });
    });
  });
}

/** The force-fetch bypass for Anthropic issue #46081. Backs up the prior refs,
 *  fetches origin, and hard-resets the local branch to origin/<default-branch>.
 *
 *  Returns a result object compatible with `claudeUpdate` so the rest of
 *  runRefresh's flow doesn't have to fork. `ok=false` means the bypass itself
 *  failed (network, permissions, ref-not-found); the caller should report
 *  the error and not pretend the refresh worked. */
async function runForceFetch(
  cloneDir: string,
  gitRunner: NonNullable<RunRefreshOpts["gitRunner"]>,
  logger: Logger,
): Promise<{ ok: boolean; exitCode: number; stderr: string }> {
  // 1. Find the default branch via `git symbolic-ref refs/remotes/origin/HEAD`.
  const head = await gitRunner(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cloneDir);
  if (!head.ok) {
    return {
      ok: false,
      exitCode: head.exitCode,
      stderr: `failed to find origin/HEAD: ${head.stderr}`,
    };
  }
  const branch = head.stdout.trim().replace(/^origin\//, "");
  if (!branch) {
    return { ok: false, exitCode: 1, stderr: "could not parse default branch from origin/HEAD" };
  }
  logger.info("force_fetch_branch_resolved", { branch });

  // 2. Back up the current HEAD ref + the remote tracking ref. If the reset
  // does something unexpected, the backup lets the user manually recover.
  // Backups go inside .git/ which is already non-portable state, but
  // outside any tracked path — we name them with a timestamp to avoid
  // collisions across multiple force-fetch runs.
  const backupTs = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(cloneDir, ".git", "cpd-backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const headBackup = path.join(backupDir, `HEAD-${backupTs}`);
  const originBackup = path.join(backupDir, `origin-${branch}-${backupTs}`);
  try {
    const headPath = path.join(cloneDir, ".git", "HEAD");
    if (fs.existsSync(headPath)) fs.copyFileSync(headPath, headBackup);
    const originRef = path.join(cloneDir, ".git", "refs", "remotes", "origin", branch);
    if (fs.existsSync(originRef)) fs.copyFileSync(originRef, originBackup);
    logger.info("force_fetch_backup_written", { headBackup, originBackup });
  } catch (e) {
    return {
      ok: false,
      exitCode: 1,
      stderr: `backup write failed: ${(e as Error).message}`,
    };
  }

  // 3. Fetch origin.
  const fetched = await gitRunner(["fetch", "origin"], cloneDir);
  if (!fetched.ok) {
    return {
      ok: false,
      exitCode: fetched.exitCode,
      stderr: `git fetch failed: ${fetched.stderr}`,
    };
  }

  // 4. Hard-reset to origin/<branch>.
  const reset = await gitRunner(["reset", "--hard", `origin/${branch}`], cloneDir);
  if (!reset.ok) {
    return {
      ok: false,
      exitCode: reset.exitCode,
      stderr: `git reset --hard failed: ${reset.stderr}`,
    };
  }

  return {
    ok: true,
    exitCode: 0,
    stderr: `force-fetched origin/${branch}; backups at ${backupDir}/`,
  };
}

export async function runRefresh(opts: RunRefreshOpts): Promise<RefreshReport> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const logger = opts.logger ?? new Logger({});
  const progress = opts.progress;
  const runner = opts.claudeRunner ?? runClaudeCli;

  // Inner scans use silentProgress so their phase events don't pollute the outer
  // timeline. Agents see exactly three refresh_* phases plus a single scan_done.

  // Resolve which root actually owns the named marketplace and pin the inner
  // scans to it. runV05Scan otherwise picks one root by installed_plugins mtime,
  // which is wrong when the marketplace lives in the other root (the CCD-vs-Cowork
  // bug). Skip auto-resolution when the user explicitly pinned a cowork root via
  // --cowork-account/--cowork-org — honor their intent.
  const userPinnedCowork =
    typeof opts.coworkAccount === "string" && typeof opts.coworkOrg === "string";
  let rootPin: Partial<RunScanOpts> = {};
  if (!userPinnedCowork) {
    const resolved = resolveTargetRootForMarketplace({
      marketplaceName: opts.marketplaceName,
      platform: opts.platform,
      home: opts.home,
      env: opts.env,
    });
    if (resolved.ambiguous) {
      logger.warn("refresh_root_ambiguous", {
        marketplace: opts.marketplaceName,
        searched: resolved.searched,
      });
    }
    if (resolved.directive?.kind === "ccd") {
      rootPin = { mode: "ccd" };
    } else if (resolved.directive?.kind === "cowork") {
      rootPin = {
        mode: "cowork",
        coworkAccount: resolved.directive.accountId,
        coworkOrg: resolved.directive.orgId,
      };
    }
    logger.info("refresh_root_resolved", {
      marketplace: opts.marketplaceName,
      directive: resolved.directive?.kind ?? "none",
    });
  }
  const innerOpts: RunScanOpts = { ...opts, ...rootPin, progress: silentProgress(), logger };

  logger.info("refresh_start", { marketplace: opts.marketplaceName });
  progress?.start("refresh_before_scan");
  const beforeT0 = Date.now();
  const before = await runV05Scan(innerOpts);
  progress?.end("refresh_before_scan", Date.now() - beforeT0);

  const beforeMp = before.marketplaces.find((m) => m.name === opts.marketplaceName);
  if (!beforeMp) {
    throw new CpdError(
      "E_USAGE",
      `Marketplace "${opts.marketplaceName}" is not registered in any plugins root cpd searched. Try \`cpd list\`.`,
    );
  }
  const beforePlugins = before.plugins.filter((p) => p.marketplace === opts.marketplaceName);

  // Branch on forceFetch: standard `claude plugin marketplace update` (default)
  // or the git-fetch-and-reset bypass (--force-fetch). Both produce the same
  // shape of result so the downstream RefreshReport is identical.
  let claudeUpdate: { ok: boolean; exitCode: number; stderr: string };
  if (opts.forceFetch) {
    const cloneDir = (beforeMp.layer1.evidence.cloneDir as string | undefined) ?? "";
    if (!cloneDir || !beforeMp.layer1.evidence.headLocal) {
      throw new CpdError(
        "E_USAGE",
        `Cannot force-fetch "${opts.marketplaceName}": no local clone (it must be a github/git source with an existing clone on disk).`,
      );
    }
    logger.info("force_fetch_start", { marketplace: opts.marketplaceName, cloneDir });
    const updT0 = Date.now();
    progress?.start("refresh_claude_update");
    const gitRunner = opts.gitRunner ?? defaultGitRunner;
    claudeUpdate = await runForceFetch(cloneDir, gitRunner, logger);
    progress?.end("refresh_claude_update", Date.now() - updT0);
    logger.info("force_fetch_done", {
      marketplace: opts.marketplaceName,
      ok: claudeUpdate.ok,
      exitCode: claudeUpdate.exitCode,
    });
  } else {
    logger.info("claude_marketplace_update_start", { marketplace: opts.marketplaceName });
    const updT0 = Date.now();
    progress?.start("refresh_claude_update");
    claudeUpdate = await runner(["plugin", "marketplace", "update", opts.marketplaceName]);
    progress?.end("refresh_claude_update", Date.now() - updT0);
    logger.info("claude_marketplace_update_done", {
      marketplace: opts.marketplaceName,
      ok: claudeUpdate.ok,
      exitCode: claudeUpdate.exitCode,
    });
  }

  // Auto-chain runs BEFORE the final after-scan (audit issue #4). Previously
  // the chain iterated `afterPlugins` and the report's `after` snapshot was
  // captured before chain mutations, so users saw stale diagnostics. Now:
  //   1. claudeUpdate (above) — marketplace-level mutation
  //   2. intermediate scan — drives chain selection (post-marketplace state)
  //   3. chain — per-plugin `claude plugin update <id>` mutations
  //   4. final after scan — what's reported, reflects post-chain state
  //
  // Intermediate runs only when --auto-update is set; otherwise we go
  // straight to the final after-scan and skip the cost.
  let chainedUpdates: RefreshReport["chainedUpdates"];
  let anyChainFailure = false;
  if (opts.autoUpdate) {
    const interT0 = Date.now();
    const intermediate = await runV05Scan(innerOpts);
    logger.info("refresh_intermediate_scan_done", { durationMs: Date.now() - interT0 });

    chainedUpdates = [];
    const interPlugins = intermediate.plugins.filter((p) => p.marketplace === opts.marketplaceName);
    for (const p of interPlugins) {
      const cmd = p.primaryRecommendation?.cmd ?? "";
      // Skip version-trap recommendations: their cmd starts with
      // `(cd <plugin-source> && npm version patch && git push) && ...` and
      // requires a human bump of plugin.json#version, not a chained command.
      if (cmd.startsWith("claude plugin update ")) {
        try {
          const result = await runner(["plugin", "update", p.id]);
          chainedUpdates.push({
            id: p.id,
            ok: result.ok,
            exitCode: result.exitCode,
            stderr: result.stderr,
          });
          if (!result.ok) anyChainFailure = true;
        } catch (e) {
          // Convert thrown errors into structured failure entries so the exit
          // aggregator below sees them — `runner` is allowed to throw on
          // process spawn failure, broken pipe, etc.
          chainedUpdates.push({
            id: p.id,
            ok: false,
            exitCode: -1,
            stderr: (e as Error)?.message ?? String(e),
          });
          anyChainFailure = true;
        }
      }
    }
  }

  const afterT0 = Date.now();
  progress?.start("refresh_after_scan");
  const after = await runV05Scan(innerOpts);
  progress?.end("refresh_after_scan", Date.now() - afterT0);

  const afterMp = after.marketplaces.find((m) => m.name === opts.marketplaceName);
  const afterPlugins = after.plugins.filter((p) => p.marketplace === opts.marketplaceName);

  // Final exit code folds in mutation outcomes alongside the post-mutation
  // scan signal. Previously the report exit code was just `after.exitCode`,
  // so a failed `claude plugin marketplace update` (audit #3) or a failed
  // chained `claude plugin update` (audit #4) followed by a coincidentally-
  // clean post-scan would silently report success. `max(...)` lifts to 3 if
  // any sub-step failed.
  const finalExitCode = computeRefreshExitCode(after.exitCode, claudeUpdate.ok, anyChainFailure);

  const totalMs = Date.now() - startMs;
  logger.info("refresh_done", { exitCode: finalExitCode, durationMs: totalMs });
  progress?.emitDone(totalMs, finalExitCode);

  const logFile = logger.getFilePath();
  return {
    schemaVersion: "1.0",
    marketplace: opts.marketplaceName,
    refreshMethod: opts.forceFetch ? "force-fetch" : "claude-cli",
    before: { layer1: beforeMp.layer1, plugins: beforePlugins },
    claudeUpdate: {
      ok: claudeUpdate.ok,
      exitCode: claudeUpdate.exitCode,
      stderr: claudeUpdate.stderr,
    },
    after: {
      layer1: afterMp?.layer1 ?? beforeMp.layer1,
      plugins: afterPlugins,
    },
    ...(chainedUpdates ? { chainedUpdates } : {}),
    exitCode: finalExitCode,
    runId: logger.getRunId(),
    startedAt,
    finishedAt: new Date().toISOString(),
    ...(logFile !== undefined ? { logFile } : {}),
  };
}
