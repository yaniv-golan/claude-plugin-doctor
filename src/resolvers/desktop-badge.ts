/**
 * Desktop badge simulator — tier D, phase 4.
 *
 * Answers: "What does the Desktop 'Update available' badge display?"
 *
 * Pure function over typed inputs. No fs, no fetch, no child_process.
 *
 * Key asymmetry vs. CLI update sim (per SPEC-v1.0.md §6.1 + gist §6):
 *   - The badge NEVER remote-fetches. It reads only the marketplace clone.
 *   - For object-source plugins, the badge cannot see a plugin.json in the
 *     clone (those plugins live outside the clone). It falls back to
 *     marketplace.json#plugins[].version only.
 *   - For string-source plugins, both badge and CLI read the same
 *     plugin.json inside the clone — they cannot disagree on this path.
 *
 * Priority chain:
 *
 *   String-source:
 *     1. plugin.json-in-clone#version
 *     2. marketplace.json#version
 *     3. unknown
 *
 *   Object-source (github / git-subdir / url):
 *     1. marketplace.json#version  — only local source available to badge
 *     2. unknown
 *
 *   npm / unsupported: always unknowable.
 *
 * The `evidence.remotePluginJsonVersion` field is always `undefined` —
 * the badge input type does not carry it, and the output shape documents
 * this explicitly so callers don't mistake absence for a bug.
 */

import type { DesktopBadgeInput, DesktopBadgeSim } from "../types.js";

/** Object-source plugin entry kinds — github, git-subdir, url. */
const OBJECT_SOURCE_KINDS = new Set(["github", "git-subdir", "url"] as const);

export function simulateDesktopBadge(args: DesktopBadgeInput): DesktopBadgeSim {
  const { pluginEntrySourceKind, marketplaceClone, pluginEntry, pluginJsonInClone } = args;

  // Build evidence block. remotePluginJsonVersion is always undefined for the badge
  // (not present on the input type at all — the type-level constraint is the contract).
  // exactOptionalPropertyTypes is enabled — use conditional spread to avoid
  // assigning `undefined` to optional properties that expect `string`.
  const evidence: DesktopBadgeSim["evidence"] = {
    pluginEntrySourceKind,
    ...(marketplaceClone?.cloneRoot !== undefined && { cloneRoot: marketplaceClone.cloneRoot }),
    ...(pluginJsonInClone?.version !== undefined && {
      pluginJsonInClone: pluginJsonInClone.version,
    }),
    ...(pluginEntry.versionInMarketplaceJson !== undefined && {
      marketplaceJsonVersion: pluginEntry.versionInMarketplaceJson,
    }),
    // remotePluginJsonVersion intentionally omitted — badge never remote-fetches.
  };

  // ── Source kinds the resolver can't process ─────────────────────────────
  // Same three-way split as cli-update.ts: distinct `reason` strings so
  // downstream consumers (verbose output, source-advisory) can distinguish
  // genuine "Upgrade Claude Code" from cpd-internal limitations from
  // marketplace-clone-unreadable.
  if (pluginEntrySourceKind === "unrecognized-source-kind") {
    return {
      resolvedFrom: "unknown",
      unknowable: { reason: "unsupported-source" },
      evidence,
    };
  }
  if (pluginEntrySourceKind === "not-probed-by-cpd") {
    return {
      resolvedFrom: "unknown",
      unknowable: { reason: "source-not-probed-by-cpd" },
      evidence,
    };
  }
  if (pluginEntrySourceKind === "clone-unreadable") {
    return {
      resolvedFrom: "unknown",
      unknowable: { reason: "marketplace-clone-unreadable" },
      evidence,
    };
  }

  if (pluginEntrySourceKind === "npm") {
    return {
      resolvedFrom: "unknown",
      unknowable: { reason: "npm-not-supported" },
      evidence,
    };
  }

  // ── String-source plugins ────────────────────────────────────────────────
  if (pluginEntrySourceKind === "string") {
    if (pluginJsonInClone?.version !== undefined) {
      return {
        resolvedVersion: pluginJsonInClone.version,
        resolvedFrom: "plugin.json-in-clone",
        evidence,
      };
    }
    if (pluginEntry.versionInMarketplaceJson !== undefined) {
      return {
        resolvedVersion: pluginEntry.versionInMarketplaceJson,
        resolvedFrom: "marketplace.json",
        evidence,
      };
    }
    return { resolvedFrom: "unknown", evidence };
  }

  // ── Object-source plugins (github / git-subdir / url) ───────────────────
  if (OBJECT_SOURCE_KINDS.has(pluginEntrySourceKind as "github" | "git-subdir" | "url")) {
    // Badge cannot see remote data or the plugin.json for object-source plugins.
    // Only marketplace.json#version is available here.
    if (pluginEntry.versionInMarketplaceJson !== undefined) {
      return {
        resolvedVersion: pluginEntry.versionInMarketplaceJson,
        resolvedFrom: "marketplace.json",
        evidence,
      };
    }
    return { resolvedFrom: "unknown", evidence };
  }

  // Exhaustive fallback — should not be reachable with well-typed inputs.
  return { resolvedFrom: "unknown", evidence };
}
