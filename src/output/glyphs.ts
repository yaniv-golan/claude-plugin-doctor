// Single source of truth for status glyphs and their plain-text equivalents.
//
// Conventions pack baseline (locked in v0.1.0): every renderer imports glyphs
// from here. Scattered string literals across human.ts, cmd-format.ts, and
// status-translate.ts have been consolidated so that a future glyph change
// (e.g. moving from `✓`/`✗` to `✔`/`✘` for parity with the official Claude CLI)
// is a single-file edit rather than a treasure hunt.
//
// Pre-1.0 we lock the symbol vocabulary; promoting/changing a glyph after
// 0.1.0 ships is a UX-visible change subject to changelog discipline.

import { createColors } from "picocolors";

const pcOn = createColors(true);

/** Color/icon pair used by colored renderers. */
export type Glyph = readonly [icon: string, paint: (s: string) => string];

// Canonical set. Names are status-agnostic ("ok", "fail", "warn") so the
// same glyph can serve check status, scan summary, and recommendation
// header lines without forcing every caller through the CheckStatus type.
export const GLYPH = {
  ok: ["✓", pcOn.green] as Glyph,
  fail: ["✗", pcOn.red] as Glyph,
  warn: ["⚠", pcOn.yellow] as Glyph,
  /** Used for skipped / non-actionable rows. */
  skip: ["–", pcOn.dim] as Glyph,
  /** Used for unknowable status (intentionally undecidable). */
  unknown: ["?", pcOn.dim] as Glyph,
  /** Bullet for nested item lines (matches official Claude CLI's `❯`). */
  bullet: ["❯", pcOn.dim] as Glyph,
} as const;

export type GlyphName = keyof typeof GLYPH;

/** Plain-text fallback when ANSI is disabled. Matches the long-standing
 *  `[OK]`/`[FAIL]`/`[WARN]` convention used in --no-color output. */
export const GLYPH_PLAIN: Record<GlyphName, string> = {
  ok: "[OK]",
  fail: "[FAIL]",
  warn: "[WARN]",
  skip: "[-]",
  unknown: "[?]",
  bullet: ">",
};

/** Renders a glyph honoring the color flag. Equivalent to the inline
 *  `c ? pcOn.green("✓") : "[OK]"` pattern that previously appeared scattered
 *  across human.ts. */
export function glyph(name: GlyphName, color: boolean): string {
  if (color) {
    const [icon, paint] = GLYPH[name];
    return paint(icon);
  }
  return GLYPH_PLAIN[name];
}
