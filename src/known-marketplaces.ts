import * as fs from "node:fs";
import { z } from "zod";

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

// SCHEMA-NOTE: real-world files (verified against Claude Desktop 1.5354.0) are a
// flat object whose keys are marketplace names. An earlier defensive
// `WrappedFileSchema` fallback for `{ marketplaces: { ... } }` was removed
// after confirming no real file ever used that shape.
const FileSchema = z.record(z.string(), EntrySchema);

export type KnownMarketplaceSource = z.infer<typeof SourceSchema>;

export type KnownMarketplace = {
  name: string;
  source: KnownMarketplaceSource;
  raw: Record<string, unknown>;
};

export type ParseResult = {
  present: boolean;
  marketplaces: KnownMarketplace[];
};

export function parseKnownMarketplaces(filePath: string): ParseResult {
  if (!fs.existsSync(filePath)) {
    return { present: false, marketplaces: [] };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    throw new Error(
      `Failed to read known_marketplaces.json at ${filePath}: ${(e as Error).message}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Malformed known_marketplaces.json at ${filePath}: ${(e as Error).message}`);
  }
  const parsed = FileSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `known_marketplaces.json failed schema validation at ${filePath}: ${parsed.error.message}`,
    );
  }
  // Defense-in-depth (audit issue #9): marketplace names are joined into
  // filesystem paths (e.g. `<pluginsRoot>/marketplaces/<name>`) and a name
  // containing path separators or `..` segments would let a corrupted
  // `known_marketplaces.json` direct cpd's reads at locations outside the
  // intended cache root. Real Claude installs never produce such names; if
  // we see one, skip it loudly rather than fail the whole load.
  const out: KnownMarketplace[] = [];
  for (const [name, entry] of Object.entries(parsed.data)) {
    if (!isSafeMarketplaceName(name)) {
      process.stderr.write(
        `cpd: warning: ignoring marketplace entry with unsafe name "${name}" in ${filePath}\n`,
      );
      continue;
    }
    out.push({
      name,
      source: entry.source,
      raw: entry as Record<string, unknown>,
    });
  }
  return { present: true, marketplaces: out };
}

/** Reject names containing path separators, `..` segments, or a leading dot.
 *  Allowing those would let a corrupted known_marketplaces.json escape the
 *  cache directory when names are joined into paths. */
export function isSafeMarketplaceName(name: string): boolean {
  if (name.length === 0) return false;
  if (name.startsWith(".")) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("..")) return false;
  return true;
}
