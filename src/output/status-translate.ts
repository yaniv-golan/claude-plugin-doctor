// CheckStatus display helpers — used by the per-command renderers in
// watch.ts, list.ts, check.ts, and refresh.ts. The scan command emits
// drifts directly and doesn't go through these.
//
// Symbols and color paints are sourced from `./glyphs.ts` so the canonical
// vocabulary lives in one place; ICON_COLOR / ICON_PLAIN below are derived
// projections used by callers that import them by name.
import type { CheckStatus } from "../types.js";
import { GLYPH, GLYPH_PLAIN, type GlyphName, glyph } from "./glyphs.js";

const STATUS_TO_GLYPH: Record<CheckStatus, GlyphName> = {
  fresh: "ok",
  stale: "warn",
  missing: "fail",
  // Skipped is non-actionable (n/a, stub, or not-run). Old `→` icon read as
  // "do this" — same shape as the recommendation arrow elsewhere. Use a dim
  // en-dash to signal "nothing to do here, move on".
  skipped: "skip",
  unknowable: "unknown",
};

export const ICON_COLOR: Record<CheckStatus, [string, (s: string) => string]> = {
  fresh: GLYPH.ok as [string, (s: string) => string],
  stale: GLYPH.warn as [string, (s: string) => string],
  missing: GLYPH.fail as [string, (s: string) => string],
  skipped: GLYPH.skip as [string, (s: string) => string],
  unknowable: GLYPH.unknown as [string, (s: string) => string],
};

export const ICON_PLAIN: Record<CheckStatus, string> = {
  fresh: GLYPH_PLAIN.ok,
  stale: GLYPH_PLAIN.warn,
  missing: GLYPH_PLAIN.fail,
  skipped: GLYPH_PLAIN.skip,
  unknowable: GLYPH_PLAIN.unknown,
};

export function statusToken(status: CheckStatus, color: boolean): string {
  return glyph(STATUS_TO_GLYPH[status], color);
}

/** JSON CheckStatus values are stable for scripting (`unknowable`, `skipped`,
 *  etc.). For HUMAN output we translate to plain English. `skipped` is
 *  ambiguous on its own — the discriminator is the layer's `evidence.kind`:
 *
 *    - "stub"          → "not-implemented" (Layer 4 remote / Layer 6 — v1.0 work)
 *    - "inapplicable"  → "n/a" (this layer doesn't apply in the current mode
 *                                or for this marketplace's source type)
 *    - "not-run"       → "not-run" (error path; checks didn't execute)
 *    - undefined       → falls back to `layerKey` heuristic, then "n/a"
 *
 *  The fallback path keeps existing test fixtures working when they pass
 *  `(status, layerKey)` without evidence. New code should always pass evidence.
 */
const STUB_LAYERS = new Set(["backend_marketplace", "ccd_remote_ssh"]);
export function humanStatus(
  status: CheckStatus,
  layerKey?: string,
  evidence?: Record<string, unknown>,
): string {
  if (status === "unknowable") return "unknown";
  if (status === "skipped") {
    const kind = evidence?.kind;
    if (kind === "stub") return "not-implemented";
    if (kind === "inapplicable") return "n/a";
    if (kind === "not-run") return "not-run";
    // Legacy fallback for callers that don't pass evidence.
    if (layerKey && STUB_LAYERS.has(layerKey)) return "not-implemented";
    return "n/a";
  }
  return status;
}
