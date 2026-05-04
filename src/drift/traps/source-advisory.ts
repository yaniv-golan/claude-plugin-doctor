/**
 * Source advisory detectors — tier E, phase 5.
 *
 * Detects unsupported-source and npm-source-not-supported advisories.
 * These are informational — they tell the user why cpd cannot check a plugin
 * rather than flagging a specific drift condition.
 *
 * Source of truth: SPEC-v1.0.md §7.3.
 */

import type { KnownTrap, PluginEntrySourceKind, PluginRef } from "../../types.js";

type SourceAdvisoryTrap = Extract<
  KnownTrap,
  { kind: "unsupported-source" | "npm-source-not-supported" }
>;

/**
 * Returns source advisory traps for a plugin based on its entry source kind.
 *
 * Only the "genuine" advisory cases fire — the failure modes that conflate
 * three different conditions in earlier versions are now distinct values
 * with appropriate (mostly silent) handling:
 *
 *   - "unrecognized-source-kind" → `unsupported-source`
 *       (real "Upgrade Claude Code" condition: the source's discriminator
 *        is one neither Claude Code nor cpd recognizes)
 *   - "npm"                      → `npm-source-not-supported`
 *       (cpd doesn't yet probe npm registry)
 *   - "not-probed-by-cpd"        → silent
 *       (cpd's own limitation; the plugin works fine in Claude Code)
 *   - "clone-unreadable"         → silent
 *       (the layer-1 marketplace_clone failure is the canonical signal;
 *        per-plugin advisories would double-count the same root cause)
 *   - everything else            → silent
 */
export function detectSourceAdvisory(args: {
  pluginRef: PluginRef;
  pluginEntrySourceKind: PluginEntrySourceKind;
}): SourceAdvisoryTrap[] {
  const { pluginRef, pluginEntrySourceKind } = args;

  switch (pluginEntrySourceKind) {
    case "unrecognized-source-kind":
      return [{ kind: "unsupported-source", subject: { kind: "plugin", ref: pluginRef } }];
    case "npm":
      return [{ kind: "npm-source-not-supported", subject: { kind: "plugin", ref: pluginRef } }];
    // Exhaustive over the union — all other values produce no advisory.
    case "string":
    case "github":
    case "git-subdir":
    case "url":
    case "not-probed-by-cpd":
    case "clone-unreadable":
      return [];
  }
}
