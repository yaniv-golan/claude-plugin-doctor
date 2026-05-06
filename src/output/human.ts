import { createColors } from "picocolors";
import type {
  CheckStatus,
  MarketplaceReport,
  PluginReport,
  RpmReport,
  ScanReport,
} from "../types.js";

// Re-export so existing imports (`watch.ts`) and tests don't have to change.
export { formatRecCmd } from "./cmd-format.js";
export { humanStatus, ICON_COLOR, ICON_PLAIN, statusToken } from "./status-translate.js";
export { shortId } from "./uuid-format.js";

import { preferredScope } from "../installed-plugins.js";
import { parsePluginId, pluginRefKey, stripRootSuffix } from "../refs.js";
import type { ManualStepSourceContext } from "./cmd-format.js";
import {
  dedupSubchains,
  formatManualSteps,
  formatRecCmd,
  isManualRec,
  splitTopLevelAndAnd,
  styleCmdBody,
} from "./cmd-format.js";
import { glyph } from "./glyphs.js";
import { humanStatus, statusToken } from "./status-translate.js";
import { shortId } from "./uuid-format.js";

export type RenderOpts = {
  color: boolean;
  verbose?: boolean;
  /** When true, always show the runtime-boundary advisory section even when
   *  no changed surfaces are present (--show-runtime-boundary flag, spec §9.2). */
  showRuntimeBoundary?: boolean;
  /** When true, suppress optional hints like the per-plugin deep-dive hint. */
  quiet?: boolean;
};

// Renderer-local force-on picocolors. The output/{cmd-format,status-translate}
// modules each carry their own; co-located here for the per-command renderers.
const pcOn = createColors(true);

/** Evidence keys that should never appear in human output. Currently just
 *  `kind` — an internal discriminator consumed by humanStatus, redundant
 *  with the translated status word. JSON output retains all evidence keys. */
const HIDDEN_EVIDENCE_KEYS = new Set(["kind"]);

/** Test whether an evidence value `v` is mentioned in the detail prose
 *  closely enough that printing the evidence row would be redundant. */
function valueInDetail(v: string, detail: string): boolean {
  if (v.length === 0) return false;
  if (v.length >= 8) return detail.includes(v);
  // Short values (likely identifiers like "github", "ccd"): require a
  // word-boundary match to avoid false-positives on prose substrings.
  const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(detail);
}

/** Format an ISO-8601 timestamp as `YYYY-MM-DD (~N <unit> ago)`. Drops
 *  millisecond precision — humans don't read at that resolution. The
 *  relative portion uses simple bands; for tests, freeze time via
 *  `vi.setSystemTime` so the bands don't drift. Returns the original
 *  string unchanged if it doesn't parse as a valid date. */
export function humanTimestamp(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  const diffMs = now.getTime() - d.getTime();
  const diffSec = Math.round(diffMs / 1000);
  const rel = relativeBand(diffSec);
  return `${date} ${rel}`;
}

function relativeBand(diffSec: number): string {
  // Future timestamps are unusual but possible (clock skew, refresh
  // logs from a faster host). Render symmetrically.
  const past = diffSec >= 0;
  const abs = Math.abs(diffSec);
  const tail = past ? "ago" : "from now";
  if (abs < 60) return past ? "(just now)" : "(just now)";
  if (abs < 3600) return `(~${Math.round(abs / 60)} min ${tail})`;
  if (abs < 86400) {
    const n = Math.round(abs / 3600);
    return `(~${n} ${n === 1 ? "hr" : "hrs"} ${tail})`;
  }
  if (abs < 86400 * 14) {
    const n = Math.round(abs / 86400);
    return `(~${n} ${n === 1 ? "day" : "days"} ${tail})`;
  }
  // weeks→months crossover at ~30 days so a 53-day-old timestamp reads
  // as "~2 months" (more human) rather than "~8 weeks" (technically more
  // precise, but no human says "8 weeks").
  if (abs < 86400 * 30) {
    const n = Math.round(abs / (86400 * 7));
    return `(~${n} ${n === 1 ? "week" : "weeks"} ${tail})`;
  }
  if (abs < 86400 * 365) {
    const n = Math.round(abs / (86400 * 30));
    return `(~${n} ${n === 1 ? "month" : "months"} ${tail})`;
  }
  const n = Math.round(abs / (86400 * 365));
  return `(~${n} ${n === 1 ? "year" : "years"} ${tail})`;
}

/**
 * Format a raw byte count as a human-readable string using binary (1024-based)
 * units — matching what `du -h` produces, which is what most users expect.
 * Examples: 224 → "224 B"; 3544 → "3.5 KB"; 1258291 → "1.2 MB".
 */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Returns a one-line `Run cpd explain ...` hint when the rendered output
 *  contains any translated jargon (unknown / n/a / not-implemented). Pushed
 *  by every per-command renderer just before the exit-code line so first-
 *  time users always have a discovery path. Returns `undefined` when the
 *  output has no jargon — keeps clean reports terse. */
function maybeExplainHint(joinedSoFar: string, color: boolean): string | undefined {
  if (/\bunknown\b|\bn\/a\b|\bnot-implemented\b/.test(joinedSoFar)) {
    const s = styler(color);
    return s.dim("Run `cpd explain` for what these statuses mean.");
  }
  return undefined;
}

/** Replace the user's home directory prefix with `~/...` for readability.
 *  No-op if the path doesn't start with home. JSON keeps full paths. */
/** Replace inline UUIDs in an advisory message with their 8-char short form
 *  (`<8>…`). Privacy: full UUIDs go to JSON only; humans see truncated forms
 *  so a copy/paste into a bug report doesn't leak full session IDs.
 *  Reviewer #4 refinement on Item 2's advisory message. */
function truncateUuidsInMessage(msg: string): string {
  return msg.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    (uuid) => `${uuid.slice(0, 8)}…`,
  );
}

function tildify(p: string, home?: string): string {
  const h = home ?? process.env.HOME;
  if (h && p.startsWith(`${h}/`)) return `~${p.slice(h.length)}`;
  return p;
}

/** Translate the internal mode codename (`ccd`, `cowork`) to a readable
 *  display string with the codename in dim parens. */
function _humanMode(mode: string, color: boolean): string {
  const s = styler(color);
  if (mode === "ccd") return `standalone Claude Code ${s.dim("(ccd)")}`;
  if (mode === "cowork") return `Claude Cowork ${s.dim("(cowork)")}`;
  return mode;
}

/** Style helpers gated on `color`. Off-mode returns identity, so callers can
 *  use `s.cmd(...)` etc. without conditionals at every site. Uses the
 *  force-on picocolors instance — caller's `color` flag is the single source
 *  of truth, regardless of TTY detection at module load. */
function styler(color: boolean): {
  bold: (s: string) => string;
  dim: (s: string) => string;
  cmd: (s: string) => string;
  arrow: (s: string) => string;
  warn: (s: string) => string;
  exit: (code: number, s: string) => string;
} {
  if (!color) {
    const id = (s: string): string => s;
    return { bold: id, dim: id, cmd: id, arrow: id, warn: id, exit: (_c, s) => s };
  }
  return {
    bold: pcOn.bold,
    dim: pcOn.dim,
    // Recommendation commands are the things users copy-paste; cyan reads on
    // both light and dark terminals. Bold makes the boundary obvious next to
    // dim arrows / parentheticals.
    cmd: (s) => pcOn.cyan(pcOn.bold(s)),
    arrow: pcOn.dim,
    warn: pcOn.yellow,
    exit: (code, s) => (code === 0 ? pcOn.green(s) : code === 2 ? pcOn.yellow(s) : pcOn.red(s)),
  };
}

/**
 * Translate a stable drift `kind` (used as the agent contract value in JSON
 * output) into a short, plain-English noun phrase suitable for the human
 * `fixes:` / `does not fix:` summary lines.
 *
 * Keep these short enough to fit a one-liner. JSON consumers see the raw
 * `kind` value untouched.
 */
function driftKindHuman(kind: string): string {
  switch (kind) {
    case "marketplace-update-broken":
      return "marketplace update silently broken";
    case "refresh-needed":
      return "needs marketplace refresh";
    case "bump-needed":
      return "needs version bump in source";
    case "badge-only-needed":
      return "marketplace catalog version label out of sync";
    case "version-drift":
      return "out of date";
    case "resolver-disagreement":
      return "CLI vs UI version mismatch";
    case "registration-drift":
      return "registration mismatch";
    case "runtime-boundary":
      return "needs fresh task or restart to take effect";
    case "unsupported-source":
      return "source type not supported by this Claude Code";
    case "skills-plugin-stuck":
      return "stuck skills-plugin failure";
    case "session-bloat-cleanup-eligible":
      return "old session dirs reclaimable";
    case "npm-source-not-supported":
      return "npm source not supported";
    case "backend-ui-drift":
      return "backend vs UI mismatch";
    default:
      return kind;
  }
}

export function renderHuman(report: ScanReport, opts: RenderOpts): string {
  const c = opts.color;
  const s = styler(c);
  const lines: string[] = [];

  // ── Headline verdict ─────────────────────────────────────────────────────────
  // Lead with the bottom line so users don't have to scan past 12+ lines of
  // topology before learning whether anything is wrong. The detailed drift
  // breakdown still lives in the "Drift summary:" block below.
  //
  // Honesty under --no-network: when network probes were skipped, layer-1
  // version-trap detection can't fire (it needs an upstream HEAD to compare
  // against the local clone). Some drift kinds (resolver-disagreement,
  // version-drift, registration-drift) still fire, but the result is
  // inconclusive — we don't know whether the drift is fixable or harmless.
  // The headline must NOT say "Everything fresh" in that case (a lie when
  // the body is full of drift counts and recommended fixes).
  const recsExclAdvisory = report.recommendations.filter(
    (r) => r.id !== "advisory:runtime-boundary",
  );
  // Count visually-rendered fixes (post-aggregation) — the user sees the
  // collapsed list, not the raw recs[]. Bump-needed entries collapse to 1.
  let displayFixCount = 0;
  let bumpRunActive = false;
  for (const r of recsExclAdvisory) {
    if (r.id.startsWith("action:bump-needed:")) {
      if (!bumpRunActive) {
        displayFixCount += 1;
        bumpRunActive = true;
      }
    } else {
      displayFixCount += 1;
      bumpRunActive = false;
    }
  }
  const hasNoNetworkProbes = Object.values(report.upstreams ?? {}).some((u) => {
    const us = u as { status?: string };
    return us.status === "no-network" || us.status === "unreachable";
  });
  const hasDrifts = report.drifts.length > 0;
  if (report.exitCode === 0 && hasDrifts) {
    // Inconclusive: exit code says "fine" but body lists drift. Most common
    // cause is --no-network suppressing trap detection while leaving
    // resolver/version-drift detection running.
    const qMark = c ? pcOn.yellow("?") : "[?]";
    const reason = hasNoNetworkProbes
      ? "--no-network blocked the upstream probes; re-run without --no-network for a definitive answer"
      : "some layers were inconclusive";
    lines.push(
      `${qMark} ${s.bold("Inconclusive")} — drift indicators present  ${s.dim(`(${reason})`)}`,
    );
  } else if (report.exitCode === 0) {
    const okMark = glyph("ok", c);
    lines.push(`${okMark} ${s.bold("Everything fresh")} — no drift detected.`);
  } else {
    const xMark = glyph("fail", c);
    const fixPart =
      displayFixCount > 0
        ? ` — ${displayFixCount} ${displayFixCount === 1 ? "fix" : "fixes"} available below`
        : "";
    const exitNote =
      report.exitCode === 3
        ? "manual action required"
        : report.exitCode === 2
          ? "fixes available"
          : `exit ${report.exitCode}`;
    lines.push(`${xMark} ${s.bold("Drift detected")}${fixPart}  ${s.dim(`(${exitNote})`)}`);
  }
  lines.push("");

  // ── Topology section ─────────────────────────────────────────────────────────
  const topo = report.topology;
  lines.push(s.bold("Topology:"));
  // All topology rows use a 30-char label column so paths line up vertically.
  const LABEL_W = 30;
  const PATH_INDENT = " ".repeat(2 + LABEL_W + 1);
  if (topo.ccd) {
    const mpCount = topo.ccd.marketplaces.length;
    lines.push(`  ${"Standalone Claude Code".padEnd(LABEL_W)} ${topo.ccd.pluginsRoot}`);
    lines.push(`${PATH_INDENT}${mpCount} marketplace(s)`);
  }
  for (const cw of topo.cowork) {
    const label = cw.isMostRecent ? "Claude Cowork (active)" : "Claude Cowork (inactive)";
    lines.push(`  ${label.padEnd(LABEL_W)} ${cw.rootPath}`);
    // The cowork path embeds the account and org UUIDs as its last two
    // segments — restating them as `acc=…, org=…` would duplicate the
    // information visible one line above. Show just the marketplace count
    // here; users who need the IDs as fields can use `cpd topology --json`.
    lines.push(`${PATH_INDENT}${cw.marketplaces.length} marketplace(s)`);
  }
  if (topo.skillsPlugin) {
    lines.push(`  ${"Cowork built-in skills".padEnd(LABEL_W)} ${topo.skillsPlugin.rootPath}`);
    lines.push(`${PATH_INDENT}${topo.skillsPlugin.pairs.length} pair(s)`);
  }
  if (topo.sessionLocals.length > 0) {
    const totalBytes = topo.sessionLocals.reduce((sum, d) => sum + d.approxSizeBytes, 0);
    lines.push(
      `  ${"Cowork session-locals".padEnd(LABEL_W)} ${topo.sessionLocals.length} dirs (~${Math.round(totalBytes / (1024 * 1024))} MB)`,
    );
  }
  lines.push("");

  // ── Drift summary ─────────────────────────────────────────────────────────────
  // 1.2: Deduplicate by pluginRefKey so the same plugin emitting multiple drift
  // entries (e.g. version-drift + resolver-disagreement, or one per cowork root)
  // is counted once per kind, not multiple times. The dedup key is the root-aware
  // pluginRefKey format: "<plugin>@<marketplace>#<rootKey>".
  // Drifts whose subject.kind !== "plugin" are counted separately (not per-plugin).
  // Note: runtime-boundary and unsupported-source both have subject.kind === "plugin"
  // but are counted in their own dedicated rows (Surfaces / Sources), not the Plugins row.
  const drifts = report.drifts;

  // Build Map<driftKind, Set<pluginRefKey>> for ALL plugin-subject drifts.
  // We'll selectively use these sets below.
  const pluginDriftKindSets = new Map<string, Set<string>>();

  let mpBroken = 0;
  const mpStale = Object.values(report.marketplaceCaches).filter((snaps) =>
    snaps.some((s) => s.layer === "marketplace_clone" && s.presence === "absent"),
  ).length;
  let skillsStuck = 0;
  const sessionBloat = drifts.filter((d) => d.kind === "session-bloat-cleanup-eligible");
  const totalBloatBytes = sessionBloat.reduce(
    (sum, d) => sum + (d.kind === "session-bloat-cleanup-eligible" ? d.bytesReclaimable : 0),
    0,
  );

  for (const d of drifts) {
    switch (d.kind) {
      case "marketplace-update-broken":
        mpBroken++;
        break;
      case "skills-plugin-stuck":
        skillsStuck++;
        break;
      case "refresh-needed":
      case "bump-needed":
      case "badge-only-needed":
      case "version-drift":
      case "resolver-disagreement":
      case "unsupported-source":
      case "runtime-boundary": {
        // These have subject.kind === "plugin"; accumulate by pluginRefKey.
        if (
          "subject" in d &&
          d.subject &&
          typeof d.subject === "object" &&
          "kind" in (d.subject as object) &&
          (d.subject as { kind: string }).kind === "plugin"
        ) {
          const subj = d.subject as { kind: "plugin"; ref: import("../types.js").PluginRef };
          const key = pluginRefKey(subj.ref);
          let kindSet = pluginDriftKindSets.get(d.kind);
          if (!kindSet) {
            kindSet = new Set();
            pluginDriftKindSets.set(d.kind, kindSet);
          }
          kindSet.add(key);
        }
        break;
      }
      // registration-drift, session-bloat, npm-source-not-supported, backend-ui-drift:
      // handled by separate counts or ignored in summary.
    }
  }

  // Version-related plugins: union of version-trap + version-drift kinds.
  const versionTrapKinds = ["refresh-needed", "bump-needed", "badge-only-needed", "version-drift"];
  const versionDriftPlugins = new Set<string>();
  for (const kind of versionTrapKinds) {
    const keys = pluginDriftKindSets.get(kind);
    if (keys) for (const k of keys) versionDriftPlugins.add(k);
  }
  const totalVersionDrift = versionDriftPlugins.size;
  const resolverDrifts = pluginDriftKindSets.get("resolver-disagreement")?.size ?? 0;
  const registrationDrifts = drifts.filter((d) => d.kind === "registration-drift").length;
  const runtimeBoundaryDrifts = pluginDriftKindSets.get("runtime-boundary")?.size ?? 0;
  // unsupported-source: count unique plugins (deduplicated).
  const unsupportedSources = pluginDriftKindSets.get("unsupported-source")?.size ?? 0;

  // Union of all per-plugin drift keys (for the "N plugins with drift" headline).
  // Excludes runtime-boundary (shown in Surfaces row) and unsupported-source (Sources row).
  const pluginDriftKindsForHeadline = [
    "refresh-needed",
    "bump-needed",
    "badge-only-needed",
    "version-drift",
    "resolver-disagreement",
  ];
  const allPluginDriftKeys = new Set<string>();
  for (const kind of pluginDriftKindsForHeadline) {
    const keys = pluginDriftKindSets.get(kind);
    if (keys) for (const k of keys) allPluginDriftKeys.add(k);
  }
  // registration-drift doesn't have a per-plugin key so we add registrationDrifts to the count.
  const totalPluginsWithDrift = allPluginDriftKeys.size + registrationDrifts;

  const hasDriftSummary =
    mpBroken > 0 ||
    mpStale > 0 ||
    totalVersionDrift > 0 ||
    resolverDrifts > 0 ||
    registrationDrifts > 0 ||
    runtimeBoundaryDrifts > 0 ||
    unsupportedSources > 0 ||
    skillsStuck > 0 ||
    sessionBloat.length > 0;

  if (hasDriftSummary) {
    lines.push(s.bold("Drift summary:"));
    if (mpBroken > 0 || mpStale > 0) {
      lines.push(
        `  Marketplaces      ${mpStale > 0 ? `${mpStale} stale` : ""}${mpStale > 0 && mpBroken > 0 ? ", " : ""}${mpBroken > 0 ? `${mpBroken} broken` : ""}`,
      );
    }
    if (totalVersionDrift > 0 || resolverDrifts > 0 || registrationDrifts > 0) {
      // The breakdown counts are per-drift-kind and can overlap (a single
      // plugin can be both "out of date" AND "CLI vs UI mismatch" AND
      // "registration mismatch" simultaneously). The "44 plugins" headline
      // is the unique-plugin count; the parenthetical bucket counts can
      // sum to more than 44. Mark this explicitly so users don't try to
      // do the math.
      const pluginParts: string[] = [];
      if (totalVersionDrift > 0) pluginParts.push(`${totalVersionDrift} stale`);
      if (resolverDrifts > 0) pluginParts.push(`${resolverDrifts} CLI vs UI mismatch`);
      if (registrationDrifts > 0) pluginParts.push(`${registrationDrifts} registration mismatch`);
      const summed = totalVersionDrift + resolverDrifts + registrationDrifts;
      const overlapNote = summed > totalPluginsWithDrift ? "; categories overlap" : "";
      const kindBreakdown =
        pluginParts.length > 0 ? ` (${pluginParts.join(", ")}${overlapNote})` : "";
      lines.push(`  Plugins           ${totalPluginsWithDrift} affected${kindBreakdown}`);
    }
    if (runtimeBoundaryDrifts > 0) {
      const noun = runtimeBoundaryDrifts === 1 ? "change needs" : "changes need";
      lines.push(
        `  Surfaces          ${runtimeBoundaryDrifts} ${noun} a fresh task or app restart to take effect`,
      );
    }
    if (unsupportedSources > 0) {
      lines.push(
        `  Sources           ${unsupportedSources} plugin(s) with a source type this Claude Code can't install`,
      );
    }
    if (skillsStuck > 0) {
      lines.push(`  Skills-plugin     ${skillsStuck} stuck failure(s) — see recommended fix`);
    }
    if (sessionBloat.length > 0) {
      lines.push(
        `  Session storage   ${sessionBloat.length} old session dir(s) reclaimable (~${Math.round(totalBloatBytes / (1024 * 1024))} MB)`,
      );
    }
    lines.push("");
  } else if (drifts.length === 0) {
    lines.push(s.dim("No drift detected — everything is in sync."));
    lines.push("");
  }

  // Advisories: render unconditionally (works for both drift and clean-scan
  // outcomes). The advisory itself decides whether to fire; if `summary.
  // advisories` is empty the loop is a no-op. Per reviewer #5: the previous
  // implementation gated rendering on `drifts.length === 0`, but always-fire
  // advisories like `session-plugins-disabled-detected` need to surface even
  // when other drift exists. One unconditional block is cleaner than splitting
  // emission paths.
  const advisories = report.summary?.advisories ?? [];
  if (advisories.length > 0) {
    for (const a of advisories) {
      // Truncate full session UUIDs in human render (privacy — full UUIDs
      // remain in `--json` for programmatic consumers). Reviewer #4.
      const truncated = truncateUuidsInMessage(a.message);
      lines.push(s.dim(`  Note: ${truncated}`));
    }
    lines.push("");
  }

  // ── Recommended actions ───────────────────────────────────────────────────────
  const recs = report.recommendations.filter((r) => r.id !== "advisory:runtime-boundary");
  // Bump-needed entries share an identical multi-line shell template
  // (cd <plugin-source> && bump && commit && push, then refresh + update).
  // The only per-plugin variation is the marketplace name + plugin id at
  // the tail of the cmd. When there are ≥2, collapse to a single numbered
  // entry that names the affected plugins and points at `cpd check` for
  // per-plugin step-by-step. Single bump-needed renders normally so the
  // copy-pasteable cmd stays inline.
  type RenderUnit =
    | { kind: "single"; rec: (typeof recs)[number] }
    | { kind: "bumpAgg"; recs: (typeof recs)[number][] };
  const renderUnits: RenderUnit[] = [];
  let bumpRun: (typeof recs)[number][] = [];
  const flushBumpRun = (): void => {
    if (bumpRun.length === 0) return;
    if (bumpRun.length >= 2) {
      renderUnits.push({ kind: "bumpAgg", recs: bumpRun });
    } else if (bumpRun[0]) {
      renderUnits.push({ kind: "single", rec: bumpRun[0] });
    }
    bumpRun = [];
  };
  for (const rec of recs) {
    if (rec.id.startsWith("action:bump-needed:")) {
      bumpRun.push(rec);
    } else {
      flushBumpRun();
      renderUnits.push({ kind: "single", rec });
    }
  }
  flushBumpRun();

  if (renderUnits.length > 0) {
    lines.push(s.bold("Recommended actions, in order:"));
    let displayOrdinal = 1;
    for (const unit of renderUnits) {
      if (unit.kind === "bumpAgg") {
        const header = `  ${s.dim(`${displayOrdinal}.`)}`;
        const indent = "     ";
        // Affected plugin ids (everything before the # rootKey suffix).
        const plugins = unit.recs
          .flatMap((r) => r.fixes.map((f) => f.pluginRefKey ?? ""))
          .filter(Boolean)
          .map((k) => k.split("#")[0] ?? k);
        const n = unit.recs.length;
        lines.push(
          `${header} ${s.dim(`(manual, ${n} plugins)`)}  Bump plugin.json#version in each plugin's source repo, commit, push, then refresh + update.`,
        );
        lines.push(`${indent}${s.dim("Affects:")} ${plugins.join(", ")}`);
        lines.push(`${indent}${s.dim("For per-plugin step-by-step:")}`);
        lines.push(`${indent}  ${s.cmd("cpd check <plugin>@<marketplace>")}`);
        displayOrdinal++;
        continue;
      }
      const rec = unit.rec;
      const header = `  ${s.dim(`${displayOrdinal}.`)}`;
      const indent = "     ";
      if (rec.cmd) {
        lines.push(formatRecCmd(rec.cmd, { color: c, header, indent }));
      } else {
        lines.push(`${header} ${s.dim("(manual)")} ${rec.description}`);
      }
      // fixes / doesNotFix inline
      // 1.3: when fixes[] has multiple plugin-keyed entries, render as
      // "N plugins use unsupported source kinds: name1, name2, ..." for
      // aggregated recs (e.g. 4 identical "Upgrade Claude Code" recs merged).
      if (rec.fixes.length > 0) {
        const pluginFixes = rec.fixes.filter((f) => f.pluginRefKey !== undefined);
        const otherFixes = rec.fixes.filter((f) => f.pluginRefKey === undefined);
        let fixSummary: string;
        if (pluginFixes.length > 1) {
          // Extract short plugin names from pluginRefKeys (format: "<name>@<mp>#<root>").
          // Strip the `#<root>` suffix first, then split on the LAST `@` so
          // scoped npm-style names like `@scope/foo@mp#ccd` parse correctly
          // (audit issue #13).
          const pluginNames = pluginFixes
            .map((f) => {
              const key = f.pluginRefKey ?? "";
              if (!key) return "";
              const unrooted = stripRootSuffix(key);
              return parsePluginId(unrooted)?.pluginName ?? unrooted;
            })
            .filter(Boolean);
          const kindLabel = driftKindHuman(pluginFixes[0]?.kind ?? "");
          const otherPart = otherFixes.map((f) => `${driftKindHuman(f.kind)}`).join(", ");
          fixSummary = `${pluginFixes.length} plugins — ${kindLabel}: ${pluginNames.join(", ")}${otherPart ? `, ${otherPart}` : ""}`;
        } else {
          // Strip the rootKey suffix from pluginRefKey for user display.
          // pluginRefKey format: "<plugin>@<marketplace>#<rootKey>" — the
          // `#ccd` / `#cowork:<acc>:<org>` suffix is internal; user-facing
          // strings should show just `<plugin>@<marketplace>`.
          const stripRootKey = (k: string): string => {
            const hashIdx = k.indexOf("#");
            return hashIdx === -1 ? k : k.slice(0, hashIdx);
          };
          fixSummary = rec.fixes
            .map(
              (f) =>
                `${driftKindHuman(f.kind)}${
                  f.pluginRefKey
                    ? ` (${stripRootKey(f.pluginRefKey)})`
                    : f.marketplaceRefKey
                      ? ` (${stripRootKey(f.marketplaceRefKey)})`
                      : ""
                }`,
            )
            .join(", ");
        }
        lines.push(`${indent}${s.dim(`fixes: ${fixSummary}`)}`);
      }
      if (rec.doesNotFix.length > 0 && rec.doesNotFix.length <= 3) {
        const notFixSummary = rec.doesNotFix.map((f) => driftKindHuman(f.kind)).join(", ");
        lines.push(`${indent}${s.dim(`does not fix: ${notFixSummary}`)}`);
      }
      displayOrdinal++;
    }
    lines.push("");
  }

  // ── After fixes advisory ──────────────────────────────────────────────────────
  // Per spec §9.2: the runtime-boundary section is shown when the advisory action
  // is present in recommendations (which only happens when runtime-boundary drifts
  // require new-task or ui-restart). --show-runtime-boundary forces it on even
  // when no advisory action is present (e.g. all drifts are "in-task").
  const boundaryAdvisory = report.recommendations.find((r) => r.id === "advisory:runtime-boundary");
  // Determine whether to show: show if advisory action exists, OR flag is set.
  // When flag is set but no advisory action, synthesize a fallback message.
  if (boundaryAdvisory) {
    lines.push(s.bold("After fixes:"));
    const warn = glyph("warn", c);
    lines.push(`  ${warn} ${boundaryAdvisory.description}`);
    lines.push("");
  } else if (opts.showRuntimeBoundary === true) {
    // --show-runtime-boundary with no active advisory: inform the user.
    lines.push(s.bold("After fixes:"));
    lines.push(
      `  ${s.dim("(nothing requires a fresh task or restart — all changes take effect in the current session)")}`,
    );
    lines.push("");
  }

  const hint = maybeExplainHint(lines.join("\n"), c);
  if (hint) {
    lines.push(hint);
    lines.push("");
  }

  // Mirror the headline's honesty: don't claim "everything fresh" when the
  // body lists drift indicators. Same heuristic as the headline.
  const driftsPresentForFooter = report.drifts.length > 0;
  const exitSuffix =
    report.exitCode === 0
      ? driftsPresentForFooter
        ? "  (inconclusive — drift indicators present; re-run without --no-network for a definitive answer)"
        : "  (everything fresh)"
      : report.exitCode === 2
        ? "  (drift detected, fixes available)"
        : report.exitCode === 3
          ? "  (drift detected, manual action required)"
          : "";
  lines.push(s.exit(report.exitCode, `Exit code: ${report.exitCode}${exitSuffix}`));

  // ── Next-steps hints ─────────────────────────────────────────────────────────
  // Per spec: show when exitCode !== 0 and not quiet. Skip on clean runs.
  if (report.exitCode !== 0 && !opts.quiet) {
    lines.push("");
    lines.push(s.dim("For a per-plugin deep-dive:  cpd check <plugin>@<marketplace>"));
    lines.push(s.dim("For per-cache details:        cpd explain"));
  }

  return `${lines.join("\n")}\n`;
}

function _formatMarketplaceLine(m: MarketplaceReport, color: boolean): string {
  const s = styler(color);
  const tok = statusToken(m.layer1.status, color);
  return `  ${tok} ${m.name.padEnd(34)} ${s.dim(m.sourceType.padEnd(10))} ${m.sourceDetail}${
    m.layer1.detail ? `  ${s.dim(`(${m.layer1.detail})`)}` : ""
  }`;
}

function _formatPluginLine(p: PluginReport, color: boolean): string {
  const s = styler(color);
  // Filter `skipped` layers (n/a / stub / not-run) from the worst-status
  // calc — a plugin where everything is fresh except L4 stub should
  // render as ✓ (fresh), not → (skipped). The STATUS_ORDER ranking is
  // semantically correct (stale > skipped); we just don't want the
  // visual icon to be dominated by non-actionable skips.
  const worst = worstStatus(
    [
      p.checks.marketplace_clone.status,
      p.checks.install_snapshot.status,
      p.checks.cowork_mirror.status,
      p.checks.rpm_copy.status,
      p.checks.ccd_remote_ssh.status,
    ].filter((st) => st !== "skipped"),
  );
  const tok = statusToken(worst, color);
  const ver = p.installedVersion ?? "?";
  const detail = summarizePluginDetail(p);
  const detailStr = detail === "(in sync)" ? s.dim(detail) : detail;
  return `  ${tok} ${p.id.padEnd(48)} ${ver.padEnd(8)} ${detailStr}`;
}

function _formatRpmLine(r: RpmReport, color: boolean): string {
  const tok = statusToken(r.layer5.status, color);
  return `  ${tok} ${r.pluginId.padEnd(40)} ${r.layer5.detail}`;
}

const STATUS_ORDER: Record<CheckStatus, number> = {
  missing: 4,
  stale: 3,
  unknowable: 2,
  skipped: 1,
  fresh: 0,
};

function worstStatus(statuses: CheckStatus[]): CheckStatus {
  let worst: CheckStatus = "fresh";
  for (const s of statuses) {
    if (STATUS_ORDER[s] > STATUS_ORDER[worst]) worst = s;
  }
  return worst;
}

function summarizePluginDetail(p: PluginReport): string {
  if (
    p.checks.install_snapshot.status !== "fresh" &&
    p.checks.install_snapshot.status !== "skipped"
  ) {
    return p.checks.install_snapshot.detail;
  }
  if (
    p.checks.marketplace_clone.status !== "fresh" &&
    p.checks.marketplace_clone.status !== "skipped"
  ) {
    return p.checks.marketplace_clone.detail;
  }
  return "(in sync)";
}

/** Build a layer-summary line. `entries` carries each result's status AND
 *  evidence so we can split `skipped` into "n/a" vs "not-implemented" using
 *  evidence.kind (matching what each per-layer line shows). */
function formatLayerSummary(
  label: string,
  entries: { status: CheckStatus; evidence?: Record<string, unknown> }[],
): string {
  if (entries.length === 0) return `  ${label.padEnd(34)}: not applicable`;
  const counts = {
    fresh: 0,
    stale: 0,
    missing: 0,
    unknown: 0,
    inapplicable: 0,
    stub: 0,
    notRun: 0,
  };
  for (const e of entries) {
    if (e.status === "fresh") counts.fresh++;
    else if (e.status === "stale") counts.stale++;
    else if (e.status === "missing") counts.missing++;
    else if (e.status === "unknowable") counts.unknown++;
    else if (e.status === "skipped") {
      const kind = e.evidence?.kind;
      if (kind === "stub") counts.stub++;
      else if (kind === "not-run") counts.notRun++;
      else counts.inapplicable++; // explicit "inapplicable" or unset
    }
  }
  const total = entries.length;
  const parts: string[] = [];
  if (counts.fresh > 0) parts.push(`${counts.fresh}/${total} fresh`);
  if (counts.stale > 0) parts.push(`${counts.stale} stale`);
  if (counts.missing > 0) parts.push(`${counts.missing} missing`);
  if (counts.unknown > 0) parts.push(`${counts.unknown} unknown`);
  if (counts.inapplicable > 0) parts.push(`${counts.inapplicable} n/a`);
  if (counts.stub > 0) parts.push(`${counts.stub} stubbed`);
  if (counts.notRun > 0) parts.push(`${counts.notRun} not-run`);
  return `  ${label.padEnd(34)}: ${parts.join(", ") || `${total} total`}`;
}

// ── Single-plugin (`check` command) renderer ─────────────────────────────

import type { V05CheckReport as CheckReport } from "../commands/check.js";

/** Format a marketplace source as a URL-like string for human output.
 *  Used in the alias-differs note (item 4.2) and disambiguation renderer (item 4.1).
 *  Returns undefined when the source cannot be represented as a meaningful URL.
 *
 *  Source kind table:
 *    github   → "github.com/<repo>"
 *    git      → the git URL verbatim
 *    directory → the directory path verbatim
 *    other    → undefined (silent omission)
 */
export function formatSourceUrl(
  marketplace: { sourceType: string; sourceDetail: string } | undefined,
): string | undefined {
  if (!marketplace) return undefined;
  if (marketplace.sourceType === "github" && marketplace.sourceDetail) {
    return `github.com/${marketplace.sourceDetail}`;
  }
  if (marketplace.sourceType === "git" && marketplace.sourceDetail) {
    return marketplace.sourceDetail;
  }
  if (marketplace.sourceType === "directory" && marketplace.sourceDetail) {
    return marketplace.sourceDetail;
  }
  return undefined;
}

/** Renderer for the RPM-only match case (Cowork "Personal plugins" UI install
 *  path). The CCD-style PluginReport doesn't apply here; render the data we
 *  have from the RPM manifest entry's CheckResult evidence. */
function renderHumanCheckRpmOnly(report: CheckReport, opts: RenderOpts): string {
  const c = opts.color;
  const s = styler(c);
  const lines: string[] = [];
  if (!report.rpmMatch) return ""; // unreachable; type-narrows for TS
  const { rpmPlugin, marketplaceAliasDiffers } = report.rpmMatch;

  // Mode-fallback note (when cpd had to look in the other mode to find it).
  const fb = (report.fullReport as { _modeFallback?: { requested: string; foundIn: string } })
    ._modeFallback;
  if (fb) {
    const fromLabel = fb.requested === "ccd" ? "standalone Claude Code" : "Claude Cowork";
    const inLabel = fb.foundIn === "ccd" ? "standalone Claude Code" : "Claude Cowork";
    const msg = `Note: you asked about ${fromLabel}, but the plugin is installed in ${inLabel} (via the in-app Plugins UI). Showing ${inLabel} details.`;
    lines.push(c ? pcOn.yellow(msg) : msg);
    lines.push("");
  }

  // Header — lead with the answer ("✓ no drift") so users see the verdict
  // before any naming-note prose. The naming-difference note is informational
  // (the plugin IS fine), so it goes BELOW the status, not above.
  const id = `${rpmPlugin.name ?? "(unknown)"}@${rpmPlugin.marketplaceName ?? "(unknown)"}`;
  lines.push(
    `Plugin:        ${s.bold(id)}  ${s.dim("(installed via Claude Cowork's in-app Plugins UI)")}`,
  );
  if (opts.verbose) {
    lines.push(`Backend ID:    ${rpmPlugin.pluginId}  ${s.dim("(Cowork backend identifier)")}`);
  }

  // Layer-5 status + humanized detail. Detail strings can carry an ISO
  // timestamp from the layer module; convert to human-friendly form here
  // (mirrors what cpd list does at the rpm-plugins section).
  const r = rpmPlugin.layer5;
  const rawUpdatedAt = typeof r.evidence.updatedAt === "string" ? r.evidence.updatedAt : undefined;
  const humanizedDetail = rawUpdatedAt
    ? r.detail.replace(rawUpdatedAt, humanTimestamp(rawUpdatedAt))
    : r.detail;
  lines.push("");
  lines.push("Cowork in-app install");
  const tok = statusToken(r.status, c);
  lines.push(`  ${tok} — ${humanizedDetail.split("\n")[0]}`);
  const restDetail = humanizedDetail.split("\n").slice(1);
  for (const dl of restDetail) {
    if (dl.trim()) lines.push(`     ${dl.trimStart()}`);
  }

  // Naming-difference note (demoted, secondary). Only render when there is
  // actually a divergence — and frame it as "FYI, this is fine" so users
  // don't read a drift-free check as a problem report.
  if (marketplaceAliasDiffers) {
    const typedAlias = marketplaceAliasDiffers.typedAs;
    const rpmAlias = marketplaceAliasDiffers.actual;

    const allCcdMarketplaces = [
      ...(report.fullReport.crossModeMarketplaces ?? []),
      ...report.fullReport.marketplaces,
    ];
    const ccdMarketplace = allCcdMarketplaces.find((m) => m.name === typedAlias);

    const typedAliasLabel = ccdMarketplace
      ? `you typed (your local alias in standalone Claude Code) : ${typedAlias}`
      : `you typed (not a known marketplace alias)              : ${typedAlias}`;

    const noteLines: string[] = [
      "",
      "Naming note (informational — not a problem):",
      "This marketplace has different names in your two installs of Claude.",
      `  ${typedAliasLabel}`,
      `  Claude Cowork registered it as                         : ${rpmAlias}`,
    ];

    if (!ccdMarketplace) {
      noteLines.push("  (run `cpd list` to see the marketplace names you have on disk.)");
    }

    if (opts.verbose && rpmPlugin.marketplaceId !== undefined) {
      noteLines.push(
        `  Cowork backend marketplace ID                          : ${rpmPlugin.marketplaceId}`,
      );
    }

    const sourceUrl = formatSourceUrl(ccdMarketplace);
    if (sourceUrl) {
      noteLines.push(`  source URL (from standalone Claude Code)               : ${sourceUrl}`);
      noteLines.push(
        "  (Cowork's in-app installs don't track the source URL — that's why these names diverge.)",
      );
    } else {
      noteLines.push(
        "cpd matched these by plugin name. Run `cpd explain` for why the names can differ.",
      );
    }

    const noteText = noteLines.join("\n");
    lines.push(c ? s.dim(noteText) : noteText);
  }

  if (r.recommendation?.cmd) {
    lines.push("");
    lines.push("Fix:");
    lines.push(`  ${s.cmd(r.recommendation.cmd)}`);
  }

  // Footer
  lines.push("");
  if (report.logFile) {
    lines.push(`Log file        ${s.dim(tildify(report.logFile))}`);
  }
  // Run ID is mostly useful for bug reports and JSON-to-human cross-reference.
  // For everyday human output it's noise; gate behind --verbose. Always present
  // in --json output and on the first line of the log file regardless.
  if (opts.verbose) {
    lines.push(`Run ID          ${s.dim(report.runId)}`);
  }
  lines.push("");
  const exitMsg =
    report.exitCode === 0
      ? "Exit code: 0  (no drift)"
      : report.exitCode === 2
        ? "Exit code: 2  (drift detected, fixes available)"
        : report.exitCode === 64
          ? "Exit code: 64  (E_USAGE — multiple matches; pick one)"
          : "Exit code: 3  (drift detected, manual action required)";
  lines.push(s.exit(report.exitCode, exitMsg));
  return `${lines.join("\n")}\n`;
}

export function renderHumanCheck(report: CheckReport, opts: RenderOpts): string {
  const c = opts.color;
  const s = styler(c);
  const lines: string[] = [];

  // RPM-only match (Cowork "Personal plugins" UI install path) — render a
  // dedicated view since the CCD-style PluginReport shape doesn't apply.
  if (!report.plugin && report.rpmMatch) {
    return renderHumanCheckRpmOnly(report, opts);
  }

  // Ambiguous RPM match — ≥2 RPM entries share the typed plugin name.
  // Render disambiguation block and exit 64 (E_USAGE).
  if (report.rpmMatchAmbiguous) {
    const fb = (report.fullReport as { _modeFallback?: { requested: string; foundIn: string } })
      ._modeFallback;
    if (fb) {
      const fromLabel = fb.requested === "ccd" ? "standalone Claude Code" : "Claude Cowork";
      const inLabel = fb.foundIn === "ccd" ? "standalone Claude Code" : "Claude Cowork";
      const msg = `Note: you asked about ${fromLabel}, but the plugin is installed in ${inLabel} (via the in-app Plugins UI). Showing ${inLabel} details.`;
      lines.push(c ? pcOn.yellow(msg) : msg);
      lines.push("");
    }
    const pluginName = report.pluginId.slice(0, report.pluginId.lastIndexOf("@"));
    const ambigMsg = `Plugin "${pluginName}" is installed under multiple marketplaces in Claude Cowork.\nPick one to investigate:`;
    lines.push(c ? pcOn.yellow(ambigMsg) : ambigMsg);
    lines.push("");
    for (let i = 0; i < report.rpmMatchAmbiguous.candidates.length; i++) {
      const cand = report.rpmMatchAmbiguous.candidates[i];
      if (!cand) continue;
      const mpIdSuffix =
        opts.verbose && cand.marketplaceId
          ? `  (marketplaceId: ${cand.marketplaceId})`
          : cand.marketplaceId
            ? `  (marketplaceId: ${cand.marketplaceId.slice(0, 20)}...)`
            : "";
      lines.push(`  ${i + 1}. ${cand.suggestedDisambiguatedId}${mpIdSuffix}`);
      lines.push(`     ${s.cmd(`cpd check ${cand.suggestedDisambiguatedId} --mode cowork`)}`);
    }
    lines.push("");
    lines.push(s.exit(64, "Exit code: 64  (E_USAGE — multiple matches; pick one)"));
    return `${lines.join("\n")}\n`;
  }

  if (!report.plugin) {
    lines.push(
      c
        ? pcOn.red(`Plugin "${report.pluginId}" is not installed.`)
        : `Plugin "${report.pluginId}" is not installed.`,
    );
    lines.push(`Try ${s.cmd("cpd list")} to see installed plugins.`);
    lines.push("");
    lines.push(s.exit(report.exitCode, `Exit code: ${report.exitCode}`));
    return `${lines.join("\n")}\n`;
  }

  // Surface the implicit-mode-fallback hint when `cpd check --mode X` was
  // used but the plugin actually lives in mode Y. (Set by runV05Check.)
  const fb = (report.fullReport as { _modeFallback?: { requested: string; foundIn: string } })
    ._modeFallback;
  if (fb) {
    const fromLabel = fb.requested === "ccd" ? "standalone Claude Code" : "Claude Cowork";
    const inLabel = fb.foundIn === "ccd" ? "standalone Claude Code" : "Claude Cowork";
    const msg = `Note: you asked about ${fromLabel}, but the plugin is installed in ${inLabel}. Showing ${inLabel} details.`;
    lines.push(c ? pcOn.yellow(msg) : msg);
    lines.push("");
  }

  const p = report.plugin;
  const m = report.marketplace;
  // Display the canonical scope (user → project → local → first) rather than
  // file order so a stale user-scope install isn't hidden by a fresh local
  // install that happens to be listed first (audit #12).
  const primary = preferredScope(p);

  // Header — explicitly identify which install of Claude this report is
  // about. The mode indicator goes inline next to the plugin id (parallel
  // with the RPM-only renderer's "(installed via Claude Cowork's in-app
  // Plugins UI)" tag), so users always know what they're looking at —
  // whether they passed --mode or relied on the default.
  const primaryPath = primary?.installPath ?? "";
  const inCowork = primaryPath.includes("local-agent-mode-sessions");
  const modeTag = inCowork ? "(in Claude Cowork)" : "(in standalone Claude Code)";
  lines.push(`Plugin:        ${s.bold(p.id)}  ${s.dim(modeTag)}`);
  if (m) {
    // For github source, `github.com/<slug>` reads better than `github
    // acme/foo` (the bare codename was redundant alongside the slug). For
    // directory source, tildify the path. The sourceType moves to a dim
    // parenthetical at the end for users who want it.
    const display =
      m.sourceType === "github"
        ? `github.com/${m.sourceDetail}`
        : m.sourceType === "directory"
          ? tildify(m.sourceDetail)
          : m.sourceDetail;
    lines.push(`Source:        ${display} ${s.dim(`(${m.sourceType})`)}`);
  }
  if (primary) {
    // Surface the marketplace's known version inline when it differs from
    // the installed version — saves the user from scanning the layer-2
    // detail block to learn whether they're stale. Skip when versions match
    // (no signal to add) or when marketplace version is unknown.
    const installedVer = primary.version;
    const mpVer = p.marketplaceVersion;
    let versionTag = "";
    if (mpVer && mpVer !== installedVer) {
      versionTag = ` ${s.dim(`(latest: ${mpVer} — stale)`)}`;
    }
    lines.push(
      `Installed:     ${s.bold(installedVer)}${versionTag}  ${s.dim(
        `(scope=${primary.scope}${p.scopes.length > 1 ? `, +${p.scopes.length - 1} other` : ""})`,
      )}`,
    );
    if (primary.gitCommitSha) {
      lines.push(`               commit  ${primary.gitCommitSha.slice(0, 12)}`);
    }
    // C4: in default mode, hide `at` when single-scope (install path is obvious);
    // show when multi-scope (only signal of which scope's install is being reported).
    // In --verbose: always show.
    if (opts.verbose || p.scopes.length >= 2) {
      lines.push(`               at      ${tildify(primary.installPath)}`);
    }
    // C4: in default mode, hide `since` (install age is less actionable than last update).
    if (opts.verbose && primary.installedAt) {
      lines.push(`               since   ${s.dim(humanTimestamp(primary.installedAt))}`);
    }
    if (primary.lastUpdated) {
      lines.push(`               last update  ${s.dim(humanTimestamp(primary.lastUpdated))}`);
    }
  }
  lines.push("");

  // Per-layer breakdown — full evidence dump.
  // Labels use plain English (cache layer names, not Layer N numbers — the
  // numbering is internal taxonomy; users learn it from `cpd explain` if
  // they want to). Tracking comment for maintainers: marketplace_clone=L1,
  // install_snapshot=L2, cowork_mirror=L3, rpm_copy=L5, ccd_remote_ssh=L6.
  const layerOrder: { key: keyof typeof p.checks; label: string }[] = [
    { key: "marketplace_clone", label: `Marketplace clone${m ? ` (${m.name})` : ""}` },
    { key: "install_snapshot", label: "Plugin install on disk" },
    { key: "cowork_mirror", label: "Claude Cowork session mirror" },
    { key: "rpm_copy", label: "Cowork in-app install (Personal plugins)" },
    { key: "ccd_remote_ssh", label: "Standalone Claude Code remote SSH cache" },
  ];

  // Fix-prelude — surface the deduped recommended sequence at the top so
  // the actionable answer is the FIRST thing the user sees, before the
  // 6-layer diagnostic evidence dump. Computed up-front; the same recs
  // are NOT re-rendered as a footer (would be redundant). Per-layer `→`
  // lines stay (they're the home for non-cmd `recommendation.action`
  // advice and tell users which layer wants which fix).
  // Collect raw cmd strings for the prelude, and also detect manual recs.
  // A1: if the primary stale layer has a manual recommendation (bump-needed, etc.),
  // render a numbered prose block instead of the placeholder cmd.
  const preludeRawRecs: string[] = [];
  // Track which layer has the primary manual rec (priority: install_snapshot first).
  let primaryManualRec: {
    rec: { cmd?: string; action: string };
    evidence: Record<string, unknown>;
  } | null = null;
  const manualRecLayerPriority: (keyof typeof p.checks)[] = [
    "install_snapshot",
    "marketplace_clone",
    "cowork_mirror",
    "rpm_copy",
    "ccd_remote_ssh",
  ];
  for (const key of manualRecLayerPriority) {
    const r = p.checks[key];
    if ((r.status === "stale" || r.status === "missing") && r.recommendation) {
      if (isManualRec(r.recommendation, r.evidence)) {
        primaryManualRec = { rec: r.recommendation, evidence: r.evidence };
        break;
      }
    }
  }
  // Collect cmd strings for non-manual (runnable) recs.
  for (const { key } of layerOrder) {
    const r = p.checks[key];
    if (r.status === "stale" || r.status === "missing") {
      const cmd = r.recommendation?.cmd;
      const rec = r.recommendation;
      // Only collect if NOT a manual rec (manual recs rendered via formatManualSteps).
      if (cmd && rec && !preludeRawRecs.includes(cmd) && !isManualRec(rec, r.evidence)) {
        preludeRawRecs.push(cmd);
      }
    }
  }
  const preludeRecs = dedupSubchains(preludeRawRecs);
  // Track whether the prelude rendered a manual-steps block (for A2 suppression).
  let preludeHasManualBlock = false;

  // A2: helper to detect if a per-layer cmd is subsumed (as a contiguous sub-chain)
  // by any cmd in the deduped prelude.
  function isCmdSubsumedByPrelude(cmd: string): boolean {
    const bSegs = splitTopLevelAndAnd(cmd);
    for (const preludeCmd of preludeRecs) {
      const aSegs = splitTopLevelAndAnd(preludeCmd);
      if (bSegs.length === 0 || aSegs.length === 0) continue;
      // Search b as a contiguous sub-array of a.
      outer: for (let s = 0; s + bSegs.length <= aSegs.length; s++) {
        for (let k = 0; k < bSegs.length; k++) {
          if (aSegs[s + k] !== bSegs[k]) continue outer;
        }
        return true; // found as sub-chain
      }
    }
    return false;
  }

  // Build the source context for A1 manual-step prose synthesis.
  const manualStepCtx: ManualStepSourceContext = {
    pluginName: p.pluginName,
    marketplaceName: m?.name ?? p.marketplace,
    sourceType: m?.sourceType ?? "unknown",
    sourceDetail: m?.sourceDetail ?? "",
    pluginEntrySourceKind:
      typeof p.checks.install_snapshot.evidence.pluginEntrySourceKind === "string"
        ? (p.checks.install_snapshot.evidence.pluginEntrySourceKind as string)
        : "clone-unreadable",
  };

  // Render the Fix: prelude.
  if (primaryManualRec !== null) {
    // A1: render a numbered manual-steps block.
    const manualOutput = formatManualSteps(
      primaryManualRec.rec,
      primaryManualRec.evidence,
      manualStepCtx,
      c,
    );
    if (manualOutput !== null) {
      // formatManualSteps returns the header ("Fix (manual, N steps):") + steps as one string.
      // Split on first newline so we can bold the header line.
      const firstNl = manualOutput.indexOf("\n");
      if (firstNl > 0) {
        lines.push(s.bold(manualOutput.slice(0, firstNl)));
        lines.push(manualOutput.slice(firstNl + 1));
      } else {
        lines.push(s.bold(manualOutput));
      }
      lines.push("");
      preludeHasManualBlock = true;
    } else if (preludeRecs.length > 0) {
      // formatManualSteps returned null — fall back to cmd rendering.
      lines.push(s.bold("Fix:"));
      renderPreludeCmds(preludeRecs);
      lines.push("");
    }
  } else if (preludeRecs.length > 0) {
    lines.push(s.bold("Fix:"));
    renderPreludeCmds(preludeRecs);
    lines.push("");
  }

  function renderPreludeCmds(recs: string[]): void {
    if (recs.length === 1) {
      // Single cmd: render directly under "Fix:" with 2-space indent.
      const cmd = recs[0] ?? "";
      const segs = splitTopLevelAndAnd(cmd);
      if (segs.length <= 1 || cmd.length <= 80) {
        lines.push(`  ${styleCmdBody(cmd, c)}`);
      } else {
        const formatted = formatRecCmd(cmd, { color: c, header: "", indent: "  " });
        lines.push(formatted.replace(/^\n*/, ""));
      }
    } else {
      recs.forEach((cmd, i) => {
        lines.push(
          formatRecCmd(cmd, { color: c, header: `  ${s.dim(`${i + 1}.`)}`, indent: "     " }),
        );
      });
    }
  }

  // C1: evidence keys shown in default mode when layer-1 is stale (curated whitelist).
  // Other keys move to --verbose.
  const LAYER1_STALE_KEYS = new Set(["headLocal", "headRemote", "commitsBehind"]);

  // C2: human-readable relabeling of jargon evidence keys (display-only; JSON unchanged).
  const EVIDENCE_KEY_LABELS: Record<string, string> = {
    versionTrapKind: "drift kind",
    pluginEntrySourceKind: "source kind",
    resolvedVersionSource: "version came from",
    installedGitCommitSha: "installed commit (full)",
    marketplaceCloneHead: "clone HEAD (full)",
  };

  // C3: identify the three "other" layers that can be collapsed.
  const collapsibleKeys: (keyof typeof p.checks)[] = [
    "cowork_mirror",
    "rpm_copy",
    "ccd_remote_ssh",
  ];
  const collapsibleLabels: Record<string, string> = {
    cowork_mirror: "Cowork session mirror",
    rpm_copy: "Cowork in-app install",
    ccd_remote_ssh: "remote SSH cache",
  };

  // Count how many collapsible layers are n/a or not-implemented.
  const naCount = collapsibleKeys.filter((k) => {
    const st = p.checks[k].status;
    return st === "skipped" || st === "unknowable";
  }).length;

  // Render each layer section.
  function renderLayerSection(key: keyof typeof p.checks, label: string): void {
    const r = p.checks[key];
    const tok = statusToken(r.status, c);
    lines.push(s.bold(label));
    // Detail strings can contain `\n` for layers that want structured
    // multi-line output (e.g. version-trap's cause/installed/clone/fix
    // breakdown). The first line goes inline with the status; remaining
    // lines get the standard 5-space indent.
    const detailLines = r.detail.split("\n");
    const firstDetail = detailLines[0] ?? "";
    lines.push(
      `  ${tok} ${humanStatus(r.status, key, r.evidence)}${firstDetail ? ` — ${firstDetail}` : ""}`,
    );
    for (const cont of detailLines.slice(1)) {
      lines.push(`     ${cont}`);
    }

    // Evidence dump — gated by C1 (layer 1) and C2 (all layers).
    const shouldShowEvidence =
      opts.verbose ||
      // In default mode: only show evidence for layer-1 when it's stale
      // (curated whitelist), not for other layers.
      (key === "marketplace_clone" && (r.status === "stale" || r.status === "missing"));

    if (shouldShowEvidence) {
      const evidenceKeys = Object.keys(r.evidence)
        .filter((k) => !HIDDEN_EVIDENCE_KEYS.has(k))
        .sort();
      for (const ek of evidenceKeys) {
        // C1: in default mode, layer-1 stale shows only the whitelisted keys.
        if (!opts.verbose && key === "marketplace_clone" && !LAYER1_STALE_KEYS.has(ek)) continue;
        const v = r.evidence[ek];
        if (v === undefined) continue;
        const val = typeof v === "string" ? v : JSON.stringify(v);
        // C10: skip evidence whose value appears verbatim in the detail string.
        if (typeof v === "string" && valueInDetail(v, r.detail)) continue;
        // C2: use relabeled display name for jargon keys in --verbose mode.
        const displayKey = opts.verbose ? (EVIDENCE_KEY_LABELS[ek] ?? ek) : ek;
        lines.push(`     ${s.dim(displayKey.padEnd(28))} ${val}`);
      }
    } else if (!opts.verbose && key !== "marketplace_clone") {
      // C2: in default mode, skip the evidence-key dump for non-layer-1 layers.
      // (Nothing to do here — the block just falls through.)
    }

    // A2: suppress per-layer recommendation arrow when its cmd is already
    // subsumed by the top-level Fix: prelude (avoids duplicate output).
    // Also suppress when prelude rendered a manual-steps block for this layer's rec.
    if (r.recommendation) {
      const recCmd = r.recommendation.cmd;
      const isManual = isManualRec(r.recommendation, r.evidence);
      const shouldSuppress =
        // Case 1: cmd is a sub-chain of something in the prelude
        (recCmd !== undefined && preludeRecs.length > 0 && isCmdSubsumedByPrelude(recCmd)) ||
        // Case 2: prelude rendered a manual block that covers this manual rec
        (isManual && preludeHasManualBlock) ||
        // Case 3: manual rec cmd (with placeholders) was collected in preludeRecs
        (recCmd !== undefined && preludeRecs.includes(recCmd));
      if (!shouldSuppress) {
        const cmd = recCmd ?? r.recommendation.action;
        lines.push(
          formatRecCmd(cmd, {
            color: c,
            header: `     ${s.arrow("→")}`,
            indent: "       ",
          }),
        );
      }
    }
    lines.push("");
  }

  // Render layer 1 (marketplace clone) and layer 2 (install snapshot) always.
  renderLayerSection("marketplace_clone", layerOrder[0]?.label ?? "Marketplace clone");
  renderLayerSection("install_snapshot", layerOrder[1]?.label ?? "Plugin install on disk");

  // C3: collapse logic for the three "other" layers.
  if (opts.verbose || naCount < 2) {
    // Show each of the three layers in full.
    for (const { key, label } of layerOrder.slice(2)) {
      renderLayerSection(key, label);
    }
  } else {
    // ≥2 of 3 are n/a — render any non-n/a layer first, then a single collapse line.
    const nonNaKeys = collapsibleKeys.filter((k) => {
      const st = p.checks[k].status;
      return st !== "skipped" && st !== "unknowable";
    });
    const naKeys = collapsibleKeys.filter((k) => {
      const st = p.checks[k].status;
      return st === "skipped" || st === "unknowable";
    });

    // Render non-n/a layers in full.
    for (const key of nonNaKeys) {
      const matchedEntry = layerOrder.find((e) => e.key === key);
      if (matchedEntry) renderLayerSection(key, matchedEntry.label);
    }

    // Single collapse line for the n/a layers. Backend marketplace catalogue
    // (Layer 4 in the six-layer model) is server-side and has no local cache,
    // so it never appears in the per-layer dump — but include it here for
    // accounting completeness so the output reflects all six layers.
    if (naKeys.length > 0) {
      const nameList = naKeys.map((k) => collapsibleLabels[k] ?? k).join(", ");
      lines.push(
        `Other caches       not applicable here (${nameList}, backend marketplace catalogue (server-side, no local cache))`,
      );
      lines.push("");
    }
  }

  // Footer
  // A3: when the plugin was found via fallback to CCD, the cowork session is
  // not load-bearing for this check. In default mode, hide it to avoid
  // contradicting "this answer came from CCD". In --verbose mode, annotate.
  const coworkActive = report.fullReport.roots?.coworkActive;
  if (coworkActive) {
    if (fb?.foundIn === "ccd") {
      // Plugin is in standalone Claude Code, not Cowork — the Cowork
      // session is not load-bearing for this check. Render the line
      // anyway (so footer fields are deterministic across modes), but
      // mark it explicitly so the user doesn't read it as authoritative.
      const tilded = tildify(coworkActive);
      let displayPath: string;
      if (opts.verbose) {
        displayPath = tilded;
      } else {
        const UUID_RE_SEG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        displayPath = tilded
          .split("/")
          .map((seg) => (UUID_RE_SEG.test(seg) ? `${seg.slice(0, 8)}…` : seg))
          .join("/");
      }
      lines.push(`Active session  ${displayPath} ${s.dim("(not used for this check)")}`);
    } else {
      // 3.4: in default mode, shorten UUID segments in the path.
      // The path has the form: <userData>/local-agent-mode-sessions/<acc>/<org>
      // Replace the UUID portions with short form; tildify the prefix.
      const tilded = tildify(coworkActive);
      let displayPath: string;
      if (opts.verbose) {
        displayPath = tilded;
      } else {
        // Walk path segments and shorten UUID-looking ones.
        const UUID_RE_SEG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const segs = tilded.split("/");
        displayPath = segs
          .map((seg) => (UUID_RE_SEG.test(seg) ? `${seg.slice(0, 8)}…` : seg))
          .join("/");
      }
      lines.push(`Active session  ${displayPath}`);
    }
  }
  if (report.logFile) {
    lines.push(`Log file        ${s.dim(tildify(report.logFile))}`);
  }
  if (opts.verbose) {
    lines.push(`Run ID          ${s.dim(report.runId)}`);
  }
  lines.push("");

  // (Recommended sequence footer dropped — now rendered as the `Fix:`
  // prelude at the top, so the user sees the actionable answer first.)

  const hint = maybeExplainHint(lines.join("\n"), c);
  if (hint) {
    lines.push(hint);
    lines.push("");
  }

  // When exit code is 0 but at least one layer's status is "unknowable" (e.g.
  // --no-network blocked the layer-1 probe), "everything fresh" is dishonest.
  // Surface the inconclusive case explicitly so users can re-run with network
  // access, or know to trust the result with caveat.
  const someUnknown = (
    [
      "marketplace_clone",
      "install_snapshot",
      "cowork_mirror",
      "rpm_copy",
      "ccd_remote_ssh",
    ] as const
  ).some((k) => p.checks[k]?.status === "unknowable");
  const exitSuffix =
    report.exitCode === 0
      ? someUnknown
        ? "  (no drift detected, but some layers were inconclusive — re-run without --no-network for a definitive answer)"
        : "  (everything fresh — no action needed)"
      : report.exitCode === 2
        ? "  (drift detected, fixes available)"
        : "  (drift detected, manual action required)";
  lines.push(s.exit(report.exitCode, `Exit code: ${report.exitCode}${exitSuffix}`));

  return `${lines.join("\n")}\n`;
}

// ── Refresh command renderer ─────────────────────────────────────────────

import type { RefreshReport } from "../commands/refresh.js";

export function renderHumanRefresh(report: RefreshReport, opts: RenderOpts): string {
  const c = opts.color;
  const s = styler(c);
  const lines: string[] = [];

  const beforeHead = (report.before.layer1.evidence.headLocal as string | undefined) ?? "(?)";
  const afterHead = (report.after.layer1.evidence.headLocal as string | undefined) ?? "(?)";

  lines.push(`${s.bold("Refresh:")} ${s.bold(report.marketplace)}`);
  lines.push("");
  lines.push(s.bold("Before:"));
  lines.push(`  marketplace HEAD            ${beforeHead.slice(0, 12)}`);
  for (const p of report.before.plugins) {
    const v = p.installedVersion ?? "?";
    const sha = preferredScope(p).gitCommitSha?.slice(0, 7) ?? "-";
    lines.push(`  ${p.id.padEnd(40)} ${v}  ${s.dim(`(installed-from ${sha})`)}`);
  }
  lines.push("");
  // Label the "Running:" line by which path performed the refresh. force-fetch
  // is the v0.5 bypass for Anthropic issue #46081 (silent-fail of `claude
  // plugin marketplace update`); the user explicitly opted in.
  const runCmd =
    report.refreshMethod === "force-fetch"
      ? `git fetch origin && git reset --hard origin/<branch>  ${s.dim("(--force-fetch bypass; cwd=<clone>)")}`
      : `claude plugin marketplace update ${report.marketplace}`;
  if (report.claudeUpdate.ok) {
    const tok = glyph("ok", c);
    lines.push(`Running: ${s.cmd(runCmd)}...`);
    const successLabel =
      report.refreshMethod === "force-fetch"
        ? `force-fetched ${report.marketplace}`
        : `updated ${report.marketplace}`;
    lines.push(`${tok} ${successLabel}`);
    if (report.refreshMethod === "force-fetch" && report.claudeUpdate.stderr.trim()) {
      lines.push(`    ${s.dim(report.claudeUpdate.stderr.trim())}`);
    }
  } else {
    const tok = glyph("fail", c);
    lines.push(`Running: ${s.cmd(runCmd)}...`);
    const failLabel =
      report.refreshMethod === "force-fetch" ? "force-fetch failed" : "claude command failed";
    lines.push(`${tok} ${failLabel} ${s.dim(`(exit ${report.claudeUpdate.exitCode})`)}:`);
    if (report.claudeUpdate.stderr.trim()) {
      for (const line of report.claudeUpdate.stderr.trim().split("\n")) {
        lines.push(`    ${line}`);
      }
    }
  }
  lines.push("");
  lines.push(s.bold("After:"));
  const headChanged = beforeHead !== afterHead;
  lines.push(
    `  marketplace HEAD            ${afterHead.slice(0, 12)}  ${s.dim(
      headChanged ? `(was ${beforeHead.slice(0, 7)})` : "(unchanged)",
    )}`,
  );
  // 5.1: surface [?] legend when any after-plugin shows unknown status — the
  // most common cause is `--no-network` (Layer 1 status unknowable, Layer 2
  // can't distinguish refresh-needed from bump-needed).
  const afterHasUnknowable = report.after.plugins.some(
    (p) => p.checks.install_snapshot.status === "unknowable",
  );
  if (afterHasUnknowable) {
    lines.push(
      s.dim("  (? = could not determine — re-run without --no-network for full diagnosis)"),
    );
  }
  // For each plugin: if its layer-2 status is now stale or missing, include the
  // recommendation. If fresh, just show the version.
  for (const p of report.after.plugins) {
    const v = p.installedVersion ?? "?";
    const status = p.checks.install_snapshot.status;
    const tok = statusToken(status, c);
    lines.push(`  ${tok} ${p.id.padEnd(40)} ${v}  ${p.checks.install_snapshot.detail}`);
    const cmd = p.primaryRecommendation?.cmd;
    if (cmd && (status === "stale" || status === "missing")) {
      lines.push(
        formatRecCmd(cmd, {
          color: c,
          header: `     ${s.arrow("→")}`,
          indent: "       ",
        }),
      );
    }
  }
  lines.push("");

  if (report.chainedUpdates && report.chainedUpdates.length > 0) {
    lines.push(s.bold(`Chained updates ${s.dim("(--auto-update)")}:`));
    for (const cu of report.chainedUpdates) {
      const tok = statusToken(cu.ok ? "fresh" : "missing", c);
      lines.push(
        `  ${tok} ${s.cmd(`claude plugin update ${cu.id}`)}  ${s.dim(
          `(exit ${cu.exitCode})`,
        )}${cu.stderr.trim() ? ` — ${cu.stderr.trim().split("\n")[0]}` : ""}`,
      );
    }
    lines.push("");
  } else if (
    report.after.plugins.some((p) =>
      p.primaryRecommendation?.cmd?.startsWith("claude plugin update "),
    )
  ) {
    lines.push(`Run with ${s.cmd("--auto-update")} to chain those updates automatically.`);
    lines.push("");
  }

  // 2.2: When the marketplace HEAD didn't advance after a non-force-fetch
  // refresh, hint the user toward --force-fetch (Anthropic issue #46081
  // workaround for silent-no-op of `claude plugin marketplace update`).
  // `afterHead` and `beforeHead` are declared at the top of this function.
  if (
    report.refreshMethod !== "force-fetch" &&
    afterHead === beforeHead &&
    report.after.layer1.status === "stale"
  ) {
    lines.push(
      s.dim(
        `Hint: run \`cpd refresh --force-fetch ${report.marketplace} --yes\` if \`claude plugin marketplace update\` is silently no-op'ing (Anthropic issue #46081).`,
      ),
    );
    lines.push("");
  }

  if (report.logFile) lines.push(`Log file        ${s.dim(tildify(report.logFile))}`);
  if (opts.verbose) {
    lines.push(`Run ID          ${s.dim(report.runId)}`);
  }
  lines.push("");

  const hint = maybeExplainHint(lines.join("\n"), c);
  if (hint) {
    lines.push(hint);
    lines.push("");
  }

  const exitSuffix =
    report.exitCode === 0
      ? "  (everything fresh)"
      : report.exitCode === 2
        ? "  (drift remains, fixes available)"
        : "  (drift remains, manual action required)";
  lines.push(s.exit(report.exitCode, `Exit code: ${report.exitCode}${exitSuffix}`));

  return `${lines.join("\n")}\n`;
}

// ── List command renderer ───────────────────────────────────────────────

import { BUILTIN_SKILLS } from "../caches/skills-plugin.js";
import type { ListReport, NameCollisionEntry } from "../commands/list.js";

export function renderHumanList(report: ListReport, opts: RenderOpts): string {
  const c = opts.color;
  const s = styler(c);
  const lines: string[] = [];

  // Build a map of plugin name → collision entries for annotation.
  type CollisionMap = Map<string, NameCollisionEntry[]>;
  const collisionByName: CollisionMap = new Map();
  if (report.nameCollisions) {
    for (const group of report.nameCollisions) {
      collisionByName.set(group.pluginName, group.entries);
    }
  }

  // ── Headline verdict + summary ──────────────────────────────────────────────
  // Lead with the bottom line (matches `cpd scan`'s headline), then the
  // count summary. Users skimming a 200+-line list see the verdict + shape
  // before the detail tables.
  const mpBroken = report.marketplaces.filter(
    (m) => m.layer1.status === "stale" || m.layer1.status === "missing",
  ).length;
  const pluginAffected = report.plugins.filter(
    (p) =>
      p.checks.install_snapshot.status === "stale" ||
      p.checks.install_snapshot.status === "missing",
  ).length;
  // Verdict line — same shape as renderHuman (scan).
  if (report.exitCode === 0) {
    const okMark = glyph("ok", c);
    lines.push(`${okMark} ${s.bold("Everything fresh")} — no drift detected.`);
  } else {
    const xMark = glyph("fail", c);
    const exitNote =
      report.exitCode === 3
        ? "manual action required"
        : report.exitCode === 2
          ? "fixes available"
          : `exit ${report.exitCode}`;
    const issues: string[] = [];
    if (mpBroken > 0)
      issues.push(`${mpBroken} marketplace${mpBroken === 1 ? "" : "s"} broken/stale`);
    if (pluginAffected > 0)
      issues.push(`${pluginAffected} plugin${pluginAffected === 1 ? "" : "s"} affected`);
    const summaryPart = issues.length > 0 ? ` — ${issues.join(", ")}` : "";
    lines.push(`${xMark} ${s.bold("Drift detected")}${summaryPart}  ${s.dim(`(${exitNote})`)}`);
  }
  // Inventory summary line (counts).
  const segments: string[] = [];
  const mpSuffix = mpBroken > 0 ? s.dim(` (${mpBroken} broken/stale)`) : "";
  segments.push(
    `${report.marketplaces.length} marketplace${report.marketplaces.length === 1 ? "" : "s"}${mpSuffix}`,
  );
  const pluginSuffix = pluginAffected > 0 ? s.dim(` (${pluginAffected} affected)`) : "";
  segments.push(
    `${report.plugins.length} plugin${report.plugins.length === 1 ? "" : "s"}${pluginSuffix}`,
  );
  if (report.rpmPlugins.length > 0) {
    segments.push(`${report.rpmPlugins.length} in Claude Cowork (in-app)`);
  }
  lines.push(segments.join(s.dim("  ·  ")));
  lines.push("");

  lines.push(s.bold(`Marketplaces (${report.marketplaces.length})`));
  for (const m of report.marketplaces) {
    const tok = statusToken(m.layer1.status, c);
    // Settings-only marketplaces (declared via extraKnownMarketplaces in
    // settings sources but not materialized as a clone) get an explicit
    // annotation so users understand why their layer1 status is "skipped".
    // Reviewer #4 / #5 work; gist revision 2026-05-06T11:45:05Z.
    const settingsOnlyLabel =
      m.hasClone === false
        ? `  ${s.dim(`(settings-only: ${(m.declaredIn ?? []).join(", ")})`)}`
        : "";
    lines.push(
      `  ${tok} ${m.name.padEnd(36)} ${s.dim(m.sourceType.padEnd(10))} ${m.sourceDetail}${settingsOnlyLabel}${
        m.layer1.detail && m.layer1.status !== "fresh" && m.hasClone !== false
          ? `  ${s.dim(`(${m.layer1.detail})`)}`
          : ""
      }`,
    );
  }
  lines.push("");

  const hasUnknowablePlugin = report.plugins.some(
    (p) => p.checks.install_snapshot.status === "unknowable",
  );
  lines.push(s.bold(`Plugins (${report.plugins.length})`));
  // 5.1: surface [?] legend when any plugin shows unknown status.
  if (hasUnknowablePlugin) {
    lines.push(
      s.dim("  (? = version unknown — marketplace.json has no version field for this plugin)"),
    );
  }
  for (const p of report.plugins) {
    const status = p.checks.install_snapshot.status;
    const tok = statusToken(status, c);
    const v = p.installedVersion ?? "?";
    const scope = preferredScope(p).scope;

    // 5.1: flag managed-scope entries with Desktop-dropped note.
    const managedNote =
      scope === "managed"
        ? `  ${s.dim("(managed scope — silently dropped by Desktop runtime; not active in Claude Desktop)")}`
        : "";

    const detail =
      status === "stale" || status === "missing" ? `  ${p.checks.install_snapshot.detail}` : "";
    lines.push(
      `  ${tok} ${p.id.padEnd(48)} ${v.padEnd(10)} ${s.dim(scope)}${detail}${managedNote}`,
    );

    // 4.3: cross-reference annotations.
    const collisions = collisionByName.get(p.pluginName);
    if (collisions && collisions.length >= 2) {
      const others = collisions.filter((e) => e.id !== p.id);
      for (const other of others) {
        if (other.kind === "rpm") {
          lines.push(
            `       ${s.dim(`(also installed in Claude Cowork (in-app) as \`${other.id}\`)`)}`,
          );
        } else {
          lines.push(
            `       ${s.dim(`(name collision: also installed as \`${other.id}\` in standalone Claude Code)`)}`,
          );
        }
      }
    }
  }
  lines.push("");

  if (report.rpmPlugins.length > 0) {
    lines.push(s.bold(`Plugins installed in Claude Cowork (in-app) (${report.rpmPlugins.length})`));
    for (const r of report.rpmPlugins) {
      const tok = statusToken(r.layer5.status, c);
      const rpmName = r.name;
      const mpName = r.marketplaceName;
      const displayId = rpmName && mpName ? `${rpmName}@${mpName}` : r.pluginId;
      // 4.1: render updatedAt via humanTimestamp instead of raw ISO string.
      const rawUpdatedAt =
        typeof r.layer5.evidence.updatedAt === "string" ? r.layer5.evidence.updatedAt : undefined;
      const detail = rawUpdatedAt
        ? r.layer5.detail.replace(rawUpdatedAt, humanTimestamp(rawUpdatedAt))
        : r.layer5.detail;
      lines.push(`  ${tok} ${displayId.padEnd(40)} ${detail}`);

      // 4.3: cross-reference annotations for RPM plugins.
      if (rpmName) {
        const collisions = collisionByName.get(rpmName);
        if (collisions && collisions.length >= 2) {
          const others = collisions.filter((e) => e.id !== `${rpmName}@${mpName ?? "(unknown)"}`);
          for (const other of others) {
            if (other.kind === "ccd") {
              lines.push(
                `       ${s.dim(`(also installed in standalone Claude Code as \`${other.id}\`)`)}`,
              );
            } else {
              lines.push(
                `       ${s.dim(`(name collision in Claude Cowork: also ${rpmName} under \`${other.marketplaceName}\`)`)}`,
              );
            }
          }
        }
      }
    }
    lines.push("");
  }

  // 5.4: Skills-plugin section.
  // Shorten UUIDs to first 8 chars in default mode (UUIDs are 36 chars; full IDs
  // bloat the section header and most users only need a recognizer, not the
  // whole identifier). --verbose keeps the full UUIDs for users who need them.
  // shortId imported from uuid-format.ts (promoted in 3.1).
  if (report.skillsPlugin && report.skillsPlugin.pairs.length > 0) {
    const spRoot = report.skillsPlugin;
    for (const pair of spRoot.pairs) {
      const orgDisplay = opts.verbose ? pair.orgId : shortId(pair.orgId);
      const accDisplay = opts.verbose ? pair.accountId : shortId(pair.accountId);
      lines.push(
        s.bold(
          `Claude Cowork built-in skills  (org ${orgDisplay} / account ${accDisplay} — Anthropic-managed)`,
        ),
      );
      if (opts.verbose) {
        lines.push(
          s.dim(
            "  Built-ins (schedule, setup-cowork, consolidate-memory) are bundled into Desktop and rewritten on every sync;",
          ),
        );
        lines.push(
          s.dim(
            "  cannot go stuck via the API-download path. Other skills are API-downloaded and CAN go stuck.",
          ),
        );
      }
      for (const skill of pair.skills) {
        const isBuiltIn = BUILTIN_SKILLS.has(skill.skillName);
        // isUserCreated is set by tier C (skills-plugin reader) and the v0.5
        // list path, both of which consult the manifest. Annotation order:
        // built-in wins over user-created in the (theoretically impossible)
        // collision case — built-ins are reserved names.
        const label = isBuiltIn
          ? `  ${s.dim("(built-in)")}`
          : skill.isUserCreated
            ? `  ${s.dim("(user-created)")}`
            : "";
        lines.push(`  ${skill.skillName}${label}`);
      }
      lines.push("");
    }
  }

  if (report.coworkRoots.length > 0) {
    // 3.2: structured rendering with active marker, tildified path, age band.
    // Active marker is computed renderer-side from max installedPluginsMtime.
    const maxMtime = Math.max(
      ...report.coworkRoots.map((r) => r.installedPluginsMtime ?? 0).filter((m) => m > 0),
    );
    lines.push(s.bold(`Claude Cowork session storage roots (${report.coworkRoots.length})`));
    for (const r of report.coworkRoots) {
      const isActive =
        r.installedPluginsMtime !== undefined && r.installedPluginsMtime === maxMtime;
      const marker = isActive ? "[active]" : "        ";
      const accDisplay = opts.verbose ? r.accountId : shortId(r.accountId);
      const orgDisplay = opts.verbose ? r.orgId : shortId(r.orgId);
      const tilded = tildify(r.path);
      let agePart = "";
      if (r.installedPluginsMtime && r.installedPluginsMtime > 0) {
        const diffSec = Math.round((Date.now() - r.installedPluginsMtime) / 1000);
        agePart = `   ${relativeBand(diffSec)}`;
      }
      lines.push(`  ${marker} account ${accDisplay}  org ${orgDisplay}   ${tilded}${agePart}`);
    }
    // Skills counts from report.skillsPlugin?.pairs[]
    if (report.skillsPlugin && report.skillsPlugin.pairs.length > 0) {
      lines.push(`  Cowork built-in skills pairs (${report.skillsPlugin.pairs.length}):`);
      for (const pair of report.skillsPlugin.pairs) {
        const orgDisplay = opts.verbose ? pair.orgId : shortId(pair.orgId);
        const accDisplay = opts.verbose ? pair.accountId : shortId(pair.accountId);
        lines.push(`    org ${orgDisplay}/account ${accDisplay}    (${pair.skills.length} skills)`);
      }
    }
    lines.push("");
  }

  // 7.1: Synthesize "Recommended actions" from plugins[].primaryRecommendation.
  // Option (b) per plan: use the v0.5 per-plugin recommendation, not the full
  // v1.0 scan pipeline. Some fidelity loss vs cpd scan (no cross-plugin
  // aggregation), but good enough for 90% of cases. Dedup identical cmds.
  type V05Rec = { cmd: string; pluginId: string; isBumpNeeded: boolean };
  const v05Recs: V05Rec[] = [];
  const seenCmds = new Set<string>();
  for (const p of report.plugins) {
    const cmd = p.primaryRecommendation?.cmd;
    if (cmd && !seenCmds.has(cmd)) {
      seenCmds.add(cmd);
      // Detect bump-needed by the cmd template — every bump-needed cmd
      // starts with the literal "(cd <plugin-source>" prelude. This lets
      // renderHumanList aggregate the same way renderHuman does for scan,
      // collapsing 5 near-identical 8-line shell scripts into one entry.
      const isBumpNeeded = cmd.startsWith("(cd <plugin-source>");
      v05Recs.push({ cmd, pluginId: p.id, isBumpNeeded });
    }
  }
  for (const r of report.rpmPlugins) {
    const action = r.layer5.recommendation?.action;
    if (action && !seenCmds.has(action)) {
      seenCmds.add(action);
      v05Recs.push({ cmd: action, pluginId: r.pluginId, isBumpNeeded: false });
    }
  }
  // Aggregate bump-needed entries. Unlike renderHuman (scan), where the
  // planner groups bump-needed actions consecutively, the v0.5 list path
  // iterates plugins in installed-plugins.json order, interleaving bumps
  // with other recommendations. Collect all bumps into one group regardless
  // of position; emit non-bump entries in their original order, then the
  // single aggregated bump entry at the end (≥2 → aggregate; 0/1 → inline).
  type ListUnit = { kind: "single"; rec: V05Rec } | { kind: "bumpAgg"; recs: V05Rec[] };
  const bumpEntries: V05Rec[] = [];
  const nonBumpEntries: V05Rec[] = [];
  for (const r of v05Recs) {
    if (r.isBumpNeeded) bumpEntries.push(r);
    else nonBumpEntries.push(r);
  }
  const renderUnits: ListUnit[] = nonBumpEntries.map((rec) => ({
    kind: "single" as const,
    rec,
  }));
  if (bumpEntries.length >= 2) {
    renderUnits.push({ kind: "bumpAgg", recs: bumpEntries });
  } else if (bumpEntries.length === 1 && bumpEntries[0]) {
    renderUnits.push({ kind: "single", rec: bumpEntries[0] });
  }

  if (renderUnits.length > 0) {
    lines.push(s.bold("Recommended actions, in order:"));
    let displayOrdinal = 1;
    for (const unit of renderUnits) {
      const header = `  ${s.dim(`${displayOrdinal}.`)}`;
      const indent = "     ";
      if (unit.kind === "bumpAgg") {
        const plugins = unit.recs.map((r) => r.pluginId);
        const n = unit.recs.length;
        lines.push(
          `${header} ${s.dim(`(manual, ${n} plugins)`)}  Bump plugin.json#version in each plugin's source repo, commit, push, then refresh + update.`,
        );
        lines.push(`${indent}${s.dim("Affects:")} ${plugins.join(", ")}`);
        lines.push(`${indent}${s.dim("For per-plugin step-by-step:")}`);
        lines.push(`${indent}  ${s.cmd("cpd check <plugin>@<marketplace>")}`);
      } else {
        lines.push(formatRecCmd(unit.rec.cmd, { color: c, header, indent }));
      }
      displayOrdinal++;
    }
    lines.push("");
    lines.push(s.dim("For per-plugin details:  cpd check <plugin>@<marketplace>"));
    lines.push("");
  }

  if (report.logFile) lines.push(`Log file        ${s.dim(tildify(report.logFile))}`);
  if (opts.verbose) {
    lines.push(`Run ID          ${s.dim(report.runId)}`);
  }
  lines.push("");

  const hint = maybeExplainHint(lines.join("\n"), c);
  if (hint) {
    lines.push(hint);
    lines.push("");
  }

  const exitSuffix =
    report.exitCode === 0
      ? "  (everything fresh)"
      : "  (drift detected — run `cpd check <plugin>@<marketplace>` for per-plugin diagnosis)";
  lines.push(s.exit(report.exitCode, `Exit code: ${report.exitCode}${exitSuffix}`));

  return `${lines.join("\n")}\n`;
}

export const _internals = { worstStatus, formatLayerSummary };
