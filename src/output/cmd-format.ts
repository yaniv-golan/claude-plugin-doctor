import { createColors } from "picocolors";

// Force-on picocolors instance — caller's `color` flag is the single source of
// truth, regardless of TTY detection at module load.
const pcOn = createColors(true);

/**
 * POSIX single-quote shell escape (audit issue #11). Wraps the input in
 * single quotes and escapes any embedded `'` as `'\''`. The result is safe
 * to paste into any POSIX shell (bash/zsh/sh), including names that contain
 * `;`, `$`, backticks, spaces, or other metacharacters.
 *
 * Used for interpolating attacker-influenced strings (marketplace names,
 * plugin ids, clone paths) into copyable `recommendation.cmd` strings. cpd
 * never `exec`s these directly — `runClaudeCli` and the git runners use
 * `spawn` with array args — so the threat model is "user copy-pastes a cmd
 * containing a hostile name." Quoting eliminates that vector.
 *
 * Names already known to be safe (e.g. ASCII identifier chars only) round-
 * trip through the quoter unchanged in spirit; the cost is two extra
 * characters in the displayed string.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Style a recommendation command body — cyan+bold for the literal parts,
 *  italic+yellow for `<placeholder>` segments so users can see what they must
 *  replace before pasting. Off-mode returns the original text unchanged. */
export function styleCmdBody(text: string, color: boolean): string {
  if (!color) return text;
  // Split on <...> placeholders, style alternately. Non-greedy, no nesting
  // (cmd strings don't contain literal angle brackets except as placeholders).
  const parts = text.split(/(<[^<>]+>)/g);
  return parts
    .map((p) => {
      if (p.startsWith("<") && p.endsWith(">")) {
        // Placeholder — italic+yellow signals "must edit before pasting".
        return pcOn.italic(pcOn.yellow(p));
      }
      return pcOn.cyan(pcOn.bold(p));
    })
    .join("");
}

/** Drop commands whose top-level `&&` segments are a contiguous run of
 *  another command's segments. Stable order — survivors keep first-occurrence
 *  ordering. The dominant case: cpd's `cpd check` collects per-layer
 *  recommendations; layer 1 emits `claude plugin marketplace update <mp>`
 *  and layer 2's version-trap chain *contains* that as a segment. Showing
 *  both makes step #1 wasted work because step #2 subsumes it.
 *
 *  Notes:
 *  - Comparison is on segment strings post-`splitTopLevelAndAnd`. For prose
 *    "actions" (e.g. "Reinstall via the Plugins UI") with no `&&`, the
 *    splitter returns `[whole]`, so dedup degrades to exact-equality — fine.
 *  - This runs *after* the existing `.includes()` exact-dedup at the
 *    callers; the layered effect is harmless. */
export function dedupSubchains(cmds: string[]): string[] {
  const segLists = cmds.map((c) => splitTopLevelAndAnd(c));
  const drop = new Set<number>();
  for (let i = 0; i < cmds.length; i++) {
    if (drop.has(i)) continue;
    for (let j = 0; j < cmds.length; j++) {
      if (i === j || drop.has(j)) continue;
      // Drop cmds[j] if its segments are a contiguous run of cmds[i]'s.
      const a = segLists[i];
      const b = segLists[j];
      // b is a candidate to drop when its segments are CONTAINED in a's.
      // Strict-shorter (b.length < a.length) covers the dominant sub-chain
      // case; equal-length is handled by the i<j tiebreaker below to drop
      // the later identical duplicate.
      if (!a || !b || b.length === 0) continue;
      if (b.length > a.length) continue;
      if (b.length === a.length && j < i) continue;
      // Search for b as a contiguous sub-array of a.
      outer: for (let s = 0; s + b.length <= a.length; s++) {
        for (let k = 0; k < b.length; k++) {
          if (a[s + k] !== b[k]) continue outer;
        }
        drop.add(j);
        break;
      }
    }
  }
  return cmds.filter((_, i) => !drop.has(i));
}

/** Split a shell command on TOP-LEVEL `&&` boundaries — paren-depth aware AND
 *  quote-aware. Returns segments with no leading/trailing whitespace.
 *
 *  Quote-tracking: enters a "quoted" state at `'` or `"` and ignores `&&`
 *  until the matching closing quote. Does NOT handle backslash-escapes
 *  inside double-quotes (e.g. `"a\"b && c"`) — cmd inputs are author-
 *  controlled and don't currently use escape sequences; if they ever do,
 *  this function needs upgrading. */
export function splitTopLevelAndAnd(cmd: string): string[] {
  const segs: string[] = [];
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let buf = "";
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) quote = null;
      buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    // Top-level `&&` boundary — accept either ` && ` or `)&&` etc.; the
    // prior leading-space requirement was a false guard that broke regen-
    // erated cmds without it.
    if (depth === 0 && ch === "&" && cmd[i + 1] === "&") {
      segs.push(buf.trimEnd());
      buf = "";
      i++; // skip second &
      // skip following space (if any)
      if (cmd[i + 1] === " ") i++;
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) segs.push(buf.trim());
  return segs;
}

/** Format a recommendation command for human output.
 *
 *  - Single-line cmd: `${header} ${cmd}` (sigil inline).
 *  - Multi-line cmd (long &&-chain): sigil on its own line, then the cmd
 *    block uniformly indented underneath, with ` \\` continuations on every
 *    non-final line. This lets the user drag-select the cmd block WITHOUT
 *    capturing the leading `→` / `1.` sigil — paste-clean.
 *
 *  Example multi-line output (color: false, header `     →`, indent `       `):
 *
 *           →
 *             (cd <plugin-source> && <bump plugin.json#version> && ...) \
 *               && claude plugin marketplace update lool-founder-skills \
 *               && claude plugin update founder-skills@lool-founder-skills
 */
/** Width threshold above which a paren-group segment gets sub-split into a
 *  multi-line `(\n  ...\n)` block. Picked so a 7-space-indented line fits in
 *  a 100-col terminal with room for the trailing ` \\`. */
const SUBSHELL_SUBSPLIT_THRESHOLD = 80;

/** Render a single segment. If the segment is a paren-wrapped subshell whose
 *  content would still be too long for one line, recursively split its
 *  internal `&&`s into a multi-line `(\n  cmd1 \\n  && cmd2 \\n)` block. */
function renderSegment(seg: string, opts: { color: boolean; baseIndent: string }): string {
  // Detect paren-wrapped subshell: starts with `(`, ends with `)`, and the
  // matching close is the last char (not nested followed by trailing ops).
  const isSubshell = seg.startsWith("(") && seg.endsWith(")") && matchedAtEnd(seg);
  if (!isSubshell || seg.length <= SUBSHELL_SUBSPLIT_THRESHOLD) {
    return styleCmdBody(seg, opts.color);
  }
  const inner = seg.slice(1, -1).trim();
  const innerSegs = splitTopLevelAndAnd(inner);
  if (innerSegs.length <= 1) {
    // No internal && to split on — render as-is even if long.
    return styleCmdBody(seg, opts.color);
  }
  // Build:    (
  //   <indent+2>cmd1 \
  //   <indent+4>&& cmd2 \
  //   <indent+4>&& cmd3
  // <indent>)
  const innerIndent = `${opts.baseIndent}  `;
  const innerCont = `${opts.baseIndent}    `;
  const lines: string[] = ["("];
  for (let i = 0; i < innerSegs.length; i++) {
    const s = innerSegs[i] ?? "";
    const piece = i === 0 ? s : `&& ${s}`;
    const styled = styleCmdBody(piece, opts.color);
    const isLast = i === innerSegs.length - 1;
    const prefix = i === 0 ? innerIndent : innerCont;
    const cont = isLast ? "" : " \\";
    lines.push(`${prefix}${styled}${cont}`);
  }
  lines.push(`${opts.baseIndent})`);
  return lines.join("\n");
}

/** True when the closing `)` at the end of `s` matches the opening `(`
 *  at the start (i.e., the whole string is one paren group, not e.g.
 *  `(a) && (b)`). */
function matchedAtEnd(s: string): boolean {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0 && i !== s.length - 1) return false;
    }
  }
  return depth === 0;
}

export function formatRecCmd(
  cmd: string,
  opts: { color: boolean; header: string; indent: string },
): string {
  const segs = splitTopLevelAndAnd(cmd);
  if (segs.length <= 1 || cmd.length <= 80) {
    // Single-line: keep sigil inline.
    return `${opts.header} ${styleCmdBody(cmd, opts.color)}`;
  }
  // Multi-line: sigil on its own line, cmd block underneath.
  // Continuation segments get an extra 2-space indent so `&& ...` lines
  // visually nest under the first segment.
  const innerIndent = `${opts.indent}  `;
  const lines: string[] = [opts.header];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i] ?? "";
    const isLast = i === segs.length - 1;
    const baseIndent = i === 0 ? opts.indent : innerIndent;
    const styled = renderSegment(seg, { color: opts.color, baseIndent });
    const prefixed = i === 0 ? styled : `&& ${styled}`;
    const cont = isLast ? "" : " \\";
    lines.push(`${baseIndent}${prefixed}${cont}`);
  }
  return lines.join("\n");
}

// ── A1: Manual-step recommendation detection and rendering ───────────────────

/** Source-context information used by formatManualSteps to generate accurate
 *  step-1 prose. The renderer extracts this from V05CheckReport fields. */
export type ManualStepSourceContext = {
  pluginName: string;
  marketplaceName: string;
  /** e.g. "github" | "git" | "directory" | "remote" | "unknown" */
  sourceType: string;
  /** For github: `owner/repo` slug. For git: URL. For directory: path. */
  sourceDetail: string;
  /** The pluginEntrySourceKind from layer-2 evidence. Possible values:
   *  "string" | "github" | "git-subdir" | "url" | "npm" |
   *  "not-probed-by-cpd" | "unrecognized-source-kind" | "clone-unreadable". */
  pluginEntrySourceKind: string;
};

/** Manual drift kinds — those whose fix requires human action and cannot be
 *  copy-pasted as a single command. The list matches VersionTrapKind exactly:
 *  src/caches/install-snapshot.ts lines 85-91. */
const MANUAL_DRIFT_KINDS = new Set([
  "bump-needed",
  "badge-only-needed",
  "unsupported-source",
  "npm-source-not-supported",
  "marketplace-clone-not-a-repo",
  "marketplace-clone-corrupt",
]);

/** Detect whether a Recommendation is manual (requires numbered prose steps).
 *  Returns true when:
 *  1. rec.cmd is undefined (no runnable command at all), OR
 *  2. evidence.versionTrapKind is one of the known manual drift kinds, OR
 *  3. rec.cmd contains `<plugin-source>` or `<bump plugin.json#version>` placeholders
 *     (defense-in-depth; should be unreachable given #2). */
export function isManualRec(
  rec: { cmd?: string; action: string },
  evidence: Record<string, unknown>,
): boolean {
  if (rec.cmd === undefined) return true;
  const trapKind = evidence.versionTrapKind;
  if (typeof trapKind === "string" && MANUAL_DRIFT_KINDS.has(trapKind)) return true;
  if (rec.cmd.includes("<plugin-source>") || rec.cmd.includes("<bump plugin.json#version>"))
    return true;
  return false;
}

/** Format a manual-step recommendation as a numbered prose block.
 *
 *  Returns `null` when the drift kind doesn't have a registered template
 *  (caller should fall back to plain cmd rendering).
 *
 *  Lines returned are already newline-joined, ready to push into the output
 *  lines array. Each runnable step uses cyan-bold styling when color is enabled. */
export function formatManualSteps(
  rec: { cmd?: string; action: string },
  evidence: Record<string, unknown>,
  ctx: ManualStepSourceContext,
  color: boolean,
): string | null {
  const trapKind = typeof evidence.versionTrapKind === "string" ? evidence.versionTrapKind : null;

  const styledCmd = (cmd: string): string => styleCmdBody(cmd, color);

  // Helper: render a numbered step. Prose lines are plain; cmd lines are cyan-bold.
  const step = (n: number, text: string, isCmd = false): string => {
    const prefix = `  ${n}.`;
    if (isCmd) {
      return `${prefix} ${styledCmd(text)}`;
    }
    return `${prefix} ${text}`;
  };

  // Build step-1 prose based on source-kind table from plan §A1.
  function buildStep1(label: string): string {
    const { pluginName, sourceType, sourceDetail, pluginEntrySourceKind } = ctx;
    // The "string-source-style" branch is for plugins whose source lives at a
    // local path (string-form `source`, npm package paths, or any of the
    // failure modes where we don't know the actual object-source URL). The
    // "object-source" branch handles github / git-subdir / url, where the
    // URL is structured in marketplace.json.
    if (
      pluginEntrySourceKind === "string" ||
      pluginEntrySourceKind === "npm" ||
      pluginEntrySourceKind === "not-probed-by-cpd" ||
      pluginEntrySourceKind === "unrecognized-source-kind" ||
      pluginEntrySourceKind === "clone-unreadable"
    ) {
      // String source (path in marketplace repo) — use source-type-based prose.
      if (sourceType === "github") {
        return `In your \`github.com/${sourceDetail}\` clone, find the \`${pluginName}\` plugin's \`.claude-plugin/${label}\` and bump the \`version\` field.`;
      }
      if (sourceType === "git") {
        return `In your local clone of \`${sourceDetail}\`, find the \`${pluginName}\` plugin's \`.claude-plugin/${label}\` and bump the \`version\` field.`;
      }
      if (sourceType === "directory") {
        return `In \`${sourceDetail}\`, find the \`${pluginName}\` plugin's \`.claude-plugin/${label}\` and bump the \`version\` field.`;
      }
    }
    // Object-source (github/git-subdir/url) — repo URL is not directly available.
    return `In your local checkout of the \`${pluginName}\` plugin's source repo, bump the \`version\` field in \`.claude-plugin/${label}\`. (The repo URL is in \`${ctx.marketplaceName}\`'s marketplace.json under \`plugins[${pluginName}].source\`.)`;
  }

  // Per-drift-kind step decomposition (plan §A1 step-decomposition table).
  //
  // bump-needed assumes the user can edit the plugin's source repo. That's
  // only true if they're the maintainer. The non-maintainer ("consumer") case
  // gets a separate footer because their action is fundamentally different —
  // there's no local fix, only a request to the maintainer (or accepting that
  // the new commits may be docs-only and ignoring).
  const consumerFooter = (): string =>
    [
      "",
      "  If you're a consumer of this plugin (not the maintainer):",
      `    There's no local fix. Either inspect the new commits in the marketplace clone (the "new commits" list above) — if they're docs/CI-only, your install is functionally up-to-date and you can ignore this. Otherwise open an issue against \`${ctx.pluginName}\` asking the maintainer to bump \`plugin.json#version\` and republish.`,
    ].join("\n");

  if (trapKind === "bump-needed") {
    const prose1 = buildStep1("plugin.json");
    const isObjectSource =
      ctx.pluginEntrySourceKind === "github" ||
      ctx.pluginEntrySourceKind === "git-subdir" ||
      ctx.pluginEntrySourceKind === "url";
    if (isObjectSource) {
      // Object-source dual-bump rule (gist §"Update detection" refinement):
      // bumping plugin.json#version alone makes the CLI detect the update but leaves
      // the Desktop "Update available" badge silent. The user must also bump
      // marketplace.json#plugins[<pluginName>].version in the marketplace catalog repo.
      const prose2 = `(object-source plugins only) In your local checkout of the marketplace catalog repo (\`${ctx.marketplaceName}\`'s \`${ctx.sourceDetail || "marketplace repo"}\`), update \`.claude-plugin/marketplace.json\`'s \`plugins[${ctx.pluginName}].version\` to match the new version, and push. This is what makes Desktop's "Update available" badge surface for object-source plugins.`;
      const lines = [
        "Fix (manual, 5 steps — if you're the plugin maintainer):",
        step(1, prose1),
        step(2, prose2),
        step(3, "git commit -am 'sync versions' && git push", true),
        step(4, `claude plugin marketplace update ${shellQuote(ctx.marketplaceName)}`, true),
        step(
          5,
          `claude plugin update ${shellQuote(`${ctx.pluginName}@${ctx.marketplaceName}`)}`,
          true,
        ),
        consumerFooter(),
      ];
      return lines.join("\n");
    }
    const lines = [
      "Fix (manual, 4 steps — if you're the plugin maintainer):",
      step(1, prose1),
      step(2, "git commit -am 'bump version' && git push", true),
      step(3, `claude plugin marketplace update ${shellQuote(ctx.marketplaceName)}`, true),
      step(
        4,
        `claude plugin update ${shellQuote(`${ctx.pluginName}@${ctx.marketplaceName}`)}`,
        true,
      ),
      consumerFooter(),
    ];
    return lines.join("\n");
  }

  if (trapKind === "badge-only-needed") {
    const prose1 = `In your local checkout of \`${ctx.sourceDetail}\` (the marketplace repo), edit \`.claude-plugin/marketplace.json\` and update \`plugins[${ctx.pluginName}].version\` to match \`plugin.json#version\`.`;
    const lines = [
      "Fix (manual, 3 steps):",
      step(1, prose1),
      step(2, "git commit -am 'sync catalog version' && git push", true),
      step(3, `claude plugin marketplace update ${shellQuote(ctx.marketplaceName)}`, true),
    ];
    return lines.join("\n");
  }

  if (trapKind === "unsupported-source") {
    return [
      "Fix (manual):",
      "  Upgrade Claude Code to a version that supports this plugin's source kind.",
    ].join("\n");
  }

  if (trapKind === "npm-source-not-supported") {
    return [
      "Fix (manual):",
      "  Plugin uses an `npm:` source kind that this version of cpd doesn't probe. Manual-only — verify in the Settings UI.",
    ].join("\n");
  }

  if (trapKind === "marketplace-clone-not-a-repo") {
    // .git/ is missing entirely. The directory is unrecoverable in place;
    // the only path forward is to remove the marketplace and re-add it.
    // That's destructive — `claude plugin marketplace remove` unregisters
    // every plugin installed from this marketplace. Lead with the warning.
    const addArg = typeof evidence.addArg === "string" ? evidence.addArg : "<source-url>";
    return [
      "Fix (manual, destructive — removes ALL plugins installed from this marketplace):",
      `  ${ctx.marketplaceName}'s clone directory exists but is not a git repo`,
      "  (.git/ missing). The most likely causes are an interrupted",
      "  `claude plugin marketplace add` or a manual edit. There's no",
      "  in-place recovery; the only option is to reinstall.",
      "",
      step(1, `claude plugin marketplace remove ${ctx.marketplaceName}`, true),
      step(2, `claude plugin marketplace add ${addArg}`, true),
      step(3, "Re-install any plugins you had from this marketplace.", false),
    ].join("\n");
  }

  if (trapKind === "marketplace-clone-corrupt") {
    // .git/ is present but `git rev-parse HEAD` failed — index corruption,
    // broken pack files, or a detached HEAD pointing to a missing object.
    // Try non-destructive recovery first (`fsck`/`repack`); only fall back
    // to destructive remove+re-add if those don't help.
    const addArg = typeof evidence.addArg === "string" ? evidence.addArg : "<source-url>";
    const cloneDirRaw = typeof evidence.cloneDir === "string" ? evidence.cloneDir : "<clone-dir>";
    return [
      "Fix (manual, 2 steps — diagnostic first, destructive only if needed):",
      `  ${ctx.marketplaceName}'s .git/ exists but \`git rev-parse HEAD\` fails.`,
      "  This is repository corruption. Try non-destructive recovery first.",
      "",
      step(1, `git -C ${cloneDirRaw} fsck --full`, true),
      "     If fsck reports recoverable issues, repack and re-check:",
      `       ${styledCmd(`git -C ${cloneDirRaw} repack -a -d && git -C ${cloneDirRaw} fsck --full`)}`,
      "",
      "  2. Only if step 1 still shows unrecoverable damage, reinstall.",
      "     ⚠ DESTRUCTIVE — removes ALL plugins installed from this marketplace.",
      `       ${styledCmd(`claude plugin marketplace remove ${ctx.marketplaceName}`)}`,
      `       ${styledCmd(`claude plugin marketplace add ${addArg}`)}`,
    ].join("\n");
  }

  // rec.cmd is undefined but not a known trap kind — generic prose.
  if (rec.cmd === undefined && rec.action) {
    return ["Fix (manual):", `  ${rec.action}`].join("\n");
  }

  return null; // not a manual rec — caller should use cmd rendering
}
