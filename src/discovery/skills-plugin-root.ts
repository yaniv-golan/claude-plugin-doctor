/**
 * Tier A — Discovery: skills-plugin root walker.
 *
 * Reads <userData>/local-agent-mode-sessions/skills-plugin/ and enumerates
 * SkillsPluginPair entries. Pure filesystem I/O; no manifest content parsing
 * (per spec §3.4 — manifest-content fields are added by tier C).
 *
 * IMPORTANT: The skills-plugin tree uses INVERTED order vs. cowork:
 *   cowork:       <acc>/<org>/
 *   skills-plugin: <orgId>/<accountId>/
 * This is per the gist and the SPEC-v1.0.md §3.1 SkillsPluginPair definition.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { NotImplementedError, resolveUserDataDir } from "../paths.js";
import type { SkillsPluginPair, SkillsPluginRoot, SkillsPluginSkill } from "../types.js";

type SystemContext = {
  platform?: NodeJS.Platform;
  home?: string;
};

/**
 * Enumerates skills under <pairDir>/skills/.
 * Each entry in the skills/ directory becomes a SkillsPluginSkill.
 * Tier A does NOT parse skill manifests — just stat-level existence.
 */
function enumerateSkills(pairDir: string): SkillsPluginSkill[] {
  const skillsDir = path.join(pairDir, "skills");
  if (!fs.existsSync(skillsDir)) return [];

  let skillDirNames: string[];
  try {
    skillDirNames = fs.readdirSync(skillsDir);
  } catch {
    return [];
  }

  const skills: SkillsPluginSkill[] = [];
  for (const skillName of skillDirNames) {
    const dirPath = path.join(skillsDir, skillName);
    let dirStat: fs.Stats;
    try {
      dirStat = fs.statSync(dirPath);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;

    const hasSkillMd = fs.existsSync(path.join(dirPath, "SKILL.md"));
    const dirMtime = dirStat.mtimeMs;

    skills.push({
      skillName,
      dirPath,
      hasSkillMd,
      ...(dirMtime !== undefined ? { dirMtime } : {}),
    });
  }

  return skills;
}

/**
 * Discovers the skills-plugin root under local-agent-mode-sessions/.
 *
 * Returns `undefined` if:
 *   - The platform is non-darwin (resolveUserDataDir throws NotImplementedError)
 *   - The skills-plugin/ directory doesn't exist
 *
 * Tree: skills-plugin/<orgId>/<accountId>/
 *   (INVERTED relative to cowork's <accountId>/<orgId>/)
 *
 * For each pair:
 *   - manifestPath: <orgId>/<accountId>/skills_plugin_manifest.json if it exists
 *   - manifestMtime: the file's mtime (stat only — no content parsing per §3.4)
 *   - skills: enumerated from <orgId>/<accountId>/skills/
 */
export function discoverSkillsPluginRoot(ctx?: SystemContext): SkillsPluginRoot | undefined {
  let userDataDir: string;
  try {
    userDataDir = resolveUserDataDir(ctx ?? {});
  } catch (err) {
    if (err instanceof NotImplementedError) return undefined;
    throw err;
  }

  const rootPath = path.join(userDataDir, "local-agent-mode-sessions", "skills-plugin");
  if (!fs.existsSync(rootPath)) return undefined;

  let orgDirs: string[];
  try {
    orgDirs = fs.readdirSync(rootPath);
  } catch {
    return { rootPath, pairs: [] };
  }

  const pairs: SkillsPluginPair[] = [];

  for (const orgId of orgDirs) {
    const orgDir = path.join(rootPath, orgId);
    let orgStat: fs.Stats;
    try {
      orgStat = fs.statSync(orgDir);
    } catch {
      continue;
    }
    if (!orgStat.isDirectory()) continue;

    let accountDirs: string[];
    try {
      accountDirs = fs.readdirSync(orgDir);
    } catch {
      continue;
    }

    for (const accountId of accountDirs) {
      const pairPath = path.join(orgDir, accountId);
      let pairStat: fs.Stats;
      try {
        pairStat = fs.statSync(pairPath);
      } catch {
        continue;
      }
      if (!pairStat.isDirectory()) continue;

      // Check for skills_plugin_manifest.json — stat only, no parse (tier C parses content).
      const manifestFile = path.join(pairPath, "skills_plugin_manifest.json");
      let manifestPath: string | undefined;
      let manifestMtime: number | undefined;
      if (fs.existsSync(manifestFile)) {
        try {
          const manifestStat = fs.statSync(manifestFile);
          manifestPath = manifestFile;
          manifestMtime = manifestStat.mtimeMs;
        } catch {
          // If we can't stat it after existsSync, skip silently.
        }
      }

      const skills = enumerateSkills(pairPath);

      pairs.push({
        orgId,
        accountId,
        rootPath: pairPath,
        skills,
        ...(manifestPath !== undefined ? { manifestPath } : {}),
        ...(manifestMtime !== undefined ? { manifestMtime } : {}),
      });
    }
  }

  return { rootPath, pairs };
}
