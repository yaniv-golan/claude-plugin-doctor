import type { LogLevel } from "../types.js";

/**
 * Verbose-mode prose formatter.
 *
 * `--verbose` augments the default scan output with a per-event human
 * narrative on stderr — never NDJSON. Each rendered line is one-line, tagged
 * by subsystem, and answers "why" (what was probed, what was found, what was
 * concluded). Phase indicators are NOT re-rendered here — the spinner /
 * default progress already covers them.
 *
 * Returns the formatted line (without trailing newline) or undefined to drop
 * the event from the verbose stream. Unknown messages are dropped silently
 * unless they are warnings/errors, in which case they're surfaced as
 * `[warn]` / `[error]` so nothing important goes missing.
 */
export type VerboseFields = Record<string, unknown>;

const LAYER_TAG: Record<string, string> = {
  marketplace_clone: "L1",
  install_snapshot: "L2",
  cowork_mirror: "L3",
  rpm_copy: "L5",
  ccd_remote_ssh: "L6",
};

function s(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

/** Trim the rootKey suffix on subjects so the line stays readable.
 *  Inputs look like `plugin@mp#ccd` or `plugin@mp#cowork:<acc>:<org>`.
 *
 *  Default-mode tag suppression: the standalone-Claude-Code root is the
 *  default install location for nearly every user, so tagging every line
 *  with `[CCD]` is high-noise low-value and contradicts the de-jargon
 *  pass. We only annotate lines that came from a non-default root
 *  (Claude Cowork sessions, where the account/org distinction is
 *  user-relevant). The annotation uses plain language. */
function shortSubject(subject: string): string {
  const hashIdx = subject.lastIndexOf("#");
  if (hashIdx === -1) return subject;
  const head = subject.slice(0, hashIdx);
  const tail = subject.slice(hashIdx + 1);
  // standalone-Claude-Code is the default — render unadorned.
  if (tail === "ccd") return head;
  if (tail.startsWith("cowork:")) {
    const parts = tail.slice(7).split(":");
    const acc = parts[0]?.slice(0, 8) ?? "?";
    const org = parts[1]?.slice(0, 8) ?? "?";
    return `${head} [in Claude Cowork: ${acc}…/${org}…]`;
  }
  return subject;
}

const SUBJ_W = 54;

/** Per-run dedup set for drift_emitted events. Multi-root scans walk every
 *  configured root (standalone Claude Code + each Cowork acc/org pair) and
 *  emit the same drift per-root, producing 4× near-identical output for the
 *  user. Drift detection is per-plugin not per-root — show each (kind, subject)
 *  pair once. Cleared between runs by the CLI wrapper (formatVerboseLine is
 *  called once per cpd invocation; the Set is module-scope so it persists for
 *  the run's duration; tests that call multiple invocations in one process
 *  should call resetVerboseDedup()). */
const DRIFT_DEDUP = new Set<string>();

/** Called by the CLI wrapper at the start of each invocation; tests may also
 *  call this between simulated runs. Without resetting, a long-running
 *  watch/repl session would silently accumulate dedup keys forever. */
export function resetVerboseDedup(): void {
  DRIFT_DEDUP.clear();
}

export function formatVerboseLine(
  msg: string,
  fields: VerboseFields,
  level: LogLevel,
): string | undefined {
  const f = fields;
  switch (msg) {
    // ── Scan lifecycle ─────────────────────────────────────────────────────
    case "scan_start":
      // Reset the per-run dedup state. cpd watch calls runScan in a loop;
      // without this reset, watch's second iteration would suppress all
      // drift events because the keys from iteration 1 are still in the Set.
      DRIFT_DEDUP.clear();
      return `[scan] start  (mode=${s(f.mode)}, network=${f.noNetwork ? "off" : "on"})`;
    case "mode_detected":
      return `[scan] resolved mode → ${s(f.mode)}`;
    case "scan_done":
      return `[scan] done  (${s(f.durationMs)}ms, exit=${s(f.exitCode)})`;

    // ── Discovery ───────────────────────────────────────────────────────────
    case "topology_summary":
      return `[topo] ${f.hasCcd ? "1" : "0"} standalone Claude Code root, ${s(f.coworkRoots)} Claude Cowork root(s), ${s(f.sessionLocals)} session-local dir(s)`;
    case "known_marketplaces_parsed":
      return `[parse] ${s(f.root)}: ${s(f.count)} marketplace(s)`;
    case "installed_plugins_parsed":
      return `[parse] ${s(f.root)}: ${s(f.count)} installed plugin(s)`;
    case "rpm_manifest_parsed":
      return `[parse] Claude Cowork in-app installs: ${s(f.count)}`;
    case "skills_plugin_snapshots":
      return `[skills] ${s(f.pairs)} pair(s), ${s(f.snapshots)} skill snapshot(s)`;
    case "skills_plugin_snapshots_skipped":
      return `[skills] skipped: ${s(f.reason)}`;

    // ── Per-cache probes ────────────────────────────────────────────────────
    case "upstream_probe": {
      const dur = f.durationMs !== undefined ? `  (${f.durationMs}ms)` : "";
      return `[L1] ${shortSubject(s(f.subject)).padEnd(SUBJ_W)} ${s(f.source)} probe → ${s(f.status)}${dur}`;
    }
    case "cache_snapshot": {
      // "present" is the boring case — skip it. "absent" is interesting (a
      // registered plugin's dir missing on disk). For layer 1
      // (marketplace_clone), an `upstream_probe` event already covered the
      // subject one line earlier — emitting another `[L1] foo  absent`
      // immediately after `[L1] foo  ... probe → fresh` reads as a
      // contradiction. Skip layer-1 cache_snapshot events entirely; the
      // probe event is the canonical signal for layer-1 state.
      if (f.presence === "present") return undefined;
      if (f.layer === "marketplace_clone") return undefined;
      const tag = LAYER_TAG[s(f.layer)] ?? s(f.layer);
      return `[${tag}] ${shortSubject(s(f.subject)).padEnd(SUBJ_W)} ${s(f.presence)}`;
    }
    case "remote_version_fetched":
      return `[L2] ${s(f.id).padEnd(SUBJ_W)} remote plugin.json: ${s(f.version)}`;
    case "remote_version_fetch_failed":
      return `[L2] ${s(f.id).padEnd(SUBJ_W)} remote plugin.json: ${s(f.reason)}`;
    case "ui_evidence_read":
      return `[ui] ${s(f.pluginRefKey).padEnd(SUBJ_W)} captured ${s(f.capturedAt)}, listed=${s(f.pluginListed)}`;

    // ── Drift / planning ────────────────────────────────────────────────────
    case "drift_emitted": {
      // Skip drifts without a subject (e.g. registration-drift fires
      // globally without a per-plugin subject). The count is already in
      // the scan summary.
      if (f.subject === undefined) return undefined;
      // Dedup by (kind, subject) within a run: multi-root scans fire the
      // same drift kind for the same plugin per-root (CCD + each cowork
      // root), producing 4× duplication. Show once. The first occurrence
      // is the canonical one; suppress subsequent ones.
      const dedupKey = `${s(f.kind)}::${s(f.subject)}`;
      if (DRIFT_DEDUP.has(dedupKey)) return undefined;
      DRIFT_DEDUP.add(dedupKey);
      return `[drift] ${s(f.kind).padEnd(28)} ${s(f.subject)}`;
    }
    case "action_planned":
      return `[plan] #${s(f.ordinal)}  ${s(f.id)}  (risk=${s(f.risk)})`;
    case "runtime_boundary":
      return `[advisory] ${s(f.description)}`;

    // ── Refresh subcommand ──────────────────────────────────────────────────
    case "refresh_start":
      return `[refresh] start: ${s(f.marketplace)}`;
    case "refresh_done":
      return `[refresh] done  (${s(f.durationMs)}ms)`;
    case "claude_marketplace_update_start":
      return `[refresh] running: claude plugin marketplace update ${s(f.marketplace)}`;
    case "claude_marketplace_update_done":
      return `[refresh] update done: ${s(f.outcome ?? "ok")}`;
    case "force_fetch_start":
      return `[force-fetch] start: ${s(f.marketplace)}`;
    case "force_fetch_branch_resolved":
      return `[force-fetch] branch=${s(f.branch)}`;
    case "force_fetch_backup_written":
      return `[force-fetch] backup → ${s(f.path)}`;
    case "force_fetch_done":
      return "[force-fetch] done";

    default:
      // Phase events, resolver_sim, compose_drift_done, plan_recommendations_done,
      // and discover_session_locals are intentionally suppressed — they either
      // duplicate the spinner / final summary or are too noisy. Surface
      // warnings/errors so nothing important is silently lost.
      if (level === "warn" || level === "error") {
        const detail = Object.keys(f).length > 0 ? `  ${JSON.stringify(f)}` : "";
        return `[${level}] ${msg}${detail}`;
      }
      return undefined;
  }
}
