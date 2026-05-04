import * as fs from "node:fs";
import { z } from "zod";

/** rpm/manifest.json `plugins` field has TWO real-world shapes:
 *
 *   1. **Object-keyed** (older, pre-Cowork-1.x):
 *        { plugins: { "<plugin-id>": { installedBy, updatedAt, ... } } }
 *
 *   2. **Array-of-entries** (newer, observed against Cowork 1.x mid-2026):
 *        { plugins: [{ id, name, marketplaceId, ..., installedBy, updatedAt }] }
 *
 *  Both forms carry the same per-entry information; only the indexing differs.
 *  The parser normalizes both to the same `RpmEntry[]` output. */
const EntrySchema = z
  .object({
    /** Array form carries `id` per-entry; object form has it as the key. */
    id: z.string().optional(),
    installedBy: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

const FileSchema = z
  .object({
    plugins: z
      .union([
        // Object-keyed: { "plugin-id": { ... } }
        z.record(z.string(), EntrySchema),
        // Array-of-entries: [{ id, ... }, ...]
        z.array(EntrySchema),
      ])
      .optional(),
  })
  .passthrough();

export type RpmInstalledBy = "auto" | "user" | "unknown";

export type RpmEntry = {
  pluginId: string;
  installedBy: RpmInstalledBy;
  updatedAt?: string;
  raw: Record<string, unknown>;
};

export type ParseResult = {
  present: boolean;
  entries: RpmEntry[];
};

function normalizeInstalledBy(v: string | undefined): RpmInstalledBy {
  if (v === "auto" || v === "user") return v;
  return "unknown";
}

export function parseRpmManifest(filePath: string): ParseResult {
  if (!fs.existsSync(filePath)) {
    return { present: false, entries: [] };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    throw new Error(`Failed to read rpm/manifest.json at ${filePath}: ${(e as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Malformed rpm/manifest.json at ${filePath}: ${(e as Error).message}`);
  }
  const parsed = FileSchema.safeParse(json);
  if (!parsed.success) {
    // Don't dump the raw Zod trace at the user — it's verbose, not actionable,
    // and was previously printing 50+ lines of nested unionErrors on every
    // malformed manifest. Most malformed RPM manifests are either an in-flight
    // backend rewrite or a future schema variant cpd doesn't recognize yet;
    // either way the user can't fix it locally.
    //
    // The full Zod error is attached to the thrown Error as a non-enumerable
    // `cause` property so `--log-level debug` consumers can still get it.
    const err = new Error(
      `rpm/manifest.json at ${filePath} doesn't match the expected shape. This usually means the file was written by a newer Claude Desktop than cpd was tested against, or it was rewritten mid-flight by the backend sync. Re-run with --log-level debug for the full validation trace.`,
    );
    Object.defineProperty(err, "cause", { value: parsed.error, enumerable: false });
    throw err;
  }
  const out: RpmEntry[] = [];
  const plugins = parsed.data.plugins;
  if (Array.isArray(plugins)) {
    // Array form (Cowork ≥ 1.x): each entry self-describes its id via `id`.
    for (const entry of plugins) {
      const pluginId = entry.id;
      if (typeof pluginId !== "string") continue; // skip malformed entries
      out.push({
        pluginId,
        installedBy: normalizeInstalledBy(entry.installedBy),
        ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
        raw: entry as Record<string, unknown>,
      });
    }
  } else if (plugins && typeof plugins === "object") {
    // Object-keyed form (older).
    for (const [pluginId, entry] of Object.entries(plugins)) {
      out.push({
        pluginId,
        installedBy: normalizeInstalledBy(entry.installedBy),
        ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
        raw: entry as Record<string, unknown>,
      });
    }
  }
  return { present: true, entries: out };
}
