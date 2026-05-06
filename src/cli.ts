#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command, Option } from "commander";
import { runCacheOrphans, runCachePrune } from "./commands/cache.js";
import { runV05Check } from "./commands/check.js";
import { runExplain } from "./commands/explain.js";
import { runList } from "./commands/list.js";
import { runRefresh } from "./commands/refresh.js";
import { runScan } from "./commands/scan.js";
import { runTopology } from "./commands/topology.js";
import { runVerifyInUi } from "./commands/verify-in-ui.js";
import { runWatch } from "./commands/watch.js";
import { CpdError } from "./errors.js";
import { HELP_EPILOG } from "./help.js";
import { defaultLogPath, Logger } from "./logger.js";
import {
  humanBytes,
  renderHuman,
  renderHumanCheck,
  renderHumanList,
  renderHumanRefresh,
} from "./output/human.js";
import { renderJson, renderJsonCheck, renderJsonList, renderJsonRefresh } from "./output/json.js";
import { formatVerboseLine } from "./output/verbose.js";
import { Progress } from "./progress.js";
import type { LogLevel } from "./types.js";

const VERSION = "0.1.0";

const program = new Command();
program
  .name("claude-plugin-doctor")
  .description("Diagnose drift across the six cache layers of the Claude plugin system.")
  .version(VERSION)
  .addHelpText("after", HELP_EPILOG)
  // Commander's built-in error path exits 1 by default. We catch its
  // CommanderError in the .catch() at the bottom so usage errors (missing
  // required argument, unknown option) can exit 64 per HELP_EPILOG.
  .exitOverride();

/**
 * Validate that a positional argument was supplied. When missing, prints a
 * friendly multi-line error to stderr (subcommand-specific examples + a
 * hint pointing at related commands) and exits 64 (E_USAGE per the rest
 * of cli.ts and HELP_EPILOG).
 *
 * The four commands that take a single positional arg (`check`,
 * `verify-in-ui`, `watch` for `<pluginAtMarketplace>`; `refresh` for
 * `<marketplaceName>`) all use this. Their Commander syntax declares the
 * arg as **optional** (`[name]`) so Commander's own generic-error path
 * doesn't fire — this helper produces the actual error.
 *
 * @param argName the placeholder name shown in the error (matches the
 *   commander syntax, e.g. "pluginAtMarketplace" or "marketplaceName")
 * @param value the positional arg as Commander parsed it (undefined when
 *   the user didn't supply one)
 * @param examples 2-3 invocation examples, without the leading "cpd "
 * @param hint short pointer to a related command (e.g.
 *   "Run `cpd list` to see installed plugins")
 */
function requireArg(
  argName: string,
  value: string | undefined,
  examples: string[],
  hint: string,
): asserts value is string {
  if (typeof value === "string" && value.length > 0) return;
  const exLines = examples.map((e) => `    cpd ${e}`).join("\n");
  process.stderr.write(
    `cpd: error: missing required argument <${argName}>\n` +
      `  Examples:\n${exLines}\n` +
      `  ${hint}\n`,
  );
  process.exit(64);
}

// Shared options for any command that runs a scan.
function addScanOptions(cmd: Command): Command {
  return cmd
    .option("--no-network", "skip git ls-remote and any backend probing")
    .addOption(
      new Option("--mode <mode>", "force scan mode (default: all walks every root)")
        .choices(["all", "ccd", "cowork", "auto"])
        .default("all"),
    )
    .option("--root <accId:orgId>", "filter multi-root scan to a specific cowork root (acc:org)")
    .option("--cowork-account <id>", "pin to a specific cowork account")
    .option("--cowork-org <id>", "pin to a specific cowork org")
    .option("--max-concurrency <n>", "max parallel upstream probes (default: 8)", "8")
    .option("--json", "emit machine-readable JSON to stdout (one document)")
    .option("--ndjson-events", "stream NDJSON progress events to stderr (or to --events-file)")
    .option("--events-file <path>", "redirect --ndjson-events to a file instead of stderr")
    .option("--log-file <path>", "override default log file location")
    .option("--no-log-file", "do not write a log file at all")
    .addOption(
      new Option("--log-level <level>", "minimum level for log file")
        .choices(["trace", "debug", "info", "warn", "error"])
        .default("info"),
    )
    .option("--no-progress", "disable spinner / progress lines on stderr")
    .option("--no-color", "disable ANSI colors (NO_COLOR env also honored)")
    .option("-v, --verbose", "stream per-event prose to stderr (probes, fetches, drifts, plans)")
    .option(
      "-q, --quiet",
      "minimal output: silence progress and the human report (use with `--json` to keep JSON; otherwise check the exit code)",
    )
    .option(
      "--ui-evidence-max-age <days>",
      "max age in days for persisted UI evidence before flagging as stale",
      "7",
    );
}

addScanOptions(
  program
    .command("scan", { isDefault: true })
    .description("Walk every cache layer for every marketplace and every installed plugin.")
    .option("--no-skills-plugin", "exclude the skills-plugin layer from the snapshot loop")
    .option(
      "--with-skills-plugin",
      "include the skills-plugin layer (default; inverse of --no-skills-plugin)",
    )
    .option(
      "--show-runtime-boundary",
      "always show the 'changes that need a fresh task or restart' section, even when none are present",
    )
    // Reject extra positional args. Commander v12 with `isDefault: true`
    // silently treats unknown subcommand names as positional args to scan
    // (e.g., `cpd nonexistent-subcommand` would silently run scan). With
    // strict excess-argument checking, that becomes an explicit E_USAGE.
    .allowExcessArguments(false),
).action(async (opts: Record<string, unknown>) => {
  await runScanCommand(opts);
});

addScanOptions(
  program
    .command("check [pluginAtMarketplace]")
    .description("Drift report for a single plugin across all six layers."),
).action(async (id: string | undefined, opts: Record<string, unknown>) => {
  requireArg(
    "pluginAtMarketplace",
    id,
    ["check founder-skills@lool-founder-skills", "check pdf@anthropic-skills"],
    "Run `cpd list` to see installed plugins, or plain `cpd` for a whole-system scan.",
  );
  await runCheckCommand(id, opts);
});

addScanOptions(
  program
    .command("refresh [marketplaceName]")
    .description("Run `claude plugin marketplace update <mp>` and show the before/after drift.")
    .option("--auto-update", "after refresh, also run `claude plugin update` for stale plugins")
    .option(
      "--force-fetch",
      "Bypass the (sometimes-broken) `claude plugin marketplace update` and run `git fetch && git reset --hard origin/<branch>` directly on the marketplace clone. Workaround for the silent-cooldown bug (Anthropic issue #46081). Requires --yes; backs up .git/HEAD and origin ref before resetting.",
    )
    .option("-y, --yes", "skip confirmation for destructive actions (required for --force-fetch)"),
).action(async (mpName: string | undefined, opts: Record<string, unknown>) => {
  requireArg(
    "marketplaceName",
    mpName,
    ["refresh lool-founder-skills", "refresh anthropic --auto-update"],
    "Run `cpd list` to see registered marketplace names.",
  );
  await runRefreshCommand(mpName, opts);
});

addScanOptions(
  program
    .command("list")
    .description(
      "Inventory: marketplaces, plugins, Claude Cowork session roots, in-app plugin installs.",
    ),
).action(async (opts: Record<string, unknown>) => {
  await runListCommand(opts);
});

program
  .command("explain")
  .description("Print the six-layer architecture cheat-sheet.")
  .action(() => {
    writeStdoutSync(runExplain());
  });

program
  .command("cache")
  .description("Inspect and prune local caches (session dirs, install snapshots).")
  .option(
    "--prune-cowork-sessions",
    "reap stale local_<UUID>/ and local_ditto_*_g<N>/ session directories",
  )
  .option(
    "--orphans",
    "list install-snapshot dirs not referenced by any installed_plugins.json (read-only)",
  )
  .option("--older-than <days>", "only consider dirs older than this many days (default: 14)", "14")
  .option("--force", "bypass lockfile check (still respects 30-min active-session heuristic)")
  .option("--dry-run", "list candidates but do not delete (default without --yes)")
  .option(
    "-y, --yes",
    "confirm deletion (required for actual deletion with --prune-cowork-sessions)",
  )
  .option("--json", "emit machine-readable JSON to stdout")
  .option("--log-file <path>", "override default log file location")
  .option("--no-log-file", "do not write a log file at all")
  .option("--no-progress", "disable spinner / progress lines on stderr")
  .option("--no-color", "disable ANSI colors (NO_COLOR env also honored)")
  .option("-v, --verbose", "stream per-event prose to stderr")
  .option(
    "-q, --quiet",
    "minimal output: silence progress and the human report (use with `--json` to keep JSON; otherwise check the exit code)",
  )
  .action(async (opts: Record<string, unknown>) => {
    await runCacheCommand(opts);
  });

addScanOptions(
  program
    .command("topology")
    .description(
      "Show the discovered installation layout (standalone Claude Code root, Claude Cowork session roots, built-in skills, session-local plugin dirs). Debug subcommand.",
    ),
).action(async (opts: Record<string, unknown>) => {
  await runTopologyCommand(opts);
});

program
  .command("verify-in-ui [pluginAtMarketplace]")
  .description(
    "Capture what Claude Desktop's Settings UI shows for a plugin and persist the evidence.",
  )
  .addHelpText(
    "after",
    `
With --json, reads observation JSON from stdin. Required field:
  pluginListed: boolean

Optional fields:
  versionShown: string
  updateAvailable: boolean
  statusShown: string

Example:
  echo '{"pluginListed":true,"versionShown":"0.4.1"}' | cpd verify-in-ui my-plugin@my-mp --json
`,
  )
  .option("--json", "non-interactive mode: read evidence JSON from stdin")
  .option("-q, --quiet", "suppress prompts (errors out unless --json with piped input)")
  .option("--log-file <path>", "override default log file location")
  .option("--no-log-file", "do not write a log file at all")
  .action(async (id: string | undefined, opts: Record<string, unknown>) => {
    requireArg(
      "pluginAtMarketplace",
      id,
      [
        "verify-in-ui my-plugin@my-mp",
        `echo '{"pluginListed":true}' | cpd verify-in-ui my-plugin@my-mp --json`,
      ],
      "Run `cpd list` to see installed plugins.",
    );
    await runVerifyInUiCommand(id, opts);
  });

addScanOptions(
  program
    .command("watch [pluginAtMarketplace]")
    .description("File-watch a plugin's source dir; re-check on each change.")
    .option(
      "--interval <ms>",
      "minimum ms between re-checks after a debounced burst of fs events",
      "500",
    ),
).action(async (id: string | undefined, opts: Record<string, unknown>) => {
  requireArg(
    "pluginAtMarketplace",
    id,
    ["watch founder-skills@lool-founder-skills"],
    "Run `cpd list` to see installed plugins. `watch` is intended for plugin authors editing a directory-source plugin.",
  );
  await runWatchCommand(id, opts);
});

function isTtyStdout(): boolean {
  return process.stdout.isTTY === true;
}
function isTtyStderr(): boolean {
  return process.stderr.isTTY === true;
}

/**
 * Synchronous, full-write to stdout (fd 1).
 *
 * Why this exists: `process.stdout.write()` is async — when stdout is a pipe
 * and the consumer hasn't drained, writes are queued internally and lost when
 * `process.exit()` fires before the queue flushes. This caused a bug where
 * `cpd scan --json | jq ...` truncated at 64KB on macOS (the default pipe
 * buffer size) for any user with >100 drifts.
 *
 * `writeStdoutSync(...)` looks like a fix but isn't sufficient on its own:
 * stdout when piped is configured O_NONBLOCK by Node, so `fs.writeSync` may
 * return a partial-write count when the pipe buffer fills. The caller MUST
 * loop until everything is written, retrying on EAGAIN.
 *
 * This helper implements that loop. Use it for any stdout payload that can
 * exceed the pipe-buffer size (~64KB on macOS, ~16KB on Linux). Stderr's
 * `fs.writeSync(2, ...)` calls elsewhere in the file are line-sized and don't
 * need this treatment.
 */
function writeStdoutSync(content: string): void {
  const buf = Buffer.from(content);
  let written = 0;
  while (written < buf.length) {
    try {
      const n = fs.writeSync(1, buf, written, buf.length - written);
      if (n <= 0) break; // defensive — shouldn't happen in practice
      written += n;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EWOULDBLOCK") {
        // Pipe buffer full; brief sleep then retry. Synchronous spin is OK
        // here because we're at terminal-output time and the consumer is
        // actively reading.
        const start = Date.now();
        while (Date.now() - start < 1) {
          /* spin */
        }
        continue;
      }
      throw e;
    }
  }
}

function resolveLogFile(opts: Record<string, unknown>, home: string): string | undefined {
  if (opts.logFile === false) return undefined;
  if (typeof opts.logFile === "string") return opts.logFile;
  return defaultLogPath(home);
}

type RunContext = {
  home: string;
  colorEnabled: boolean;
  /** Same gates as `colorEnabled`, but tied to stderr's TTY status. Used by
   *  `watch` (and any future command that renders to stderr). */
  colorEnabledStderr: boolean;
  logger: Logger;
  progress: Progress;
  logFilePath: string | undefined;
  finalize: (exitCode: number) => void;
  mode: "all" | "auto" | "ccd" | "cowork";
};

function setupRunContext(opts: Record<string, unknown>): RunContext {
  const home = os.homedir();
  const noColorEnv = process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "";
  const inCi = process.env.CI === "true" || process.env.CI === "1";
  const dumbTerm = process.env.TERM === "dumb";
  const colorEnabled = opts.color !== false && !noColorEnv && isTtyStdout() && !dumbTerm;
  const colorEnabledStderr = opts.color !== false && !noColorEnv && isTtyStderr() && !dumbTerm;
  const progressEnabled =
    opts.progress !== false && !opts.quiet && !inCi && isTtyStderr() && !dumbTerm;

  const logFilePath = resolveLogFile(opts, home);
  const validLevels = new Set<LogLevel>(["trace", "debug", "info", "warn", "error"]);
  const fileLevel: LogLevel =
    typeof opts.logLevel === "string" && validLevels.has(opts.logLevel as LogLevel)
      ? (opts.logLevel as LogLevel)
      : "info";
  // `--verbose` no longer mirrors raw NDJSON to stderr (the universally
  // awkward "JSON under -v" pattern that kubectl/terraform/gh all avoid).
  // Instead, plumb a `humanWriter` that renders each log event as one-line
  // prose tagged by subsystem. The full NDJSON debug stream still goes to
  // the log file — machine consumers use `--ndjson-events` or the log file.
  const verboseWriter = opts.verbose
    ? (msg: string, fields: Record<string, unknown>, level: LogLevel): void => {
        const line = formatVerboseLine(msg, fields, level);
        if (line === undefined) return;
        try {
          fs.writeSync(2, `${line}\n`);
        } catch {
          // never throw from a log sink
        }
      }
    : undefined;
  const logger = new Logger({
    ...(logFilePath ? { filePath: logFilePath } : {}),
    fileLevel,
    ...(verboseWriter ? { humanWriter: verboseWriter } : {}),
  });

  // B2: suppress the early "writing log to ..." notice when:
  //   - stdout is a TTY (the bottom-of-report Log file line is sufficient)
  //   - --ndjson-events is set (would corrupt the NDJSON stream)
  //   - --json is set (JSON consumers get logFile from the report)
  // Otherwise (CI pipes without --json or --ndjson-events) keep the notice
  // so tail -f / logcatching scripts find the path promptly.
  const suppressLogNotice = isTtyStdout() || !!opts.ndjsonEvents || !!opts.json || !!opts.quiet;
  if (logFilePath && !suppressLogNotice) {
    try {
      fs.writeSync(2, `cpd: writing log to ${logFilePath}\n`);
    } catch {
      // ignore
    }
  }

  // Events sink. For --events-file we open an fd and write synchronously per line,
  // mirroring the logger pattern. fs.createWriteStream would buffer and truncate
  // on process.exit. Stderr uses the same sync pattern for consistency.
  let eventsStream: { write(chunk: string): boolean } | undefined;
  let eventsFd: number | undefined;
  if (opts.ndjsonEvents) {
    if (typeof opts.eventsFile === "string") {
      fs.mkdirSync(path.dirname(opts.eventsFile), { recursive: true });
      eventsFd = fs.openSync(opts.eventsFile, "a");
      const fd = eventsFd;
      eventsStream = {
        write(chunk: string): boolean {
          try {
            fs.writeSync(fd, chunk);
          } catch {
            // never throw from event sink
          }
          return true;
        },
      };
    } else {
      eventsStream = {
        write(chunk: string): boolean {
          try {
            fs.writeSync(2, chunk);
          } catch {
            // ignore
          }
          return true;
        },
      };
    }
  }

  const progress = new Progress({
    enabled: progressEnabled,
    // In --verbose mode we suppress the spinner: the humanWriter on the
    // logger now emits per-event prose to stderr, and a live spinner
    // repainting at 80ms would overwrite those lines. Treat the stream as
    // non-TTY when verbose is on; Progress's non-TTY branch is silent
    // (no `[..]`/`[ok]` lines either, since we don't pass `verbose: true`
    // anymore — those would just duplicate the per-event prose).
    isTty: opts.verbose ? false : isTtyStderr(),
    ...(eventsStream ? { ndjsonStream: eventsStream } : {}),
  });

  const finalize = (exitCode: number): void => {
    if (eventsFd !== undefined) {
      try {
        fs.closeSync(eventsFd);
      } catch {
        // ignore
      }
    }
    logger.close();
    process.exit(exitCode);
  };

  process.on("uncaughtException", (err) => {
    logger.error("uncaught_exception", {
      name: err.name,
      message: err.message,
      stack: err.stack,
    });
    progress.abort();
    emitError(err, opts, logger, logFilePath);
    finalize(1);
  });

  // "auto" is kept as an alias for "all" for backward compatibility.
  const mode: "all" | "auto" | "ccd" | "cowork" =
    opts.mode === "ccd" || opts.mode === "cowork"
      ? opts.mode
      : opts.mode === "all" || opts.mode === "auto"
        ? "all"
        : "all";

  return {
    home,
    colorEnabled,
    colorEnabledStderr,
    logger,
    progress,
    logFilePath,
    finalize,
    mode,
  };
}

async function runScanCommand(opts: Record<string, unknown>): Promise<void> {
  const ctx = setupRunContext(opts);
  try {
    const uiEvidenceMaxAgeDays =
      typeof opts.uiEvidenceMaxAge === "string" && /^\d+$/.test(opts.uiEvidenceMaxAge)
        ? Number.parseInt(opts.uiEvidenceMaxAge, 10)
        : 7;
    // --root <acc:org> parsing for multi-root filter
    let rootFilter: { accountId: string; orgId: string } | undefined;
    if (typeof opts.root === "string") {
      const colon = opts.root.indexOf(":");
      if (colon <= 0 || colon === opts.root.length - 1) {
        throw new CpdError(
          "E_USAGE",
          `--root must be in "accountId:orgId" format, got: "${opts.root}"`,
          "Example: --root acc123:org456",
        );
      }
      rootFilter = {
        accountId: opts.root.slice(0, colon),
        orgId: opts.root.slice(colon + 1),
      };
    }
    const maxConcurrency =
      typeof opts.maxConcurrency === "string" && /^\d+$/.test(opts.maxConcurrency)
        ? Math.max(1, Number.parseInt(opts.maxConcurrency, 10))
        : 8;
    // --no-skills-plugin: commander sets `skillsPlugin: false` when --no-skills-plugin is passed.
    // --with-skills-plugin is a no-op (the default is to include; explicit flag is UX only).
    const includeSkillsPlugin = opts.skillsPlugin !== false;
    const showRuntimeBoundary = opts.showRuntimeBoundary === true;

    const report = await runScan({
      home: ctx.home,
      platform: process.platform,
      env: process.env as Record<string, string | undefined>,
      mode: ctx.mode,
      noNetwork: opts.network === false,
      ...(typeof opts.coworkAccount === "string" ? { coworkAccount: opts.coworkAccount } : {}),
      ...(typeof opts.coworkOrg === "string" ? { coworkOrg: opts.coworkOrg } : {}),
      ...(rootFilter !== undefined ? { rootFilter } : {}),
      maxConcurrency,
      logger: ctx.logger,
      progress: ctx.progress,
      uiEvidenceMaxAgeDays,
      includeSkillsPlugin,
      showRuntimeBoundary,
    });

    if (opts.json) {
      writeStdoutSync(renderJson(report, { pretty: isTtyStdout() }));
    } else if (!opts.quiet) {
      writeStdoutSync(
        renderHuman(report, {
          color: ctx.colorEnabled,
          verbose: !!opts.verbose,
          showRuntimeBoundary,
          quiet: !!opts.quiet,
        }),
      );
    }

    ctx.finalize(report.exitCode);
  } catch (err) {
    ctx.logger.error("scan_failed", {
      name: (err as Error).name,
      message: (err as Error).message,
      ...(err instanceof CpdError ? { code: err.code, hint: err.hint } : {}),
    });
    ctx.progress.abort();
    emitError(err, opts, ctx.logger, ctx.logFilePath);
    ctx.finalize(exitCodeForError(err));
  }
}

async function runCheckCommand(id: string, opts: Record<string, unknown>): Promise<void> {
  const ctx = setupRunContext(opts);
  const checkStartMs = Date.now();
  try {
    const report = await runV05Check({
      home: ctx.home,
      platform: process.platform,
      env: process.env as Record<string, string | undefined>,
      mode: ctx.mode,
      noNetwork: opts.network === false,
      ...(typeof opts.coworkAccount === "string" ? { coworkAccount: opts.coworkAccount } : {}),
      ...(typeof opts.coworkOrg === "string" ? { coworkOrg: opts.coworkOrg } : {}),
      logger: ctx.logger,
      progress: ctx.progress,
      pluginAtMarketplace: id,
    });

    // B1: emit a consolidated check-specific done line (no marketplace/plugin/stale
    // parenthetical — those counts are not meaningful for a single-plugin focus).
    // The scans themselves have suppressHumanDone set; this is the one human done line.
    // Only emit on TTY (that's when the spinner was showing) and not quiet/json.
    if (!opts.quiet && !opts.json && isTtyStderr()) {
      const durationMs = Date.now() - checkStartMs;
      const seconds = (durationMs / 1000).toFixed(1);
      try {
        fs.writeSync(2, `✓ done in ${seconds}s\n`);
      } catch {
        // ignore
      }
    }

    if (opts.json) {
      writeStdoutSync(renderJsonCheck(report, { pretty: isTtyStdout() }));
    } else if (!opts.quiet) {
      writeStdoutSync(
        renderHumanCheck(report, { color: ctx.colorEnabled, verbose: !!opts.verbose }),
      );
    }

    // exitCode 2 if plugin missing OR full scan reports drift; 0 otherwise.
    // Exception: when rpmMatchAmbiguous is set, use exitCode 64 (E_USAGE) directly.
    const exitCode = report.rpmMatchAmbiguous
      ? 64
      : !report.plugin && report.fullReport.exitCode === 0
        ? 2
        : report.exitCode;
    ctx.finalize(exitCode);
  } catch (err) {
    ctx.logger.error("check_failed", {
      name: (err as Error).name,
      message: (err as Error).message,
      ...(err instanceof CpdError ? { code: err.code, hint: err.hint } : {}),
    });
    ctx.progress.abort();
    emitError(err, opts, ctx.logger, ctx.logFilePath);
    ctx.finalize(exitCodeForError(err));
  }
}

async function runRefreshCommand(mpName: string, opts: Record<string, unknown>): Promise<void> {
  const ctx = setupRunContext(opts);
  try {
    // --force-fetch is destructive (writes to .git/refs/) and is gated on
    // --yes per CLAUDE.md guardrails. Refuse without explicit confirmation.
    if (opts.forceFetch && !opts.yes) {
      throw new CpdError(
        "E_FORCE_FETCH_ABORTED",
        "--force-fetch writes to the marketplace clone's .git/ refs (git fetch && git reset --hard). Pass --yes to confirm.",
        "Re-run with --yes to proceed, or omit --force-fetch to use the standard refresh path.",
      );
    }
    const report = await runRefresh({
      home: ctx.home,
      platform: process.platform,
      env: process.env as Record<string, string | undefined>,
      mode: ctx.mode,
      noNetwork: opts.network === false,
      ...(typeof opts.coworkAccount === "string" ? { coworkAccount: opts.coworkAccount } : {}),
      ...(typeof opts.coworkOrg === "string" ? { coworkOrg: opts.coworkOrg } : {}),
      logger: ctx.logger,
      progress: ctx.progress,
      marketplaceName: mpName,
      ...(opts.autoUpdate ? { autoUpdate: true } : {}),
      ...(opts.forceFetch ? { forceFetch: true } : {}),
    });

    if (opts.json) {
      writeStdoutSync(renderJsonRefresh(report, { pretty: isTtyStdout() }));
    } else if (!opts.quiet) {
      writeStdoutSync(
        renderHumanRefresh(report, { color: ctx.colorEnabled, verbose: !!opts.verbose }),
      );
    }

    ctx.finalize(report.exitCode);
  } catch (err) {
    ctx.logger.error("refresh_failed", {
      name: (err as Error).name,
      message: (err as Error).message,
      ...(err instanceof CpdError ? { code: err.code, hint: err.hint } : {}),
    });
    ctx.progress.abort();
    emitError(err, opts, ctx.logger, ctx.logFilePath);
    ctx.finalize(exitCodeForError(err));
  }
}

async function runListCommand(opts: Record<string, unknown>): Promise<void> {
  const ctx = setupRunContext(opts);
  try {
    const report = await runList({
      home: ctx.home,
      platform: process.platform,
      env: process.env as Record<string, string | undefined>,
      mode: ctx.mode,
      noNetwork: opts.network === false,
      ...(typeof opts.coworkAccount === "string" ? { coworkAccount: opts.coworkAccount } : {}),
      ...(typeof opts.coworkOrg === "string" ? { coworkOrg: opts.coworkOrg } : {}),
      logger: ctx.logger,
      progress: ctx.progress,
    });

    if (opts.json) {
      writeStdoutSync(renderJsonList(report, { pretty: isTtyStdout() }));
    } else if (!opts.quiet) {
      writeStdoutSync(
        renderHumanList(report, { color: ctx.colorEnabled, verbose: !!opts.verbose }),
      );
    }

    ctx.finalize(report.exitCode);
  } catch (err) {
    ctx.logger.error("list_failed", {
      name: (err as Error).name,
      message: (err as Error).message,
      ...(err instanceof CpdError ? { code: err.code, hint: err.hint } : {}),
    });
    ctx.progress.abort();
    emitError(err, opts, ctx.logger, ctx.logFilePath);
    ctx.finalize(exitCodeForError(err));
  }
}

async function runTopologyCommand(opts: Record<string, unknown>): Promise<void> {
  const ctx = setupRunContext(opts);
  try {
    const topoOpts: Parameters<typeof runTopology>[0] = {
      ctx: {
        platform: process.platform,
        home: ctx.home,
        env: process.env as Record<string, string | undefined>,
      },
      logger: ctx.logger,
      progress: ctx.progress,
      ...(ctx.logFilePath !== undefined ? { logFile: ctx.logFilePath } : {}),
    };
    const report = runTopology(topoOpts);

    if (opts.json) {
      writeStdoutSync(`${JSON.stringify(report, null, isTtyStdout() ? 2 : 0)}\n`);
    } else if (!opts.quiet) {
      writeStdoutSync(renderTopologyHuman(report, { verbose: !!opts.verbose }));
    }

    ctx.finalize(report.exitCode);
  } catch (err) {
    ctx.logger.error("topology_failed", {
      name: (err as Error).name,
      message: (err as Error).message,
      ...(err instanceof CpdError ? { code: err.code, hint: err.hint } : {}),
    });
    ctx.progress.abort();
    emitError(err, opts, ctx.logger, ctx.logFilePath);
    ctx.finalize(exitCodeForError(err));
  }
}

/**
 * Human-readable summary of the topology.
 * Kept tight: ~10-15 lines for a typical machine (spec §8, deliverable #8).
 */
function renderTopologyHuman(
  report: import("./types.js").TopologyReport,
  opts?: { verbose?: boolean },
): string {
  const { topology } = report;
  const lines: string[] = [];
  const home = process.env.HOME;

  // Tildify helper — local to this renderer.
  const tildify = (p: string): string =>
    home && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;

  // 3.3: shortId for default mode; full UUID in --verbose.
  const shortId = (id: string): string =>
    !opts?.verbose && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
      ? `${id.slice(0, 8)}…`
      : id;

  lines.push("Topology:");

  if (topology.ccd !== undefined) {
    lines.push(`  Standalone Claude Code     ${tildify(topology.ccd.pluginsRoot)}`);
    lines.push(`    marketplaces             ${topology.ccd.marketplaces.length}`);
  } else {
    lines.push("  Standalone Claude Code     (not found)");
  }
  // (no `(CCD)` parenthetical here — the de-jargon pass dropped it; users
  // who need the abbreviation find it in `cpd explain`.)

  if (topology.cowork.length === 0) {
    lines.push("  Claude Cowork roots        (none)");
  } else {
    lines.push(`  Claude Cowork roots        ${topology.cowork.length}`);
    for (const root of topology.cowork) {
      const tag = root.isMostRecent ? " [active]" : "";
      // 3.3: one tildified short-UUID line per root (drop redundant full-path second line).
      const accDisplay = shortId(root.accountId);
      const orgDisplay = shortId(root.orgId);
      lines.push(`    account ${accDisplay}  org ${orgDisplay}${tag}   ${tildify(root.rootPath)}`);
    }
  }

  if (topology.skillsPlugin !== undefined) {
    lines.push(`  Cowork built-in skills     ${tildify(topology.skillsPlugin.rootPath)}`);
    lines.push(`    pairs                    ${topology.skillsPlugin.pairs.length}`);
    for (const pair of topology.skillsPlugin.pairs) {
      const orgDisplay = shortId(pair.orgId);
      const accDisplay = shortId(pair.accountId);
      lines.push(`      org ${orgDisplay}/account ${accDisplay}  (${pair.skills.length} skills)`);
    }
  } else {
    lines.push("  Cowork built-in skills     (not found)");
  }

  lines.push(`  Cowork session-locals      ${topology.sessionLocals.length} dirs`);

  lines.push(`\nScanned at: ${topology.scannedAt}`);
  // Standard footer format used across all renderers: "Run ID" (no colon),
  // dim value, padded so the column lines up with "Active session" / "Log file".
  lines.push(`Run ID          ${report.runId}`);
  lines.push("");

  return lines.join("\n");
}

async function runWatchCommand(id: string, opts: Record<string, unknown>): Promise<void> {
  const ctx = setupRunContext(opts);
  try {
    const intervalMs =
      typeof opts.interval === "string" && /^\d+$/.test(opts.interval)
        ? Number.parseInt(opts.interval, 10)
        : 500;
    // Watch silences progress for ALL inner runCheck calls (initial + each
    // fs-event re-check). The watch loop has its own per-event UI via
    // `printWatchUpdate`; an in-place spinner overwriting that output
    // would cause tearing. NDJSON `phase_*` events still fire — scripting
    // contract preserved.
    const silentProgress = new Progress({ enabled: false, isTty: false });
    await runWatch({
      home: ctx.home,
      platform: process.platform,
      env: process.env as Record<string, string | undefined>,
      mode: ctx.mode,
      noNetwork: opts.network === false,
      ...(typeof opts.coworkAccount === "string" ? { coworkAccount: opts.coworkAccount } : {}),
      ...(typeof opts.coworkOrg === "string" ? { coworkOrg: opts.coworkOrg } : {}),
      logger: ctx.logger,
      progress: silentProgress,
      pluginAtMarketplace: id,
      intervalMs,
      color: ctx.colorEnabledStderr,
      ...(opts.verbose ? { verbose: true } : {}),
    });
    ctx.finalize(0);
  } catch (err) {
    ctx.logger.error("watch_failed", {
      name: (err as Error).name,
      message: (err as Error).message,
      ...(err instanceof CpdError ? { code: err.code, hint: err.hint } : {}),
    });
    ctx.progress.abort();
    emitError(err, opts, ctx.logger, ctx.logFilePath);
    ctx.finalize(exitCodeForError(err));
  }
}

async function runVerifyInUiCommand(id: string, opts: Record<string, unknown>): Promise<void> {
  const home = os.homedir();
  const logFilePath = resolveLogFile(opts, home);
  const validLevels = new Set<LogLevel>(["trace", "debug", "info", "warn", "error"]);
  const fileLevel: LogLevel =
    typeof opts.logLevel === "string" && validLevels.has(opts.logLevel as LogLevel)
      ? (opts.logLevel as LogLevel)
      : "info";
  const logger = new Logger({
    ...(logFilePath ? { filePath: logFilePath } : {}),
    fileLevel,
  });

  try {
    const report = await runVerifyInUi({
      pluginRefStr: id,
      json: opts.json === true,
      quiet: opts.quiet === true,
      ...(logFilePath !== undefined ? { logFile: logFilePath } : {}),
    });

    if (opts.json) {
      writeStdoutSync(`${JSON.stringify(report, null, isTtyStdout() ? 2 : 0)}\n`);
    } else {
      const lines: string[] = [
        `Captured evidence for ${report.pluginRefKey}`,
        `  Listed in UI:   ${report.captured.pluginListed}`,
      ];
      if (report.captured.versionShown !== undefined) {
        lines.push(`  Version shown:  ${report.captured.versionShown}`);
      }
      if (report.captured.updateAvailable !== undefined) {
        lines.push(`  Update badge:   ${report.captured.updateAvailable}`);
      }
      if (report.captured.statusShown !== undefined) {
        lines.push(`  Status shown:   ${report.captured.statusShown}`);
      }
      lines.push(`  Captured at:    ${report.captured.capturedAt}`);
      lines.push(`  Persisted to:   ${report.persistedTo}`);
      writeStdoutSync(`${lines.join("\n")}\n`);
    }

    logger.close();
    process.exit(report.exitCode);
  } catch (err) {
    logger.close();
    const cpdErr = err instanceof CpdError ? err : new CpdError("E_USAGE", (err as Error).message);
    const envelope = cpdErr.toEnvelope({
      runId: logger.getRunId(),
      ...(logFilePath ? { logFile: logFilePath } : {}),
    });
    if (opts.json) {
      writeStdoutSync(`${JSON.stringify(envelope)}\n`);
    } else {
      try {
        fs.writeSync(2, `error: ${envelope.message}\n`);
        if (envelope.hint) fs.writeSync(2, `hint:  ${envelope.hint}\n`);
        if (envelope.code) fs.writeSync(2, `code:  ${envelope.code}\n`);
      } catch {
        // ignore
      }
    }
    process.exit(exitCodeForError(cpdErr));
  }
}

async function runCacheCommand(opts: Record<string, unknown>): Promise<void> {
  const home = os.homedir();
  const logFilePath = resolveLogFile(opts, home);
  const validLevels = new Set<LogLevel>(["trace", "debug", "info", "warn", "error"]);
  const fileLevel: LogLevel =
    typeof opts.logLevel === "string" && validLevels.has(opts.logLevel as LogLevel)
      ? (opts.logLevel as LogLevel)
      : "info";
  const logger = new Logger({
    ...(logFilePath ? { filePath: logFilePath } : {}),
    fileLevel,
  });

  try {
    const pruneCoworkSessions = opts.pruneCoworkSessions === true;
    const orphans = opts.orphans === true;

    if (!pruneCoworkSessions && !orphans) {
      throw new CpdError(
        "E_USAGE",
        "cpd cache requires at least one of: --prune-cowork-sessions, --orphans",
        "Run `cpd cache --help` for usage.",
      );
    }

    if (pruneCoworkSessions) {
      // Discover session locals via topology.
      const { discoverTopology } = await import("./discovery/topology.js");
      const topology = discoverTopology({
        platform: process.platform,
        home,
        env: process.env as Record<string, string | undefined>,
      });

      const olderThanDays =
        typeof opts.olderThan === "string" && /^\d+$/.test(opts.olderThan)
          ? Math.max(1, Number.parseInt(opts.olderThan, 10))
          : 14;

      const dryRun = opts.yes !== true || opts.dryRun === true;

      const report = runCachePrune({
        olderThanDays,
        force: opts.force === true,
        dryRun,
        yes: opts.yes === true,
        sessionLocals: topology.sessionLocals,
        logger: {
          info: (msg: string, data?: Record<string, unknown>) => {
            logger.info(msg, data ?? {});
          },
        },
      });

      if (opts.json) {
        writeStdoutSync(`${JSON.stringify(report, null, isTtyStdout() ? 2 : 0)}\n`);
      } else if (!opts.quiet) {
        const lines: string[] = [];
        lines.push("Cache prune: cowork sessions");
        lines.push(`  Older-than threshold: ${olderThanDays} days`);
        lines.push(`  Mode: ${report.dryRun ? "dry-run" : "destructive"}`);
        lines.push(`  Candidates: ${report.candidates.length}`);
        lines.push(`  Reclaimable: ${report.totalReclaimableBytes} bytes`);
        if (report.candidates.length > 0) {
          lines.push("");
          lines.push("Candidates:");
          for (const c of report.candidates) {
            lines.push(`  ${c.pathOnDisk}  (${c.kind}, ${c.approxSizeBytes} bytes)`);
          }
        }
        if (report.skipped.length > 0) {
          lines.push("");
          lines.push("Skipped:");
          for (const s of report.skipped) {
            lines.push(`  ${s.pathOnDisk}  (${s.skipReason})`);
          }
        }
        if (!report.dryRun && report.deleted.length > 0) {
          lines.push("");
          lines.push("Deleted:");
          for (const d of report.deleted) {
            lines.push(`  ${d}`);
          }
          lines.push(`  Total deleted: ${report.totalDeletedBytes} bytes`);
        } else if (report.dryRun && report.candidates.length > 0) {
          lines.push("");
          lines.push("Run with --yes to delete the candidates above.");
        }
        writeStdoutSync(`${lines.join("\n")}\n`);
      }

      logger.close();
      process.exit(report.exitCode);
    }

    if (orphans) {
      // Resolve the active plugins root.
      const { resolveCcdPluginsRoot } = await import("./paths.js");
      const pluginsRoot = resolveCcdPluginsRoot({
        platform: process.platform,
        home,
        env: process.env as Record<string, string | undefined>,
      });

      const report = runCacheOrphans({ pluginsRoot });

      if (opts.json) {
        writeStdoutSync(`${JSON.stringify(report, null, isTtyStdout() ? 2 : 0)}\n`);
      } else if (!opts.quiet) {
        const tildifyPath = (p: string): string => {
          const h = process.env.HOME;
          return h && p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
        };
        const lines: string[] = [];
        const totalCount = report.orphans.length + report.strayDirs.length;
        const totalBytes = report.totalOrphanBytes + report.totalStrayBytes;

        // ── Plugin install orphans ────────────────────────────────────────
        // Old <mp>/<plugin>/<version>/ snapshots no longer referenced by
        // installed_plugins.json. Safe to delete; reclaim disk only.
        if (report.orphans.length > 0) {
          lines.push(
            `Plugin install orphans (${report.orphans.length}; old versions no longer in use):`,
          );
          for (const o of report.orphans) {
            lines.push(
              `  ${tildifyPath(o.orphanPath)}  (${o.marketplace}/${o.pluginName}@${o.version}, ${humanBytes(o.approxSizeBytes)})`,
            );
          }
          lines.push(`  Subtotal: ${humanBytes(report.totalOrphanBytes)}`);
          lines.push("");
        }

        // ── Stray top-level directories ───────────────────────────────────
        // Top-level dirs under cache/ that aren't real marketplaces. Two
        // sources: temp_subdir_* staging leftovers from interrupted
        // `claude plugin marketplace add` operations, OR marketplaces that
        // were removed from known_marketplaces.json without cleaning up
        // their cache subtree.
        if (report.strayDirs.length > 0) {
          lines.push(
            `Stray directories under cache/ (${report.strayDirs.length}; not real marketplaces — safe to delete):`,
          );
          for (const s of report.strayDirs) {
            const why =
              s.reason === "temp-staging-dir"
                ? "temp staging dir from an interrupted `claude plugin marketplace add`"
                : "marketplace not in known_marketplaces.json (removed without cleanup, or never registered)";
            lines.push(`  ${tildifyPath(s.strayPath)}  (${humanBytes(s.approxSizeBytes)}; ${why})`);
          }
          lines.push(`  Subtotal: ${humanBytes(report.totalStrayBytes)}`);
          lines.push("");
        }

        if (totalCount === 0) {
          lines.push("No orphan or stray directories found — cache is clean.");
          lines.push("");
        } else {
          lines.push(`Total reclaimable: ${humanBytes(totalBytes)}`);
          lines.push("");
          lines.push("To clean up manually:");
          if (report.strayDirs.length > 0) {
            lines.push(`  rm -rf ~/.claude/plugins/cache/temp_*  ${"# stray staging dirs"}`);
          }
          if (report.orphans.length > 0) {
            lines.push("  # Then rm -rf each plugin install orphan listed above.");
          }
          lines.push("");
        }

        lines.push(`Run ID          ${logger.getRunId()}`);
        lines.push(
          `Exit code: ${report.exitCode}  (${
            totalCount === 0
              ? "nothing to clean"
              : `${totalCount} item${totalCount === 1 ? "" : "s"} found, ${humanBytes(totalBytes)} reclaimable; see commands above`
          })`,
        );
        writeStdoutSync(`${lines.join("\n")}\n`);
      }

      logger.close();
      process.exit(report.exitCode);
    }
  } catch (err) {
    const cpdErr = err instanceof CpdError ? err : new CpdError("E_USAGE", (err as Error).message);
    const envelope = cpdErr.toEnvelope({
      runId: logger.getRunId(),
      ...(logFilePath ? { logFile: logFilePath } : {}),
    });
    if (opts.json) {
      writeStdoutSync(`${JSON.stringify(envelope)}\n`);
    } else {
      try {
        fs.writeSync(2, `error: ${envelope.message}\n`);
        if (envelope.hint) fs.writeSync(2, `hint:  ${envelope.hint}\n`);
        if (envelope.code) fs.writeSync(2, `code:  ${envelope.code}\n`);
      } catch {
        // ignore
      }
    }
    logger.close();
    process.exit(exitCodeForError(cpdErr));
  }
}

/**
 * Map a thrown error to the documented exit code.
 * - E_USAGE / parse errors / unsupported platform → 64 (per HELP_EPILOG and
 *   POSIX usage-error convention).
 * - Anything else → 1 (generic error).
 */
function exitCodeForError(err: unknown): number {
  if (err instanceof CpdError) {
    // 64 = command-line usage error (sysexits.h EX_USAGE).
    // All input-validation errors (bad CLI args, bad stdin JSON, bad
    // persisted state schema) map to 64. Genuine I/O / parse / network
    // errors stay at exit 1 (generic).
    const usageErrors: ReadonlySet<string> = new Set([
      "E_USAGE",
      "E_VERIFY_IN_UI_INPUT",
      "E_UI_EVIDENCE_SCHEMA",
      "E_FORCE_FETCH_ABORTED",
    ]);
    if (usageErrors.has(err.code)) return 64;
  }
  return 1;
}

function emitError(
  err: unknown,
  opts: Record<string, unknown>,
  logger: Logger,
  logFilePath: string | undefined,
): void {
  const cpdErr = err instanceof CpdError ? err : new CpdError("E_USAGE", (err as Error).message);
  const envelope = cpdErr.toEnvelope({
    runId: logger.getRunId(),
    ...(logFilePath ? { logFile: logFilePath } : {}),
  });
  if (opts.json) {
    writeStdoutSync(`${JSON.stringify(envelope)}\n`);
  } else if (!opts.quiet) {
    try {
      fs.writeSync(2, `error: ${envelope.message}\n`);
      if (envelope.hint) fs.writeSync(2, `hint:  ${envelope.hint}\n`);
      if (envelope.code) fs.writeSync(2, `code:  ${envelope.code}\n`);
      if (envelope.logFile) fs.writeSync(2, `log:   ${envelope.logFile}\n`);
    } catch {
      // ignore
    }
  }
}

program.parseAsync(process.argv).catch((e: unknown) => {
  // Commander throws a CommanderError under exitOverride. For --help and
  // --version it has code "commander.helpDisplayed" / "commander.version"
  // and an exitCode of 0; we should exit cleanly with no stderr noise.
  // For usage errors (missing argument, unknown option), exitCode is 1
  // by default — remap to 64 per HELP_EPILOG.
  const err = e as { code?: string; exitCode?: number; message?: string };
  if (err && typeof err.code === "string" && err.code.startsWith("commander.")) {
    if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
      process.exit(0);
    }
    // Commander already wrote its own "error: ..." to stderr.
    process.exit(64);
  }
  process.stderr.write(`error: ${(e as Error).message}\n`);
  process.exit(64);
});
