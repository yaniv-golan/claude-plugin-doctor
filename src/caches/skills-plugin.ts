/**
 * Tier C — Layer 7: skills-plugin cache reader.
 *
 * Reads the `skills-plugin/<orgId>/<accountId>/` directory pair populated by
 * Anthropic's built-in skill sync (10-min sync timer). Returns one
 * `CacheSnapshot` per skill enumerated by tier A's `SkillsPluginPair`.
 *
 * Subject note: skills-plugin snapshots use `subject: { kind: "skill", pair, skillName }`
 * rather than the `"rpm-plugin"` variant because skills don't have a
 * `<plugin>@<marketplace>` form (they are Anthropic-managed, not marketplace
 * plugins). The 4th variant on `CacheSnapshotBase.subject` was added to
 * `types.ts` to accommodate this.
 *
 * Stuck-failure detection (SPEC-v1.0.md §5.2.5 / gist §skills-plugin):
 *   A stuck failure is when the manifest claims a recent sync but the on-disk
 *   skill directory (SKILL.md) is missing or was last modified much earlier
 *   than what the manifest says. The fix is `rm -rf <skill-dir>` then Desktop
 *   refocus; this module only records the signature (tier E emits the trap).
 *
 * Manifest schema guess:
 *   The gist does not document the exact skills_plugin_manifest.json schema.
 *   We try three plausible field names for the per-skill update timestamp:
 *     - `updatedAt`
 *     - `lastUpdated`
 *     - `lastUpdatedAt`
 *   The manifest is expected to be an object where each key is a skill name
 *   and the value is a per-skill entry object. If the manifest uses a top-level
 *   array or completely different shape, we degrade gracefully (manifestUpdatedAt
 *   stays undefined, stuckFailureSignature stays false).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { CacheSnapshot, SkillsPluginData, SkillsPluginPair } from "../types.js";

// ── default thresholds ───────────────────────────────────────────────────────

const DEFAULT_RECENT_WINDOW_DAYS = 14;
const DEFAULT_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h in ms

/** Hard-coded built-in skills bundled into Desktop, rewritten every sync
 *  via `_writeBuiltInSkillsTo`. Can NOT go stuck via the API-download
 *  path (they don't take that path). Per gist §"Anthropic-managed skills
 *  cache" lines 485-490. Suppress stuckFailureSignature for these names
 *  regardless of disk state. */
export const BUILTIN_SKILLS = new Set(["schedule", "setup-cowork", "consolidate-memory"]);

// ── manifest schema (defensive, passthrough for forward-compat) ──────────────

/**
 * Per-skill entry inside the manifest. We try three candidate field names for
 * the update timestamp (updatedAt, lastUpdated, lastUpdatedAt). All are
 * optional; if none is present, manifestUpdatedAt stays undefined.
 */
const SkillManifestEntry = z
  .object({
    updatedAt: z.string().optional(),
    lastUpdated: z.string().optional(),
    lastUpdatedAt: z.string().optional(),
  })
  .passthrough();

/**
 * Top-level manifest: an object keyed by skill name, each value a per-skill
 * entry. We use `z.record` so unknown skill keys are accepted (forward-compat).
 * passthrough() is also set on the outer object for any top-level fields we
 * don't enumerate.
 */
const SkillsPluginManifestSchema = z.record(z.string(), SkillManifestEntry).or(
  // Fallback: if the manifest is a plain object with a `skills` sub-key or
  // completely unknown shape, this will fail parse gracefully and we return
  // undefined manifest data.
  z
    .object({})
    .passthrough(),
);

type ParsedManifest = Record<
  string,
  { updatedAt?: string; lastUpdated?: string; lastUpdatedAt?: string; [k: string]: unknown }
>;

function parseManifest(manifestPath: string): ParsedManifest | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    // E_PARSE_SKILLS_PLUGIN_MANIFEST: could not read/parse manifest file.
    // Silently continue — callers handle undefined gracefully.
    return undefined;
  }

  const result = SkillsPluginManifestSchema.safeParse(raw);
  if (!result.success) {
    // E_PARSE_SKILLS_PLUGIN_MANIFEST: manifest failed schema validation.
    // Silently continue — callers handle undefined gracefully.
    return undefined;
  }

  // If the raw value is not a plain object, treat as unparseable.
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }

  // Best-effort: SkillManifestEntry.passthrough lets extra fields through;
  // non-object values at skill keys will simply not carry a manifestUpdatedAt.

  return result.data as ParsedManifest;
}

function extractUpdatedAt(entry: Record<string, unknown>): string | undefined {
  // Try the three candidate field names in order of specificity
  for (const key of ["updatedAt", "lastUpdatedAt", "lastUpdated"] as const) {
    const v = entry[key];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

// ── args type ────────────────────────────────────────────────────────────────

export type SkillsPluginCheckArgs = {
  /** Tier A SkillsPluginPair — skills already enumerated, manifest path known. */
  pair: SkillsPluginPair;
  /** Absolute path to the skills-plugin root (parent of <orgId>/<accountId>/). */
  skillsPluginRootPath: string;
  /**
   * Window in days within which a manifest entry is considered "recent" for
   * stuck-failure detection. Default 14.
   */
  recentWindowDays?: number;
  /**
   * Age threshold past which a stale on-disk dir vs. recent manifest is
   * considered a stuck failure. Default 24h (in ms).
   */
  staleThresholdMs?: number;
};

// ── main export ──────────────────────────────────────────────────────────────

/**
 * Returns ONE `CacheSnapshot` per skill enumerated in `args.pair`.
 *
 * If the pair has no skills, returns an empty array.
 * The manifest (if present) is parsed once and reused across all skill snapshots.
 */
export function snapshotSkillsPluginPair(args: SkillsPluginCheckArgs): CacheSnapshot[] {
  const { pair } = args;
  const recentWindowMs =
    (args.recentWindowDays ?? DEFAULT_RECENT_WINDOW_DAYS) * 24 * 60 * 60 * 1000;
  const staleThresholdMs = args.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;

  // Parse the manifest once for the whole pair.
  let parsedManifest: ParsedManifest | undefined;
  if (pair.manifestPath) {
    if (fs.existsSync(pair.manifestPath)) {
      parsedManifest = parseManifest(pair.manifestPath);
    } else {
      // Manifest path was recorded by tier A but is no longer on disk.
      // This can happen due to a race between tier A enumeration and tier C
      // reading. Silently continue — parsedManifest stays undefined.
    }
  }

  const now = Date.now();
  const snapshots: CacheSnapshot[] = [];

  for (const skill of pair.skills) {
    // Look up per-skill manifest entry
    let manifestUpdatedAt: string | undefined;
    let manifestEntryRaw: Record<string, unknown> | undefined;

    if (parsedManifest) {
      const entry = parsedManifest[skill.skillName];
      if (entry && typeof entry === "object") {
        manifestUpdatedAt = extractUpdatedAt(entry);
        manifestEntryRaw = entry as Record<string, unknown>;
      }
    }

    // presence: "present" if dir exists with SKILL.md, else "absent"
    // Tier A's skill.hasSkillMd already captured this, but we re-check for
    // defensive safety (dir could have disappeared between tier A and tier C).
    const dirExists = fs.existsSync(skill.dirPath);
    const skillMdExists = dirExists && fs.existsSync(path.join(skill.dirPath, "SKILL.md"));
    const presence = skillMdExists ? "present" : "absent";

    // Stuck-failure detection — exempt built-in skills (they're rewritten on
    // every sync from the in-bundle copy and cannot go stuck via the API-download
    // path the detector targets).
    const isBuiltIn = BUILTIN_SKILLS.has(skill.skillName);
    let stuckFailureSignature = false;
    if (!isBuiltIn && manifestUpdatedAt) {
      const manifestDateMs = new Date(manifestUpdatedAt).getTime();
      if (!Number.isNaN(manifestDateMs)) {
        const manifestIsRecent = now - manifestDateMs < recentWindowMs;
        if (manifestIsRecent) {
          const skillMdMissing = !skillMdExists;
          const dirMuchOlder =
            skill.dirMtime !== undefined && manifestDateMs - skill.dirMtime > staleThresholdMs;
          stuckFailureSignature = skillMdMissing || dirMuchOlder;
        }
      }
    }

    // evidencePaths: skill dir + manifest path (if present)
    const evidencePaths: string[] = [skill.dirPath];
    if (pair.manifestPath) evidencePaths.push(pair.manifestPath);

    const data: SkillsPluginData = {
      kind: "skills_plugin",
      pair: { orgId: pair.orgId, accountId: pair.accountId, rootPath: pair.rootPath },
      skill: {
        name: skill.skillName,
        dirPath: skill.dirPath,
        hasSkillMd: skill.hasSkillMd,
        ...(skill.dirMtime !== undefined ? { dirMtime: skill.dirMtime } : {}),
        ...(manifestUpdatedAt !== undefined ? { manifestUpdatedAt } : {}),
        ...(manifestEntryRaw !== undefined ? { manifestEntryRaw } : {}),
      },
      stuckFailureSignature,
    };

    // Propagate isBuiltIn back to the topology skill entry so renderers and
    // JSON output can annotate built-ins without re-checking the constant.
    if (isBuiltIn) {
      skill.isBuiltIn = true;
    }

    const snapshot: CacheSnapshot = {
      layer: "skills_plugin",
      rootRef: { kind: "skills-plugin-pair", orgId: pair.orgId, accountId: pair.accountId },
      subject: {
        kind: "skill",
        pair: { orgId: pair.orgId, accountId: pair.accountId },
        skillName: skill.skillName,
      },
      presence,
      evidencePaths,
      parsedAt: new Date().toISOString(),
      data,
    };

    snapshots.push(snapshot);
  }

  return snapshots;
}
