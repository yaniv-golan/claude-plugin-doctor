/**
 * Tier F — Recommendation planner.
 *
 * Aggregates Drift[] into an ordered RecommendedAction[].
 *
 * Ordering per SPEC-v1.0.md §8.2:
 *   1. Trap-level actions (marketplace-update-broken must run before per-plugin updates)
 *   2. Per-plugin updates (refresh-needed, bump-needed, badge-only-needed, unsupported-source)
 *   3. Manual steps (skills-plugin-stuck, session-bloat-cleanup-eligible)
 *   4. Global runtime boundary advisory (one synthetic action if any surface needs new-task+)
 *   5. verify-in-ui advisories last — never block, always advisory (§8.2 step 5)
 */

import { marketplaceRefKey, pluginRefKey, rootRefKey } from "../refs.js";
import type {
  BackendUiDrift,
  Drift,
  DriftRef,
  MarketplaceRef,
  PluginRef,
  PostActionAdvisory,
  RecommendedAction,
} from "../types.js";
import { computeGlobalRuntimeAdvisory } from "./advisories.js";
import { actionForDrift } from "./catalog.js";

/** Build a DriftRef from any Drift item. */
function driftToRef(d: Drift): DriftRef {
  switch (d.kind) {
    case "registration-drift":
      return { kind: d.kind };
    case "marketplace-update-broken":
      return { kind: d.kind, marketplaceRefKey: marketplaceRefKey(d.subject.ref) };
    case "session-bloat-cleanup-eligible":
    case "skills-plugin-stuck":
      return { kind: d.kind, rootRefKey: rootRefKey(d.subject.ref) };
    default: {
      const subj = d.subject as
        | { kind: "plugin"; ref: PluginRef }
        | { kind: "marketplace"; ref: MarketplaceRef };
      if (subj.kind === "plugin") {
        return { kind: d.kind, pluginRefKey: pluginRefKey(subj.ref) };
      }
      return { kind: d.kind, marketplaceRefKey: marketplaceRefKey(subj.ref) };
    }
  }
}

/**
 * Planner: composes drifts into an ordered RecommendedAction list.
 *
 * Each action declares:
 *  - fixes: the drift items it resolves
 *  - doesNotFix: all other drift items (gives users the complete picture)
 */
export function planRecommendations(
  drifts: Drift[],
  opts?: {
    /** Resolver map from the scan report — used to detect backend-unknowable
     *  plugins that warrant a verify-in-ui advisory (§8.2 step 5). */
    resolvers?: Record<string, { cli: { unknowable?: { reason: string } } }>;
  },
): RecommendedAction[] {
  // Split drifts by priority bucket. The output order is:
  //   1. trap-level (safe, runnable, high-fidelity diagnoses)
  //   2. per-plugin traps (refresh-needed, bump-needed, badge-only-needed —
  //      safe and runnable; bump-needed is multi-step but each step is safe)
  //   3. version-drift fallback (safe `claude plugin update <id>` for stale
  //      installs not flagged by a trap)
  //   4. unsupported-source (manual upgrade — heavyweight, rare; should not
  //      preempt the safe runnable fixes that solve common problems)
  //   5. manual-step (skills-plugin-stuck, session-bloat — destructive or
  //      requires confirmation)
  const trapLevel: Drift[] = [];
  const perPlugin: Drift[] = [];
  const unsupportedSource: Drift[] = [];
  const manualSteps: Drift[] = [];
  // Backend-ui drifts with disagrees===true get a verify-in-ui advisory.
  const backendUiDrifts: BackendUiDrift[] = [];

  // version-drift fallback bucket: separate from perPlugin so we can
  // suppress it when a higher-fidelity trap already covers the same plugin.
  const versionDriftFallback: Drift[] = [];

  for (const d of drifts) {
    switch (d.kind) {
      case "marketplace-update-broken":
        trapLevel.push(d);
        break;
      case "refresh-needed":
      case "bump-needed":
      case "badge-only-needed":
        perPlugin.push(d);
        break;
      case "unsupported-source":
        unsupportedSource.push(d);
        break;
      case "version-drift":
        // Only `ahead === "upstream"` produces an action (catalog newer than
        // installed). The other ahead values are advisory-only.
        if (d.ahead === "upstream") versionDriftFallback.push(d);
        break;
      case "skills-plugin-stuck":
      case "session-bloat-cleanup-eligible":
        manualSteps.push(d);
        break;
      case "backend-ui-drift":
        if (d.disagrees) backendUiDrifts.push(d);
        break;
      // Advisory-only kinds — no action generated
      case "npm-source-not-supported":
      case "resolver-disagreement":
      case "runtime-boundary":
      case "registration-drift":
        break;
    }
  }

  // Subsumption: a refresh-needed/bump-needed/badge-only-needed trap
  // already produces a fix that resolves the version mismatch on the same
  // plugin. Drop version-drift entries for any pluginRefKey already covered.
  const trapsCoverPluginRefKey = new Set<string>();
  for (const d of perPlugin) {
    if ((d as Drift & { subject: { kind: "plugin"; ref: PluginRef } }).subject?.kind === "plugin") {
      const ref = (d as Drift & { subject: { kind: "plugin"; ref: PluginRef } }).subject.ref;
      trapsCoverPluginRefKey.add(pluginRefKey(ref));
    }
  }
  const filteredVersionDrift = versionDriftFallback.filter((d) => {
    const ref = (d as Drift & { subject: { kind: "plugin"; ref: PluginRef } }).subject.ref;
    return !trapsCoverPluginRefKey.has(pluginRefKey(ref));
  });

  const orderedDrifts = [
    ...trapLevel,
    ...perPlugin,
    ...filteredVersionDrift,
    ...unsupportedSource,
    ...manualSteps,
  ];

  // Generate an action for each actionable drift.
  const rawActions: (RecommendedAction | undefined)[] = orderedDrifts.map((d, i) =>
    actionForDrift(d, i + 1),
  );
  const actions: RecommendedAction[] = rawActions.filter(
    (a): a is RecommendedAction => a !== undefined,
  );

  // 1.3 — Aggregate identical recommendations before renumbering.
  // Two recommendations are identical iff ALL six behavior fields match:
  //   description, cmd, risk, requiresYes, requiresManualStep, postActionAdvisory.
  // When two match, their fixes[] are merged+deduped into one entry.
  // NOT a factor: id, ordinal, fixes, doesNotFix.
  const aggregated: RecommendedAction[] = [];
  for (const action of actions) {
    const aggKey = JSON.stringify({
      description: action.description,
      cmd: action.cmd ?? null,
      risk: action.risk,
      requiresYes: action.requiresYes,
      requiresManualStep: action.requiresManualStep,
      postActionAdvisory: action.postActionAdvisory ?? null,
    });
    const existing = aggregated.find((a) => {
      const aKey = JSON.stringify({
        description: a.description,
        cmd: a.cmd ?? null,
        risk: a.risk,
        requiresYes: a.requiresYes,
        requiresManualStep: a.requiresManualStep,
        postActionAdvisory: a.postActionAdvisory ?? null,
      });
      return aKey === aggKey;
    });
    if (existing) {
      // Merge fixes[] — dedup by JSON serialization.
      const fixedKeys = new Set(existing.fixes.map((f) => JSON.stringify(f)));
      for (const fix of action.fixes) {
        const fk = JSON.stringify(fix);
        if (!fixedKeys.has(fk)) {
          existing.fixes.push(fix);
          fixedKeys.add(fk);
        }
      }
      // Merge refs[] so aggregated actions list every targeted plugin/
      // marketplace ref. The first-class `refs[]` field is what the future
      // ref-scoped runner selector reads — leaving it stale would silently
      // drop later-merged drifts.
      const existingRefs = new Set(existing.refs ?? []);
      for (const r of action.refs ?? []) {
        if (!existingRefs.has(r)) {
          existing.refs = existing.refs ?? [];
          existing.refs.push(r);
          existingRefs.add(r);
        }
      }
      // Aggregation key already requires identical (description, cmd, risk,
      // …); recipes are derived from those plus the drift kind, which is
      // identical across merged drifts (same conditionId implied by same
      // description). So `existing.recipes` stays valid as-is. If a future
      // catalog entry produces ref-specific recipe steps, the aggregation
      // key will need to include `JSON.stringify(recipes)`.
    } else {
      aggregated.push(action);
    }
  }

  // Re-number ordinals after aggregation.
  aggregated.forEach((a, i) => {
    a.ordinal = i + 1;
  });

  // Compute doesNotFix for each action: all drifts NOT in its fixes set.
  const allDriftRefs: DriftRef[] = drifts.map(driftToRef);
  for (const action of aggregated) {
    const fixedKeys = new Set(action.fixes.map((f) => JSON.stringify(f)));
    action.doesNotFix = allDriftRefs.filter((ref) => !fixedKeys.has(JSON.stringify(ref)));
  }

  // Replace actions array with aggregated result.
  actions.length = 0;
  for (const a of aggregated) actions.push(a);

  // Append a global runtime boundary advisory if any runtime-boundary drift requires it.
  const runtimeAdvisory = computeGlobalRuntimeAdvisory(drifts);
  if (runtimeAdvisory !== null && runtimeAdvisory !== "in-task") {
    const advisoryText =
      runtimeAdvisory === "ui-restart"
        ? "Restart Claude Desktop for config changes to take effect."
        : 'Start a new task ("+ New task") for skill/command/agent/hook changes to take effect in your running session.';
    const postAdvisory: PostActionAdvisory =
      runtimeAdvisory === "ui-restart" ? "ui-restart-required" : "new-task-required";
    const advisoryAction: RecommendedAction = {
      id: "advisory:runtime-boundary",
      conditionId: "install_snapshot:runtime_boundary_advisory",
      refs: [],
      ordinal: actions.length + 1,
      description: advisoryText,
      recipes: [{ kind: "advisory", instructions: advisoryText }],
      fixes: [],
      doesNotFix: [],
      postActionAdvisory: postAdvisory,
      risk: "safe",
      requiresYes: false,
      requiresManualStep: false,
    };
    actions.push(advisoryAction);
  }

  // §8.2 step 5 — verify-in-ui advisories last, never block.
  // Emit when:
  //   (a) any BackendUiDrift with disagrees===true is present, OR
  //   (b) any plugin's cli resolver is unknowable with reason "backend".
  const hasBackendUiDisagreement = backendUiDrifts.length > 0;
  const hasBackendUnknowable =
    opts?.resolvers !== undefined &&
    Object.values(opts.resolvers).some((r) => r.cli.unknowable?.reason === "backend");

  if (hasBackendUiDisagreement || hasBackendUnknowable) {
    const descriptions: string[] = [];
    if (hasBackendUiDisagreement) {
      const subjects = backendUiDrifts
        .map((d) => `${d.subject.ref.pluginName}@${d.subject.ref.marketplace}`)
        .join(", ");
      descriptions.push(
        `UI showed a different version/state than the CLI resolver predicts for: ${subjects}. Re-verify in Settings → Plugins after fixes.`,
      );
    } else {
      descriptions.push(
        'Some plugin states are backend-served. Run "cpd verify-in-ui <plugin>@<mp>" to capture observations.',
      );
    }
    const verifyDescription = descriptions.join(" ");
    const verifyAdvisory: RecommendedAction = {
      id: "advisory:verify-in-ui",
      conditionId: "install_snapshot:verify_in_ui_advisory",
      refs: [],
      ordinal: actions.length + 1,
      description: verifyDescription,
      recipes: [{ kind: "advisory", instructions: verifyDescription }],
      fixes: [],
      doesNotFix: [],
      postActionAdvisory: "verify-in-ui",
      risk: "safe",
      requiresYes: false,
      requiresManualStep: false,
    };
    actions.push(verifyAdvisory);
  }

  return actions;
}
