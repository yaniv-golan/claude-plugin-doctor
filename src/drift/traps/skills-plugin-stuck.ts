/**
 * Skills-plugin-stuck trap detector — tier E, phase 5.
 *
 * Detects the "stuck failure" pattern documented in the gist: the skills-plugin
 * manifest claims a recent update but the on-disk artifact is missing or much
 * older than the manifest claims.
 *
 * Source of truth: SPEC-v1.0.md §7.3.
 */

import type { CacheSnapshot, KnownTrap } from "../../types.js";

/**
 * Returns a `skills-plugin-stuck` KnownTrap when `snapshot.data.stuckFailureSignature === true`.
 * Returns null otherwise.
 */
export function detectSkillsPluginStuck(
  snapshot: Extract<CacheSnapshot, { layer: "skills_plugin" }>,
): Extract<KnownTrap, { kind: "skills-plugin-stuck" }> | null {
  if (!snapshot.data.stuckFailureSignature) return null;

  return {
    kind: "skills-plugin-stuck",
    subject: { kind: "root", ref: snapshot.rootRef },
    skill: snapshot.data.skill.name,
  };
}
