/**
 * Tier F — Recommendation catalog.
 *
 * Maps individual Drift items to RecommendedAction templates.
 * Returns undefined for advisory-only drift kinds (no auto-actionable fix).
 *
 * Source of truth: SPEC-v1.0.md §8.5 + §8.1.
 *
 * `conditionId` is a stable wire identifier in the form `<layer>:<condition>`.
 * It is APPEND-ONLY — never rename a value; only add new ones. Consumers
 * filter on these strings without parsing prose, so renames break agents.
 * The mapping below is the single source of truth for the conditionId
 * space.
 */

import { shellQuote } from "../output/cmd-format.js";
import { marketplaceRefKey, pluginRefKey, rootRefKey } from "../refs.js";
import type {
  ActionRecipe,
  Drift,
  MarketplaceRef,
  PluginRef,
  RecommendedAction,
} from "../types.js";

/** Map a drift kind to its catalog `<layer>:<condition>` identifier. Layer
 *  attribution is conservative; the values are public wire identifiers. */
function conditionIdForDriftKind(kind: Drift["kind"]): string {
  switch (kind) {
    case "marketplace-update-broken":
      return "marketplace_clone:update_broken";
    case "refresh-needed":
      return "marketplace_clone:refresh_needed";
    case "bump-needed":
      return "marketplace_clone:bump_needed";
    case "badge-only-needed":
      return "marketplace_clone:badge_only_needed";
    case "registration-drift":
      return "marketplace_clone:registration_drift";
    case "skills-plugin-stuck":
      return "cowork_mirror:skills_plugin_stuck";
    case "session-bloat-cleanup-eligible":
      return "cowork_mirror:session_bloat_cleanup_eligible";
    case "version-drift":
      return "install_snapshot:version_drift";
    case "resolver-disagreement":
      return "install_snapshot:resolver_disagreement";
    case "runtime-boundary":
      return "install_snapshot:runtime_boundary";
    case "unsupported-source":
      return "install_snapshot:unsupported_source";
    case "npm-source-not-supported":
      return "install_snapshot:npm_source_not_supported";
    case "backend-ui-drift":
      return "install_snapshot:backend_ui_drift";
  }
}

/** Extract a DriftRef-compatible key from a drift item's subject. */
function driftKeys(d: Drift): {
  pluginRefKey?: string;
  marketplaceRefKey?: string;
  rootRefKey?: string;
} {
  switch (d.kind) {
    case "registration-drift":
      return {};
    case "marketplace-update-broken":
      return { marketplaceRefKey: marketplaceRefKey(d.subject.ref) };
    case "session-bloat-cleanup-eligible":
    case "skills-plugin-stuck":
      return { rootRefKey: rootRefKey(d.subject.ref) };
    default: {
      // All remaining kinds have subject: { kind: "plugin" | "marketplace"; ref: ... }
      const subj = d.subject as
        | { kind: "plugin"; ref: PluginRef }
        | { kind: "marketplace"; ref: MarketplaceRef };
      if (subj.kind === "plugin") return { pluginRefKey: pluginRefKey(subj.ref) };
      return { marketplaceRefKey: marketplaceRefKey(subj.ref) };
    }
  }
}

/**
 * Generate a RecommendedAction template for a single drift item.
 * Returns undefined for drift kinds that are advisory-only (no standalone action).
 *
 * Wraps the raw template builder to attach the stable `conditionId`. Catalog
 * authors only have to populate `id` (per-instance) and the action body —
 * `conditionId` is derived from the drift kind in one place.
 */
type ActionTemplate = Omit<RecommendedAction, "conditionId" | "refs" | "recipes">;

export function actionForDrift(d: Drift, ordinal: number): RecommendedAction | undefined {
  const tpl = buildActionForDrift(d, ordinal);
  if (!tpl) return undefined;
  return {
    ...tpl,
    conditionId: conditionIdForDriftKind(d.kind),
    refs: refsForDrift(d),
    recipes: recipesForDrift(d),
  };
}

/** Map a drift to the sequence of typed recipes the fix runner executes.
 *  Always returns a non-empty array. Drifts that have no automated fix get
 *  a single `kind: "manual"` recipe that the runner never executes. */
function recipesForDrift(d: Drift): ActionRecipe[] {
  switch (d.kind) {
    case "marketplace-update-broken":
      // Force-fetch path: cpd refresh --force-fetch is the existing
      // consent-guarded git reset for stuck marketplace updates.
      return [{ kind: "cpd_refresh_force_fetch", marketplace: d.subject.ref.marketplace }];
    case "refresh-needed":
      // refresh marketplace, then update plugin.
      return [
        { kind: "claude_plugin_marketplace_update", marketplace: d.subject.ref.marketplace },
        {
          kind: "claude_plugin_update",
          plugin: d.subject.ref.pluginName,
          marketplace: d.subject.ref.marketplace,
        },
      ];
    case "version-drift":
      if (d.ahead !== "upstream") {
        return [
          {
            kind: "manual",
            instructions:
              "Installed version is ahead of or incomparable with the upstream catalog. Investigate before any action.",
          },
        ];
      }
      return [
        {
          kind: "claude_plugin_update",
          plugin: d.subject.ref.pluginName,
          marketplace: d.subject.ref.marketplace,
        },
      ];
    case "bump-needed":
      return [
        {
          kind: "manual",
          instructions: `Bump plugin.json#version in the source repo for ${d.subject.ref.pluginName}, push, then \`claude plugin marketplace update ${d.subject.ref.marketplace} && claude plugin update ${d.subject.ref.pluginName}@${d.subject.ref.marketplace}\`.`,
        },
      ];
    case "badge-only-needed":
      return [
        {
          kind: "manual",
          instructions: `Bump marketplace.json#plugins[].version in ${d.subject.ref.marketplace}'s catalog to match plugin.json#version.`,
        },
      ];
    case "skills-plugin-stuck":
      return [
        {
          kind: "manual",
          instructions:
            "Remove the stale skill, then quit and relaunch Claude Desktop. Focus alone is not a reliable trigger; full quit+relaunch always works.",
        },
      ];
    case "session-bloat-cleanup-eligible": {
      // Map to the same typed recipe the cmd encodes. Kept root-agnostic
      // (no `coworkRoot` field) — matches the existing cmd which prunes
      // every cowork root.
      const root = d.subject.ref;
      const coworkRoot =
        root.kind === "cowork" ? { accountId: root.accountId, orgId: root.orgId } : undefined;
      return [
        {
          kind: "cpd_cache_prune_cowork_sessions",
          olderThanDays: 14,
          ...(coworkRoot !== undefined ? { coworkRoot } : {}),
        },
      ];
    }
    case "unsupported-source":
      return [
        {
          kind: "manual",
          instructions: "Upgrade Claude Code to a version that supports this plugin's source kind.",
        },
      ];
    case "registration-drift":
    case "resolver-disagreement":
    case "runtime-boundary":
    case "backend-ui-drift":
    case "npm-source-not-supported":
      // Advisory-only — `actionForDrift` returns undefined for these, so this
      // branch is unreachable in practice. Defensive default: an advisory
      // recipe so the runner can never crash on a missing recipe.
      return [{ kind: "advisory", instructions: `Advisory only; no automated fix for ${d.kind}.` }];
  }
}

/** Extract the ref keys this drift's action targets. Plugin drifts produce
 *  one `pluginRefKey`; marketplace drifts produce one `marketplaceRefKey`;
 *  root-scoped drifts (skills-plugin-stuck, session-bloat-cleanup-eligible)
 *  produce an empty array since there's no plugin/marketplace subject. */
function refsForDrift(d: Drift): string[] {
  if (d.kind === "registration-drift") {
    return d.scope === "plugin" && d.marketplace
      ? [`${d.name}@${d.marketplace}`]
      : d.scope === "marketplace"
        ? [d.name]
        : [];
  }
  const subj = d.subject;
  if (!subj) return [];
  switch (subj.kind) {
    case "plugin":
      return [pluginRefKey(subj.ref)];
    case "marketplace":
      return [marketplaceRefKey(subj.ref)];
    case "root":
      return [];
  }
}

function buildActionForDrift(d: Drift, ordinal: number): ActionTemplate | undefined {
  const keys = driftKeys(d);
  const fixRef = { kind: d.kind as Drift["kind"], ...keys };

  switch (d.kind) {
    case "marketplace-update-broken": {
      const mp = d.subject.ref.marketplace;
      const _cloneDir = "<marketplace-clone-dir>";
      return {
        id: `action:marketplace-update-broken:${marketplaceRefKey(d.subject.ref)}`,
        ordinal,
        description: `Bypass the broken marketplace update for "${mp}" using git force-fetch`,
        cmd: `cpd refresh --force-fetch ${mp} --yes`,
        fixes: [fixRef],
        doesNotFix: [],
        risk: "destructive",
        requiresYes: true,
        requiresManualStep: false,
      };
    }

    case "refresh-needed": {
      const mp = d.subject.ref.marketplace;
      const pluginId = `${d.subject.ref.pluginName}@${mp}`;
      return {
        id: `action:refresh-needed:${pluginRefKey(d.subject.ref)}`,
        ordinal,
        description: `Refresh marketplace "${mp}" and update plugin "${pluginId}"`,
        // Quote interpolated names so a hostile marketplace name with shell
        // metacharacters can't turn the displayed cmd into an injection
        // vector when the user pastes it (audit issue #11).
        cmd: `claude plugin marketplace update ${shellQuote(mp)} && claude plugin update ${shellQuote(pluginId)}`,
        fixes: [fixRef],
        doesNotFix: [],
        risk: "safe",
        requiresYes: false,
        requiresManualStep: false,
      };
    }

    case "bump-needed": {
      // No `cmd` — this fix requires the user to edit a source repo
      // (bump `plugin.json#version`, commit, push), which can't be encoded
      // as a single runnable line. Per CLI-DESIGN, manual recommendations
      // omit `cmd` entirely; the prose lives in `description` and the
      // typed plan in `recipes` (kind: "manual").
      return {
        id: `action:bump-needed:${pluginRefKey(d.subject.ref)}`,
        ordinal,
        description: `Bump plugin.json#version in the source repo for "${d.subject.ref.pluginName}", push, then refresh and update`,
        fixes: [fixRef],
        doesNotFix: [],
        postActionAdvisory: "manual-step",
        risk: "safe",
        requiresYes: false,
        requiresManualStep: true,
      };
    }

    case "badge-only-needed": {
      const mp = d.subject.ref.marketplace;
      return {
        id: `action:badge-only-needed:${pluginRefKey(d.subject.ref)}`,
        ordinal,
        description: `Bump marketplace.json#plugins[].version in "${mp}"'s catalog to match plugin.json#version`,
        fixes: [fixRef],
        doesNotFix: [],
        postActionAdvisory: "manual-step",
        risk: "safe",
        requiresYes: false,
        requiresManualStep: true,
      };
    }

    case "skills-plugin-stuck": {
      // No `cmd` — the actual skill directory path isn't determinable from
      // the drift (the user picks among the stuck skill dirs they see) and
      // the fix also requires a Desktop quit+relaunch. Manual; description
      // and `recipes[]` carry the prose.
      return {
        id: `action:skills-plugin-stuck:${rootRefKey(d.subject.ref)}:${d.skill}`,
        ordinal,
        description:
          "Remove the stale skill, then quit and relaunch Claude Desktop. (Focusing Desktop is NOT a reliable trigger — the focus handler only fires sync if the last poll was older than the effective sync interval, which defaults to 10 min but can be GrowthBook-configured via skillsSyncIntervalMs. Quit+relaunch always works.)",
        fixes: [fixRef],
        doesNotFix: [],
        postActionAdvisory: "ui-restart-required",
        risk: "destructive",
        requiresYes: false,
        requiresManualStep: true,
      };
    }

    case "session-bloat-cleanup-eligible": {
      // The cli's `cache --prune-cowork-sessions` defaults to dry-run unless
      // `--yes` is passed (`cli.ts` derives `dryRun = !yes || dryRun`). The
      // recommendation's job is to fix the bloat, not just preview it, so the
      // generated cmd appends `--yes` and the action declares its destructive
      // nature truthfully (audit issue #2).
      return {
        id: `action:session-bloat:${rootRefKey(d.subject.ref)}`,
        ordinal,
        description: `Reclaim ~${Math.round(d.bytesReclaimable / (1024 * 1024))} MB from ${d.dirsCount} old session-local dirs`,
        cmd: "cpd cache --prune-cowork-sessions --older-than 14d --yes",
        fixes: [fixRef],
        doesNotFix: [],
        risk: "destructive",
        requiresYes: true,
        requiresManualStep: false,
      };
    }

    case "unsupported-source": {
      return {
        id: `action:unsupported-source:${pluginRefKey(d.subject.ref)}`,
        ordinal,
        description: `Upgrade Claude Code to a version that supports this plugin's source kind`,
        fixes: [fixRef],
        doesNotFix: [],
        postActionAdvisory: "manual-step",
        risk: "safe",
        requiresYes: false,
        requiresManualStep: true,
      };
    }

    // version-drift gets an action ONLY when the catalog has the newer
    // version (ahead === "upstream") — that's the "stale install" case
    // where `claude plugin update <id>` is the right fix. The other
    // versions of version-drift (ahead==="installed", ahead==="incomparable")
    // are advisory-only. The planner will suppress this action when a
    // refresh-needed/bump-needed/badge-only-needed trap already covers
    // the same plugin (those are higher-fidelity diagnoses for the same
    // symptom and emit the union of marketplace-update + plugin-update).
    case "version-drift": {
      if (d.ahead !== "upstream") return undefined;
      const mp = d.subject.ref.marketplace;
      const pluginId = `${d.subject.ref.pluginName}@${mp}`;
      return {
        id: `action:version-drift:${pluginRefKey(d.subject.ref)}`,
        ordinal,
        description: `Update plugin "${pluginId}" to the version available in the marketplace`,
        cmd: `claude plugin update ${shellQuote(pluginId)}`,
        fixes: [fixRef],
        doesNotFix: [],
        risk: "safe",
        requiresYes: false,
        requiresManualStep: false,
      };
    }

    // Advisory-only — no standalone action
    case "npm-source-not-supported":
    case "resolver-disagreement":
    case "runtime-boundary":
    case "registration-drift":
    // backend-ui-drift: advisory-only — no CLI command can resolve a
    // disagreement that exists only in the backend. A verify-in-ui advisory
    // is emitted by planRecommendations when disagrees===true.
    case "backend-ui-drift":
      return undefined;
  }
}
