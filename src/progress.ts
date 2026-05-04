import * as fs from "node:fs";
import * as readline from "node:readline";
import { nowIso } from "./refs.js";
import type { ProgressEvent, ScanPhase } from "./types.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Human-friendly labels for spinner output. NDJSON event payloads keep the
// canonical snake_case `phase` keys — this map only affects what the user
// sees in the spinner.
const PHASE_LABELS: Record<string, string> = {
  init: "Initializing",
  resolve_paths: "Resolving paths",
  detect_mode: "Detecting mode",
  parse_known_marketplaces: "Loading marketplaces",
  parse_installed_plugins: "Reading installed plugins",
  parse_rpm_manifest: "Reading remote-install manifest",
  check_marketplaces: "Checking marketplaces",
  check_plugins: "Checking plugins",
  check_rpm: "Checking remote-installs",
  // v1.x phases
  discover_topology: "Discovering installation layout",
  discover_skills_plugin: "Discovering skills-plugin pairs",
  discover_session_locals: "Discovering session-local dirs",
  probe_upstreams: "Probing upstream sources",
  snapshot_caches: "Snapshotting cache state",
  fetch_remote_versions: "Fetching remote plugin.json versions",
  simulate_resolvers: "Simulating CLI/UI/session resolvers",
  compose_drift: "Composing drift diagnosis",
  plan_recommendations: "Planning recommendations",
  topology_render: "Rendering topology",
  verify_in_ui_capture: "Capturing UI evidence",
  render: "Rendering output",
  refresh_before_scan: "Pre-refresh scan",
  refresh_claude_update: "Running claude plugin marketplace update",
  refresh_after_scan: "Post-refresh scan",
};

function humanPhase(phase: string): string {
  return PHASE_LABELS[phase] ?? phase;
}

// Minimal structural type — accepts process.stderr, fs.WriteStream,
// and the synchronous fd-based writer used by the CLI for --events-file.
export type EventSink = { write(chunk: string): boolean };

export type ProgressOpts = {
  enabled: boolean;
  isTty: boolean;
  /** When true, emit each phase as its own `✓ phase (Nms)` line — the legacy
   *  behavior, kept for `--verbose` and for non-TTY contexts (CI logs, pipes).
   *  When false (the default for interactive TTY sessions), only the in-place
   *  spinner shows during the run; the final summary line is emitted by
   *  `emitDone()`. NDJSON `phase_*` events fire either way. */
  verbose?: boolean;
  ndjsonStream?: EventSink;
  /** When true, suppress the human TTY done line in emitDone(). The NDJSON
   *  scan_done event still fires. Used by the check command so the CLI wrapper
   *  can emit a consolidated check-specific done line. */
  suppressHumanDone?: boolean;
};

export class Progress {
  private frame = 0;
  private timer: NodeJS.Timeout | undefined;
  private currentLine = "";
  private lastDrawnLength = 0;

  constructor(private readonly opts: ProgressOpts) {}

  /** Return a new Progress with the same human-output opts but no ndjsonStream.
   *  Used by the check command's fallback scan so it doesn't emit a second
   *  scan_done NDJSON event (one-event-per-cpd-check-invocation contract). */
  withoutNdjson(): Progress {
    const { ndjsonStream: _dropped, ...rest } = this.opts;
    return new Progress(rest);
  }

  /** Return a new Progress that emits NDJSON events normally but suppresses
   *  the human TTY done line in emitDone(). Used by runV05Check to let the
   *  CLI wrapper emit a consolidated check-specific done line. */
  withSuppressedHumanDone(): Progress {
    return new Progress({ ...this.opts, suppressHumanDone: true });
  }

  start(phase: ScanPhase, total?: number): void {
    this.emit({
      type: "phase_start",
      phase,
      ts: nowIso(),
      ...(total !== undefined ? { total } : {}),
    });
    if (!this.opts.enabled) return;
    this.currentLine = humanPhase(phase);
    if (this.opts.isTty) {
      // Lazy-start the spinner timer on first `start()` call. We keep one
      // timer alive across phases — it just re-paints `this.currentLine`,
      // which is updated as phases come and go.
      if (!this.timer) {
        this.timer = setInterval(() => this.draw(), 80);
      }
      this.draw();
    } else if (this.opts.verbose) {
      try {
        fs.writeSync(2, `[..] ${humanPhase(phase)}\n`);
      } catch {
        // ignore
      }
    }
  }

  update(phase: ScanPhase, current: number, total: number, item?: string): void {
    this.emit({
      type: "phase_progress",
      phase,
      ts: nowIso(),
      current,
      total,
      ...(item !== undefined ? { item } : {}),
    });
    if (!this.opts.enabled) return;
    const label = humanPhase(phase);
    const txt = `${label} (${current}/${total})${item ? ` — ${item}` : ""}`;
    if (this.opts.isTty) {
      this.currentLine = txt;
    } else if (this.opts.verbose) {
      try {
        fs.writeSync(2, `[..] ${txt}\n`);
      } catch {
        // ignore
      }
    }
  }

  end(phase: ScanPhase, durationMs: number): void {
    this.emit({
      type: "phase_end",
      phase,
      ts: nowIso(),
      durationMs,
    });
    if (!this.opts.enabled) return;
    if (this.opts.isTty) {
      // In collapsed mode: do nothing; the next `start()` will overwrite
      // the spinner line, or `emitDone()` will clear it and print the
      // summary. In verbose mode: emit the per-phase ✓ line.
      if (this.opts.verbose) {
        this.clearLine();
        try {
          fs.writeSync(2, `✓ ${humanPhase(phase)} (${durationMs}ms)\n`);
        } catch {
          // ignore
        }
      }
    } else if (this.opts.verbose) {
      try {
        fs.writeSync(2, `[ok] ${humanPhase(phase)} (${durationMs}ms)\n`);
      } catch {
        // ignore
      }
    }
  }

  abort(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.clearLine();
    }
  }

  emitDone(
    durationMs: number,
    exitCode: number,
    summary?: {
      marketplaces: number;
      plugins: number;
      layersStale: number;
      versionTrapCount?: number;
      staleCount?: number;
      /** Count of plugins whose install_snapshot status is "unknowable".
       *  Displayed separately from staleCount in the progress done line
       *  (1.1: "N stale, U unknown version" split). */
      unknownCount?: number;
      topologyRoots?: number;
      driftCount?: number;
      recommendationCount?: number;
    },
  ): void {
    this.emit({
      type: "scan_done",
      ts: nowIso(),
      durationMs,
      exitCode,
      ...(summary ? { summary } : {}),
    });
    if (!this.opts.enabled) return;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.clearLine();
    }
    // B1: when suppressHumanDone is set, the caller (CLI wrapper) emits its
    // own consolidated done line. Stop the spinner (already done above) but
    // don't emit the per-scan human done line — return without writing text.
    if (this.opts.suppressHumanDone) return;
    if (!this.opts.isTty || this.opts.verbose) return;
    // Collapsed-TTY summary line.
    // 1.1: split staleCount and unknownCount so users see "N stale, U unknown version"
    // instead of a single conflated count. The two counts can overlap (a plugin can
    // have stale Layer 1 AND unknowable Layer 2) — displaying them separately is
    // more honest about what each number means.
    const seconds = (durationMs / 1000).toFixed(1);
    const inventoryParts: string[] = [];
    const driftParts: string[] = [];
    if (summary) {
      inventoryParts.push(`${summary.marketplaces} marketplaces`);
      inventoryParts.push(`${summary.plugins} plugins`);
      // Build the right-side of the dash: "N stale, U unknown version"
      const staleCount = summary.staleCount ?? summary.layersStale;
      const unknownCount = summary.unknownCount;
      if (staleCount > 0) driftParts.push(`${staleCount} stale`);
      if (unknownCount !== undefined && unknownCount > 0)
        driftParts.push(`${unknownCount} unknown version`);
    }
    // Format: "(N marketplaces, P plugins — S stale, U unknown version)"
    // The em-dash separates inventory facts from drift counts. Joining all
    // segments with ", " (the bug v1.2 caught) would render "..., plugins, — N
    // stale, ..." with a stray comma before the dash. Build the two halves
    // separately and combine with " — " as the joiner.
    let tail = "";
    if (inventoryParts.length > 0) {
      const left = inventoryParts.join(", ");
      const right = driftParts.length > 0 ? ` — ${driftParts.join(", ")}` : "";
      tail = `  (${left}${right})`;
    }
    try {
      fs.writeSync(2, `✓ done in ${seconds}s${tail}\n`);
    } catch {
      // ignore
    }
  }

  private draw(): void {
    if (!this.opts.isTty) return;
    const f = FRAMES[this.frame++ % FRAMES.length] ?? "*";
    const text = `${f} ${this.currentLine}`;
    try {
      // Erase any leftover from a longer prior line, then overwrite. Using
      // readline avoids tearing on fast updates that produce shorter text.
      readline.cursorTo(process.stderr, 0);
      readline.clearLine(process.stderr, 0);
      fs.writeSync(2, text);
      this.lastDrawnLength = text.length;
    } catch {
      // ignore
    }
  }

  private clearLine(): void {
    if (!this.opts.isTty || this.lastDrawnLength === 0) return;
    try {
      readline.cursorTo(process.stderr, 0);
      readline.clearLine(process.stderr, 0);
      this.lastDrawnLength = 0;
    } catch {
      // ignore
    }
  }

  private emit(ev: ProgressEvent): void {
    if (this.opts.ndjsonStream) {
      this.opts.ndjsonStream.write(`${JSON.stringify(ev)}\n`);
    }
  }
}
