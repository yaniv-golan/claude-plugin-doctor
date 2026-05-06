/**
 * Tier A — Discovery: `extraKnownMarketplaces` settings reader.
 *
 * The CLI in 2.1.131 reads marketplace declarations from a settings-side
 * `extraKnownMarketplaces` key across five sources (gist revision
 * 2026-05-06T11:45:05Z, §"`known_marketplaces.json` is not the whole
 * declaration story"):
 *
 *   userSettings    $CLAUDE_CONFIG_DIR/settings.json (or ~/.claude/settings.json)
 *   projectSettings <cwd>/.claude/settings.json
 *   localSettings   <cwd>/.claude/settings.local.json (gitignored)
 *   coworkSettings  <userData>/local-agent-mode-sessions/<acc>/<org>/cowork_settings.json
 *   policySettings  /Library/Application Support/ClaudeCode/managed-settings.json
 *                   + drop-ins under managed-settings.d/*.json
 *                   (path verified by binary investigation 2026-05-06; see
 *                   docs/internal/INVESTIGATION-policy-settings-2026-05-06.md)
 *
 * Diagnostic tools that walk only `known_marketplaces.json` will miss
 * settings-declared marketplaces — so cpd reads all five and merges.
 *
 * Path injection: every reader function takes its file/directory paths as
 * arguments rather than resolving from `process.cwd()` or hard-coded
 * platform paths internally. This keeps tests hermetic — fixtures pass
 * tmp dirs, production callers pass resolved paths from the system context.
 *
 * Marketplace-name safety: `isSafeMarketplaceName` (from
 * `../known-marketplaces.ts`) is applied to every entry. Settings sources
 * can carry attacker-controlled names (especially `.claude/settings.local.json`
 * from a malicious project); rejecting unsafe names is essential.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { isSafeMarketplaceName } from "../known-marketplaces.js";
import type { KnownMarketplaceEntry, SettingsSource } from "../types.js";

// ── schema ───────────────────────────────────────────────────────────────────

const SourceSchema = z
  .object({
    source: z.string(),
  })
  .passthrough();

const EntrySchema = z
  .object({
    source: SourceSchema,
  })
  .passthrough();

/** A `settings.json`-style file. We only care about `extraKnownMarketplaces`;
 *  everything else passes through (including `enabledPlugins`, hooks, etc.). */
const SettingsFileSchema = z
  .object({
    extraKnownMarketplaces: z.record(z.string(), EntrySchema).optional(),
  })
  .passthrough();

// ── reader (single file) ─────────────────────────────────────────────────────

/**
 * Read and parse a single settings file's `extraKnownMarketplaces` map.
 *
 * Returns `undefined` if the file is absent (the dominant case — most
 * machines have no `extraKnownMarketplaces` set anywhere). Throws on
 * malformed JSON or schema-failed shapes; callers decide whether to
 * propagate or swallow.
 */
function readExtraKnownMarketplacesFile(
  filePath: string,
): Record<string, z.infer<typeof EntrySchema>> | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    throw new Error(`Failed to read settings file at ${filePath}: ${(e as Error).message}`);
  }
  if (raw.trim().length === 0) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Malformed settings JSON at ${filePath}: ${(e as Error).message}`);
  }
  const parsed = SettingsFileSchema.safeParse(json);
  if (!parsed.success) {
    // Don't reject the whole file — settings files may have unknown
    // top-level keys we should ignore. Only `extraKnownMarketplaces` matters.
    // The `.passthrough()` on the schema means parse failure here is rare
    // (only when `extraKnownMarketplaces` itself has a bad shape).
    throw new Error(
      `settings file extraKnownMarketplaces failed schema validation at ${filePath}: ${parsed.error.message}`,
    );
  }
  return parsed.data.extraKnownMarketplaces;
}

// ── public type ──────────────────────────────────────────────────────────────

/** A marketplace declaration loaded from one settings source, ready to
 *  merge into a per-root `marketplaces[]` array. */
export type ExtraKnownMarketplace = {
  name: string;
  source: { kind: string; raw: unknown };
  declaredIn: SettingsSource;
  raw: Record<string, unknown>;
};

/** Reads one settings source and returns its extraKnownMarketplaces entries
 *  with `declaredIn` tagged. Unsafe names (path-traversal characters etc.)
 *  are skipped with a stderr warning, mirroring the existing behavior of
 *  `parseKnownMarketplaces`. */
export function readExtraKnownMarketplacesFrom(
  filePath: string,
  declaredIn: SettingsSource,
): ExtraKnownMarketplace[] {
  const map = readExtraKnownMarketplacesFile(filePath);
  if (!map) return [];
  const out: ExtraKnownMarketplace[] = [];
  for (const [name, entry] of Object.entries(map)) {
    if (!isSafeMarketplaceName(name)) {
      process.stderr.write(
        `cpd: warning: ignoring extraKnownMarketplaces entry with unsafe name "${name}" in ${filePath}\n`,
      );
      continue;
    }
    out.push({
      name,
      source: { kind: entry.source.source, raw: entry.source as unknown },
      declaredIn,
      raw: entry as Record<string, unknown>,
    });
  }
  return out;
}

// ── path resolution ──────────────────────────────────────────────────────────

type SystemContext = {
  platform?: NodeJS.Platform;
  home?: string;
  env?: Record<string, string | undefined>;
  /** Used for project/local settings resolution. Defaults to process.cwd()
   *  when not injected. Tests inject a tmp dir. */
  cwd?: string;
};

/**
 * Resolved file paths for the four settings sources cpd reads on darwin.
 * `policySettings` is split into a base file and a drop-ins directory because
 * the CLI supports both (managed-settings.d/*.json). `coworkSettings` is
 * resolved per-root, not via SystemContext — see `coworkSettingsPath()` on
 * the cowork-roots side.
 */
export type SettingsPaths = {
  userSettings: string;
  projectSettings: string;
  localSettings: string;
  policySettingsBase: string;
  policySettingsDropInDir: string;
};

/**
 * Resolve the four cross-cutting + cwd-relative settings paths on macOS.
 * Cowork settings are resolved separately per root.
 *
 * Throws on non-darwin (cpd v0.1 is macOS-only). Linux/Windows path tables
 * exist in the gist for v0.2/v0.3 but are not implemented here.
 */
export function resolveSettingsPaths(ctx: SystemContext = {}): SettingsPaths {
  const platform = ctx.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new Error(
      `claude-plugin-doctor v0.1 supports macOS only (got platform=${platform}). Linux uses /etc/claude-code; Windows uses %ProgramFiles%\\ClaudeCode.`,
    );
  }
  const home = ctx.home ?? require("node:os").homedir();
  const env = ctx.env ?? process.env;
  const cwd = ctx.cwd ?? process.cwd();
  const claudeDir = env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude");
  // Policy root: path verified by binary investigation 2026-05-06.
  // Hermetic injection: tests redirect via env var CLAUDE_MANAGED_SETTINGS_DIR
  // (also useful for operators in non-standard MDM deployments). Without an
  // override, defaults to the canonical macOS path.
  const policyRoot = env.CLAUDE_MANAGED_SETTINGS_DIR ?? "/Library/Application Support/ClaudeCode";
  return {
    userSettings: path.join(claudeDir, "settings.json"),
    projectSettings: path.join(cwd, ".claude", "settings.json"),
    localSettings: path.join(cwd, ".claude", "settings.local.json"),
    policySettingsBase: path.join(policyRoot, "managed-settings.json"),
    policySettingsDropInDir: path.join(policyRoot, "managed-settings.d"),
  };
}

// ── policy drop-in enumeration ───────────────────────────────────────────────

/**
 * Enumerate `*.json` files under the policy drop-in directory. Returns paths
 * sorted lexicographically (the conventional drop-in merge order; the binary's
 * exact merge semantics aren't pinned by strings alone, but for marketplace
 * presence-detection — the union of `extraKnownMarketplaces` keys — order
 * doesn't matter).
 *
 * Returns `[]` if the directory is absent (dominant case on unmanaged hosts).
 */
export function enumerateDropIns(dropInDir: string): string[] {
  if (!fs.existsSync(dropInDir)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dropInDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => path.join(dropInDir, name));
}

// ── high-level reader ────────────────────────────────────────────────────────

/**
 * Read the four cross-cutting settings sources (`userSettings`,
 * `projectSettings`, `localSettings`, `policySettings` + drop-ins). Returns
 * a flat array of declarations with `declaredIn` set. Per-root cowork
 * settings are read separately by the caller (cowork-roots discovery).
 *
 * On non-darwin, returns an empty array (no error — the other discovery
 * functions handle platform errors at their boundaries; this one degrades
 * silently because it's purely additive).
 */
export function readCrossCuttingExtraKnownMarketplaces(
  ctx: SystemContext = {},
): ExtraKnownMarketplace[] {
  let paths: SettingsPaths;
  try {
    paths = resolveSettingsPaths(ctx);
  } catch {
    return [];
  }
  const out: ExtraKnownMarketplace[] = [];
  out.push(...readExtraKnownMarketplacesFrom(paths.userSettings, "userSettings"));
  out.push(...readExtraKnownMarketplacesFrom(paths.projectSettings, "projectSettings"));
  out.push(...readExtraKnownMarketplacesFrom(paths.localSettings, "localSettings"));
  out.push(...readExtraKnownMarketplacesFrom(paths.policySettingsBase, "policySettings"));
  for (const dropIn of enumerateDropIns(paths.policySettingsDropInDir)) {
    out.push(...readExtraKnownMarketplacesFrom(dropIn, "policySettings"));
  }
  return out;
}

// ── merge ────────────────────────────────────────────────────────────────────

/**
 * Merge `known_marketplaces.json` entries (already adapted to
 * `KnownMarketplaceEntry` shape) with `ExtraKnownMarketplace` declarations
 * from the settings sources. Dedupe by marketplace name; an entry appearing
 * in multiple sources accumulates `declaredIn`.
 *
 * Per-root semantics (see PLAN-2026-05-06-tranche-2.md "Per-root vs global
 * merge semantics"): the caller decides which subset of cross-cutting sources
 * to feed in. `userSettings` and `policySettings` are machine-global → feed
 * into every root. `coworkSettings` is per-root → feed only into that root.
 * `projectSettings` / `localSettings` are cwd-relative → feed into the root
 * that "owns" the current cwd (CCD by default in cpd v0.x).
 *
 * `hasClone` is set to true for entries that came from `known_marketplaces.json`
 * (the file's existence implies a clone is registered, even if the actual
 * directory may be missing — separate concern handled by drift detection),
 * false for settings-only entries.
 */
export function mergeMarketplaceDeclarations(
  knownMarketplaces: KnownMarketplaceEntry[],
  extras: ExtraKnownMarketplace[],
): KnownMarketplaceEntry[] {
  const byName = new Map<string, KnownMarketplaceEntry>();

  for (const km of knownMarketplaces) {
    byName.set(km.name, {
      ...km,
      declaredIn: ["known_marketplaces"],
      hasClone: true,
    });
  }

  for (const extra of extras) {
    const existing = byName.get(extra.name);
    if (existing) {
      // Merge declaredIn (dedupe), keep existing source/installLocation
      // (known_marketplaces wins for canonical fields since it represents
      // the materialized state).
      const declared = new Set(existing.declaredIn ?? []);
      declared.add(extra.declaredIn);
      existing.declaredIn = Array.from(declared);
    } else {
      byName.set(extra.name, {
        name: extra.name,
        source: extra.source,
        raw: extra.raw,
        declaredIn: [extra.declaredIn],
        hasClone: false,
      });
    }
  }

  return Array.from(byName.values());
}
