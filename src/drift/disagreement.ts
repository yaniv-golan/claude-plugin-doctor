/**
 * Resolver disagreement detector — tier E, phase 5.
 *
 * Compares the outputs of the three resolver sims (CLI update, Desktop badge,
 * session start) and detects when they would return different versions to the
 * user — creating a confusing UX where the CLI, the badge, and the loaded
 * session disagree about "current version".
 *
 * Source of truth: SPEC-v1.0.md §7.1.
 */

import type {
  CliUpdateSim,
  DesktopBadgeSim,
  PluginRef,
  ResolverDisagreement,
  SessionStartSim,
} from "../types.js";

type PairResult = "agree" | "disagree" | "indeterminate";

function comparePair(
  aVersion: string | undefined,
  aUnknowable: boolean,
  bVersion: string | undefined,
  bUnknowable: boolean,
): PairResult {
  // If either sim has unknowable → indeterminate.
  if (aUnknowable || bUnknowable) return "indeterminate";
  // Both have resolvedVersion defined and equal → agree.
  if (aVersion !== undefined && bVersion !== undefined && aVersion === bVersion) return "agree";
  // Both have resolvedVersion defined and unequal → disagree.
  if (aVersion !== undefined && bVersion !== undefined && aVersion !== bVersion) return "disagree";
  // One defined, one undefined → indeterminate.
  return "indeterminate";
}

/**
 * Detects resolver disagreement among the three sims.
 *
 * Returns null when all three pairs agree. Returns a ResolverDisagreement
 * when any pair disagrees or is indeterminate (indeterminate implies the
 * user may be getting different versions — worth surfacing).
 *
 * Pairs:
 *   cliVsBadge   — CLI update vs Desktop badge
 *   cliVsSession — CLI update vs session start
 *   badgeVsSession — Desktop badge vs session start
 */
export function detectResolverDisagreement(args: {
  pluginRef: PluginRef;
  cli: CliUpdateSim;
  badge: DesktopBadgeSim;
  sessionStart: SessionStartSim;
}): ResolverDisagreement | null {
  const { pluginRef, cli, badge, sessionStart } = args;

  const cliUnknowable = cli.unknowable !== undefined;
  const badgeUnknowable = badge.unknowable !== undefined;
  const sessionUnknowable = sessionStart.unknowable !== undefined;

  const cliVsBadge = comparePair(
    cli.resolvedVersion,
    cliUnknowable,
    badge.resolvedVersion,
    badgeUnknowable,
  );
  const cliVsSession = comparePair(
    cli.resolvedVersion,
    cliUnknowable,
    sessionStart.resolvedVersion,
    sessionUnknowable,
  );
  const badgeVsSession = comparePair(
    badge.resolvedVersion,
    badgeUnknowable,
    sessionStart.resolvedVersion,
    sessionUnknowable,
  );

  // If all three pairs agree, no disagreement to report.
  if (cliVsBadge === "agree" && cliVsSession === "agree" && badgeVsSession === "agree") {
    return null;
  }

  return {
    kind: "resolver-disagreement",
    subject: { kind: "plugin", ref: pluginRef },
    cli,
    badge,
    sessionStart,
    pairs: { cliVsBadge, cliVsSession, badgeVsSession },
  };
}
