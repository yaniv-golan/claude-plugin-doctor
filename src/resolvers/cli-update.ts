/**
 * CLI update simulator — tier D, phase 4.
 *
 * Answers: "If I run `claude plugin update <plugin>@<mp>`, what version will I get?"
 *
 * Pure function over typed inputs. No fs, no fetch, no child_process.
 * The drift composer (tier E) constructs CliUpdateInput from tier A/B/C state
 * and calls this. Tests use synthetic inputs only — no fixtures required.
 *
 * Priority chain for resolved version (per SPEC-v1.0.md §6.1 + v0.5 SPEC.md §4):
 *
 *   String-source plugins (co-located in clone):
 *     1. plugin.json-in-clone#version  — most specific local source
 *     2. marketplace.json#version       — catalog fallback
 *     3. unknown                        — no version resolvable
 *
 *   Object-source plugins (github / git-subdir / url):
 *     0. If upstream not fresh: indeterminate-no-network
 *        Even when local data (marketplace.json) could give a partial answer,
 *        we mark indeterminate so tier E suppresses resolver-disagreement.
 *        Rationale: the CLI's update op WILL fetch fresh from remote; returning
 *        a local-only version would make the sim disagree with the CLI's actual
 *        behavior every time the remote has moved. Indeterminate is the honest
 *        answer until a probe succeeds.
 *     1. remote-plugin.json#version     — CLI fetches this during update
 *     2. marketplace.json#version       — fallback if no remote plugin.json
 *     3. unknown                        — no version resolvable
 *
 *   npm / unsupported: always unknowable.
 */

import type { CliUpdateInput, CliUpdateSim } from "../types.js";

/** Object-source plugin entry kinds — github, git-subdir, url. */
const OBJECT_SOURCE_KINDS = new Set(["github", "git-subdir", "url"] as const);

export function simulateCliUpdate(args: CliUpdateInput): CliUpdateSim {
  const {
    pluginEntrySourceKind,
    marketplaceClone,
    pluginEntry,
    pluginJsonInClone,
    upstreamStatus,
  } = args;

  // Build evidence block from inputs (populated regardless of resolution path).
  // exactOptionalPropertyTypes is enabled — use conditional spread to avoid
  // assigning `undefined` to optional properties that expect `string`.
  const evidence: CliUpdateSim["evidence"] = {
    pluginEntrySourceKind,
    ...(marketplaceClone?.cloneRoot !== undefined && { cloneRoot: marketplaceClone.cloneRoot }),
    ...(pluginJsonInClone?.version !== undefined && {
      pluginJsonInClone: pluginJsonInClone.version,
    }),
    ...(pluginEntry.versionInMarketplaceJson !== undefined && {
      marketplaceJsonVersion: pluginEntry.versionInMarketplaceJson,
    }),
    ...(args.remotePluginJsonVersion !== undefined && {
      remotePluginJsonVersion: args.remotePluginJsonVersion,
    }),
  };

  // ── Source kinds the resolver can't process ─────────────────────────────
  // Three distinct failure modes that all short-circuit to unknowable, but
  // with different `reason` strings so verbose output explains which case
  // it is. The differing reasons drive the source-advisory detector and the
  // user-facing message in cmd-format.
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
    // The CLI's update op always fetches fresh from remote. When the upstream
    // probe did not succeed, we cannot predict what the CLI would install — even
    // local data (marketplace.json) may be stale relative to what the remote
    // would return. Return indeterminate so tier E suppresses disagreement.
    if (upstreamStatus !== "fresh") {
      return {
        resolvedFrom: "indeterminate-no-network",
        unknowable: { reason: "upstream-unreachable" },
        evidence,
      };
    }

    if (args.remotePluginJsonVersion !== undefined) {
      return {
        resolvedVersion: args.remotePluginJsonVersion,
        resolvedFrom: "remote-plugin.json",
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

  // Exhaustive fallback — should not be reachable with well-typed inputs.
  return { resolvedFrom: "unknown", evidence };
}
