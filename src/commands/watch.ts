import * as fs from "node:fs";
import { createColors } from "picocolors";
import { CpdError } from "../errors.js";
import { formatRecCmd, humanStatus, renderHumanCheck } from "../output/human.js";
import { type V05CheckReport as CheckReport, runV05Check as runCheck } from "./check.js";
import type { RunScanOpts } from "./scan.js";

// Force-on instance — caller's `color` flag is the single source of truth,
// independent of stderr-TTY auto-detection at module load.
const pc = createColors(true);

export type RunWatchOpts = RunScanOpts & {
  pluginAtMarketplace: string;
  intervalMs?: number;
  /** When true, print the full per-layer evidence on each re-check (like
   *  `cpd check`) rather than the compact one-line summary. */
  verbose?: boolean;
  /** Whether to emit ANSI colors. Should be derived from stderr-TTY status,
   *  since `watch` writes to stderr. */
  color?: boolean;
  /** Test seam: aborts the watcher loop. */
  signal?: AbortSignal;
};

/**
 * Collect filesystem paths to watch for the given plugin.
 *  - Directory-source marketplaces: the source dir (the path the author edits).
 *  - All sources: the marketplace clone dir (changes when `claude plugin
 *    marketplace update` runs from another terminal).
 *  - All sources: the cache install path (changes when `claude plugin update`
 *    repopulates the cache).
 */
function collectWatchPaths(report: CheckReport): string[] {
  const paths: string[] = [];
  const m = report.marketplace;
  if (!m) return paths;

  // 1. Directory-source: sourceDetail IS the absolute path.
  if (m.sourceType === "directory" && fs.existsSync(m.sourceDetail)) {
    paths.push(m.sourceDetail);
  }
  // 2. Marketplace clone dir (always).
  const cloneDir = m.layer1.evidence.cloneDir;
  if (typeof cloneDir === "string" && fs.existsSync(cloneDir)) {
    paths.push(cloneDir);
  }
  // 3. The cache install itself.
  const installPath = report.plugin?.scopes?.[0]?.installPath;
  if (typeof installPath === "string" && fs.existsSync(installPath)) {
    paths.push(installPath);
  }

  return paths;
}

const STATUS_COLOR: Record<string, (s: string) => string> = {
  fresh: pc.green,
  stale: pc.yellow,
  missing: pc.red,
  unknowable: pc.dim,
  skipped: pc.dim,
};

function printWatchUpdate(
  report: CheckReport,
  kind: "initial" | "change",
  verbose: boolean,
  color: boolean,
): void {
  const t = new Date().toLocaleTimeString();
  const dim = color ? pc.dim : (s: string): string => s;
  const bold = color ? pc.bold : (s: string): string => s;
  if (!report.plugin) {
    const msg = color
      ? pc.red(`plugin "${report.pluginId}" not installed`)
      : `plugin "${report.pluginId}" not installed`;
    fs.writeSync(2, `${dim(`[${t}]`)} ${kind}: ${msg}\n`);
    return;
  }
  if (verbose) {
    // Full re-render — same as `cpd check`.
    fs.writeSync(2, `\n${dim(`[${t}]`)} ${kind}\n`);
    fs.writeSync(2, renderHumanCheck(report, { color, verbose: true }));
    return;
  }
  const p = report.plugin;
  const layers: { key: keyof typeof p.checks; label: string }[] = [
    { key: "marketplace_clone", label: "clone" },
    { key: "install_snapshot", label: "install" },
    { key: "cowork_mirror", label: "cowork" },
  ];
  // Skipped is "not applicable in this mode" — hiding it makes the summary
  // glance-able. Non-fresh layers surface; if nothing is non-fresh, render
  // a single ✓ all-clear instead of three `=fresh` columns.
  const interesting = layers.filter(({ key }) => p.checks[key].status !== "skipped");
  const nonFresh = interesting.filter(({ key }) => p.checks[key].status !== "fresh");
  let summary: string;
  if (nonFresh.length === 0) {
    const tok = color ? pc.green("✓") : "[OK]";
    summary = `${tok} ${color ? pc.dim("in sync") : "in sync"}`;
  } else {
    summary = nonFresh
      .map(({ key, label }) => {
        const st = p.checks[key].status;
        const word = humanStatus(st, key, p.checks[key].evidence);
        const stColored = color && STATUS_COLOR[st] ? STATUS_COLOR[st](word) : word;
        return `${label}: ${stColored}`;
      })
      .join(", ");
  }
  const stale = layers.filter(
    ({ key }) => p.checks[key].status === "stale" || p.checks[key].status === "missing",
  );
  fs.writeSync(2, `\n${dim(`[${t}]`)} ${kind}  ${bold(p.id)}  ${summary}\n`);
  for (const { key } of stale) {
    const r = p.checks[key];
    fs.writeSync(2, `  ${r.detail}\n`);
    if (r.recommendation?.cmd) {
      const arrow = color ? pc.dim("→") : "→";
      const formatted = formatRecCmd(r.recommendation.cmd, {
        color,
        header: `  ${arrow}`,
        indent: "    ",
      });
      fs.writeSync(2, `${formatted}\n`);
    }
  }
}

export async function runWatch(opts: RunWatchOpts): Promise<void> {
  if (process.platform !== "darwin") {
    throw new CpdError(
      "E_PLATFORM_UNSUPPORTED",
      "`cpd watch` requires fs.watch with recursive option, which Node currently supports only on macOS and Windows. Linux support is planned.",
    );
  }

  // Initial check to discover paths to watch.
  let report = await runCheck(opts);
  const verbose = opts.verbose === true;
  const color = opts.color === true;
  const dim = color ? pc.dim : (s: string): string => s;
  const bold = color ? pc.bold : (s: string): string => s;
  printWatchUpdate(report, "initial", verbose, color);

  const watchPaths = collectWatchPaths(report);
  if (watchPaths.length === 0) {
    fs.writeSync(2, `\nwatch: no source paths to watch for ${opts.pluginAtMarketplace}\n`);
    return;
  }

  fs.writeSync(
    2,
    `\n${bold(`watch: monitoring ${watchPaths.length} path(s)`)} ${dim("(Ctrl-C to exit)")}\n`,
  );
  for (const p of watchPaths) fs.writeSync(2, `  ${dim("-")} ${p}\n`);

  let pending: NodeJS.Timeout | undefined;
  let running = false;
  let abortRequested = false;
  const debounceMs = opts.intervalMs ?? 500;

  const trigger = (): void => {
    if (abortRequested) return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(async () => {
      if (running || abortRequested) return;
      running = true;
      try {
        report = await runCheck(opts);
        printWatchUpdate(report, "change", verbose, color);
      } finally {
        running = false;
      }
    }, debounceMs);
  };

  const watchers: fs.FSWatcher[] = [];
  for (const p of watchPaths) {
    try {
      const w = fs.watch(p, { recursive: true }, () => trigger());
      watchers.push(w);
    } catch {
      // Some paths (e.g., disappeared between the check and now) may fail; skip.
    }
  }

  await new Promise<void>((resolve) => {
    let resolved = false;
    const cleanup = (): void => {
      if (resolved) return;
      resolved = true;
      abortRequested = true;
      if (pending) clearTimeout(pending);
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // ignore
        }
      }
      process.removeListener("SIGINT", cleanup);
      resolve();
    };
    process.once("SIGINT", cleanup);
    if (opts.signal) opts.signal.addEventListener("abort", cleanup, { once: true });
  });
}
