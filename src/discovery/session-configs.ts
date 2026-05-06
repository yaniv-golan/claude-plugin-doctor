/**
 * Tier A — Discovery: per-session feature-gate reader.
 *
 * Each Cowork session writes a JSON sidecar at
 * `<userData>/local-agent-mode-sessions/<acc>/<org>/local_<UUID>.json`
 * (sibling of the existing `local_<UUID>/` overlay directories enumerated
 * by `discovery/session-locals.ts`). These files carry top-level fields
 * including `pluginsEnabled` and `skillsEnabled` — sparse-optional flags
 * that are only written when the user toggles them away from the default
 * (true).
 *
 * Both flags are session-config-level (not user-toggleable through the
 * Settings UI per the gist) and gate whole subsystems off at session start.
 * If a user reports "my plugin is enabled and on disk but the running CLI
 * isn't using it", these are a likely cause when no other layer drift
 * applies. Per gist revision 2026-05-06T11:27:26Z §"Per-session feature
 * gates".
 *
 * Cap: 2048 files per cowork root. Heavy users can accumulate hundreds of
 * session JSONs; the cap is a backstop against pathological cases. When
 * hit, returns `truncated: true` and the caller emits a separate advisory
 * (`session-config-enumeration-truncated`).
 *
 * Sort: returned configs are ordered by `lastActivityAt desc` so consumers
 * (advisories' `exampleSessionIds`, future renderers) see most-recent
 * sessions first.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { SessionConfig } from "../types.js";

const SESSION_CONFIG_CAP = 2048;

const SessionConfigSchema = z
  .object({
    sessionId: z.string().optional(),
    pluginsEnabled: z.boolean().optional(),
    skillsEnabled: z.boolean().optional(),
    isArchived: z.boolean().optional(),
    lastActivityAt: z.string().optional(),
    title: z.string().optional(),
  })
  .passthrough();

export type SessionConfigEnumeration = {
  configs: SessionConfig[];
  /** True when the cap was hit and some files were not parsed. The caller
   *  emits a `session-config-enumeration-truncated` advisory. */
  truncated: boolean;
  /** Total number of `local_*.json` files seen (may exceed cap). */
  totalScanned: number;
};

/**
 * Walk a single Cowork root for `local_*.json` config files. Returns
 * `{ configs: [], truncated: false, totalScanned: 0 }` when the root or
 * directory is absent — never throws on missing paths.
 *
 * Malformed/unparseable individual files are skipped silently (the cowork
 * session manager owns these files; a tampered or partial-write JSON
 * shouldn't crash cpd's whole scan).
 */
export function enumerateSessionConfigs(coworkRootPath: string): SessionConfigEnumeration {
  if (!fs.existsSync(coworkRootPath)) {
    return { configs: [], truncated: false, totalScanned: 0 };
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(coworkRootPath);
  } catch {
    return { configs: [], truncated: false, totalScanned: 0 };
  }

  // Match `local_<UUID>.json` files only — exclude the `local_<UUID>/`
  // directories (which are session-local overlays handled by session-locals.ts)
  // and exclude `local_ditto_*` (bridge-history dirs at the account level
  // which can't appear here anyway, but be defensive).
  const sessionFiles = entries
    .filter((name) => name.startsWith("local_") && name.endsWith(".json"))
    .filter((name) => !name.startsWith("local_ditto_"));

  const totalScanned = sessionFiles.length;
  const truncated = totalScanned > SESSION_CONFIG_CAP;
  const filesToParse = truncated ? sessionFiles.slice(0, SESSION_CONFIG_CAP) : sessionFiles;

  const configs: SessionConfig[] = [];
  for (const fileName of filesToParse) {
    const filePath = path.join(coworkRootPath, fileName);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    if (raw.trim().length === 0) continue;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      continue; // skip malformed files; session manager owns them
    }
    const parsed = SessionConfigSchema.safeParse(json);
    if (!parsed.success) continue;
    configs.push({
      filePath,
      ...(parsed.data.sessionId !== undefined ? { sessionId: parsed.data.sessionId } : {}),
      ...(parsed.data.pluginsEnabled !== undefined
        ? { pluginsEnabled: parsed.data.pluginsEnabled }
        : {}),
      ...(parsed.data.skillsEnabled !== undefined
        ? { skillsEnabled: parsed.data.skillsEnabled }
        : {}),
      ...(parsed.data.isArchived !== undefined ? { isArchived: parsed.data.isArchived } : {}),
      ...(parsed.data.lastActivityAt !== undefined
        ? { lastActivityAt: parsed.data.lastActivityAt }
        : {}),
      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
    });
  }

  // Sort by lastActivityAt desc (most recent first). Configs without
  // lastActivityAt sort to the end (treated as oldest).
  configs.sort((a, b) => {
    const aT = a.lastActivityAt ?? "";
    const bT = b.lastActivityAt ?? "";
    if (!aT && !bT) return 0;
    if (!aT) return 1;
    if (!bT) return -1;
    return bT.localeCompare(aT);
  });

  return { configs, truncated, totalScanned };
}

/** Public for tests + future v0.2 use cases (e.g. cleanup tooling). */
export const SESSION_CONFIG_ENUMERATION_CAP = SESSION_CONFIG_CAP;
