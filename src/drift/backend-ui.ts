/**
 * Drift detector for backend-ui-drift — phase 8.
 *
 * Compares persisted UI evidence against the CLI resolver simulation.
 * Source: SPEC-v1.0.md §7, §8.4.
 */

import type { UiObservation } from "../state/verify-in-ui-state.js";
import type { BackendUiDrift, CliUpdateSim, PluginRef } from "../types.js";

const DEFAULT_MAX_AGE_DAYS = 7;

export type BackendUiDriftInput = {
  pluginRef: PluginRef;
  observation: UiObservation;
  cliResolved: CliUpdateSim;
  /** Default: 7 days (matches --ui-evidence-max-age). */
  maxAgeDays?: number;
};

/**
 * Produces a BackendUiDrift for the given plugin + evidence.
 * Always returns a drift (even when not disagreeing) — the renderer
 * uses it informatively. Returns null only when input is fundamentally
 * invalid (capturedAt unparseable).
 */
export function detectBackendUiDrift(input: BackendUiDriftInput): BackendUiDrift | null {
  const { pluginRef, observation, cliResolved, maxAgeDays = DEFAULT_MAX_AGE_DAYS } = input;

  const capturedMs = Date.parse(observation.capturedAt);
  if (Number.isNaN(capturedMs)) return null;

  const ageMs = Date.now() - capturedMs;
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const uiObservedAge: "fresh" | "stale" = ageMs <= maxAgeMs ? "fresh" : "stale";

  // Three classes of disagreement (audit issue #7):
  //   1. both versions defined and differ (the original case)
  //   2. UI confirms plugin not listed but the CLI resolver knows a version
  //   3. UI shows a version but CLI confirms there is no version
  //
  // The "missing" classes guard on `cliResolved.unknowable === undefined` —
  // without that guard, every `--no-network` scan or backend-probe failure
  // would emit a false-positive disagreement, because `resolvedVersion` is
  // undefined under those conditions because we don't know, not because the
  // CLI claims absence.
  const cliKnowsResolved = cliResolved.unknowable === undefined;
  const cliHasVersion = cliResolved.resolvedVersion !== undefined;
  const disagrees =
    (observation.versionShown !== undefined &&
      cliHasVersion &&
      observation.versionShown !== cliResolved.resolvedVersion) ||
    (observation.pluginListed === false && cliKnowsResolved && cliHasVersion) ||
    (observation.versionShown !== undefined && cliKnowsResolved && !cliHasVersion);

  return {
    kind: "backend-ui-drift",
    subject: { kind: "plugin", ref: pluginRef },
    uiObserved: {
      ...(observation.versionShown !== undefined ? { version: observation.versionShown } : {}),
      ...(observation.statusShown !== undefined ? { status: observation.statusShown } : {}),
      ...(observation.updateAvailable !== undefined
        ? { updateAvailable: observation.updateAvailable }
        : {}),
    },
    uiObservedAt: observation.capturedAt,
    uiObservedAge,
    cliResolverSays: {
      ...(cliResolved.resolvedVersion !== undefined
        ? { version: cliResolved.resolvedVersion }
        : {}),
      resolvedFrom: cliResolved.resolvedFrom,
    },
    disagrees,
  };
}
