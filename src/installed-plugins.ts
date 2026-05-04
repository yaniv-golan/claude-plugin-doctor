// Direct read of `~/.claude/plugins/installed_plugins.json` — never via
// `claude plugin list`.
//
// Why: when invoked from inside a running Claude Code / Desktop session, the
// `claude plugin list` subprocess can hang. Claude Desktop wraps it with a
// 60-second timeout and surfaces SIGTERM (exit 143) on hang; the CLI's
// `--available` mode performs a network roundtrip per marketplace which makes
// in-session execution fragile (Anthropic issue #49627). Diagnostic tools
// cannot rely on that subprocess. We read the registry file directly with
// our own zod schema and never shell out.
//
// If you find yourself adding a `claude plugin list` call to fix a perceived
// gap here, look for the data in `installed_plugins.json` or one of the
// caches/* readers first. The hang is not theoretical.
import * as fs from "node:fs";
import { z } from "zod";
import { parsePluginId } from "./refs.js";
import type { InstalledPluginScope, InstalledScope } from "./types.js";

// SCHEMA-NOTE: shape verified against Claude Desktop 1.5354.0.
// `plugins[<id>]` is always an `Array<Entry>` in real files (multiple installations
// per plugin id are possible — `user`, `project`, `local`). An earlier defensive
// fallback for a single-Entry shape was removed after confirming no real file
// ever used it. The "version" field on the file itself is documented as currently 2;
// we surface unknown values so we can warn rather than crash (SPEC.md §14).
const EntrySchema = z
  .object({
    version: z.string(),
    installPath: z.string(),
  })
  .passthrough();

const FileSchema = z
  .object({
    version: z.number().optional(),
    plugins: z.record(z.string(), z.array(EntrySchema).min(1)),
  })
  .passthrough();

export type InstalledPlugin = {
  id: string;
  pluginName: string;
  marketplace: string;
  scopes: InstalledPluginScope[];
};

export type ParseResult = {
  present: boolean;
  fileVersion?: number;
  unknownFileVersion: boolean;
  mtimeMs?: number;
  plugins: InstalledPlugin[];
};

const KNOWN_FILE_VERSIONS: ReadonlySet<number> = new Set([2]);

// Internal alias kept for source-stability; new code should use `parsePluginId`
// directly from `refs.ts`. Both forms split on `lastIndexOf("@")` so they
// round-trip scoped names like `@scope/foo@mp` correctly (audit issue #13).
const splitId = parsePluginId;

function normalizeScope(v: unknown): InstalledScope {
  if (v === "user" || v === "project" || v === "local" || v === "managed") return v;
  return "unknown";
}

function entryToScope(e: z.infer<typeof EntrySchema>): InstalledPluginScope {
  const raw = e as Record<string, unknown>;
  return {
    scope: normalizeScope(raw.scope),
    version: e.version,
    installPath: e.installPath,
    ...(typeof raw.gitCommitSha === "string" ? { gitCommitSha: raw.gitCommitSha } : {}),
    ...(typeof raw.installedAt === "string" ? { installedAt: raw.installedAt } : {}),
    ...(typeof raw.lastUpdated === "string" ? { lastUpdated: raw.lastUpdated } : {}),
    raw,
  };
}

// Both helpers accept anything with a `scopes` array — `InstalledPlugin` from
// this module and `PluginReport` from `types.ts` share that shape. Structural
// typing keeps the helpers usable across both v0.5 and v1.0 surfaces.
type HasScopes = { scopes: InstalledPluginScope[] };

/**
 * Returns the first scope, in file order. Kept as an escape hatch for
 * formatters that genuinely want "whatever Claude wrote first." Most callers
 * want `preferredScope` instead — see audit issue #12.
 */
export function firstScope(p: HasScopes): InstalledPluginScope {
  // Parser guarantees `scopes` has at least one entry (z.array(...).min(1) on FileSchema).
  // biome-ignore lint/style/noNonNullAssertion: invariant enforced by zod schema
  return p.scopes[0]!;
}

/**
 * Returns the canonical scope for display and drift detection: prefers `user`
 * over `project` over `local`, falling back to the first scope when none of
 * those match (e.g. `managed` / `unknown`-only installs).
 *
 * Picking by file order (`firstScope`) hides stale installs when, say, the
 * `local` scope happens to appear before `user` and `user` is the one out of
 * date (audit issue #12). The composer uses this same priority order at
 * `drift/compose.ts:185-189`; this helper unifies the two implementations.
 */
export function preferredScope(p: HasScopes): InstalledPluginScope {
  return (
    p.scopes.find((s) => s.scope === "user") ??
    p.scopes.find((s) => s.scope === "project") ??
    p.scopes.find((s) => s.scope === "local") ??
    firstScope(p)
  );
}

/** @deprecated Use `firstScope` (file-order) or `preferredScope` (canonical). */
export const primaryScope = firstScope;

export function parseInstalledPlugins(filePath: string): ParseResult {
  if (!fs.existsSync(filePath)) {
    return { present: false, unknownFileVersion: false, plugins: [] };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    throw new Error(
      `Failed to read installed_plugins.json at ${filePath}: ${(e as Error).message}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Malformed installed_plugins.json at ${filePath}: ${(e as Error).message}`);
  }
  const parsed = FileSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `installed_plugins.json failed schema validation at ${filePath}: ${parsed.error.message}`,
    );
  }
  const stat = fs.statSync(filePath);
  const out: InstalledPlugin[] = [];
  for (const [id, entries] of Object.entries(parsed.data.plugins)) {
    const split = splitId(id);
    if (!split) {
      throw new Error(
        `installed_plugins.json at ${filePath} has invalid entry key "${id}" (expected "<plugin>@<marketplace>").`,
      );
    }
    const scopes = entries.map(entryToScope);
    out.push({
      id,
      pluginName: split.pluginName,
      marketplace: split.marketplace,
      scopes,
    });
  }
  const fileVersion = parsed.data.version;
  const unknownFileVersion = fileVersion !== undefined && !KNOWN_FILE_VERSIONS.has(fileVersion);
  return {
    present: true,
    ...(fileVersion !== undefined ? { fileVersion } : {}),
    unknownFileVersion,
    mtimeMs: stat.mtimeMs,
    plugins: out,
  };
}
