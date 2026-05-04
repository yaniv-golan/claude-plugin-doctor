/**
 * plugin-json.ts — tier E helper (NEW v1.0).
 *
 * Small parser for `.claude-plugin/plugin.json` files. Used by the drift
 * composer and changed-surfaces derivation to diff installed vs. resolved
 * plugin manifests.
 *
 * Architecture note: parsing is intentionally kept here (an I/O-capable
 * module at the src/ root) rather than inside src/drift/ (a pure tier).
 * The scan command reads both plugin.json files and passes the parsed shapes
 * into composeDrift via the ComposerInput side-channel. This preserves tier
 * E purity while making the data available to changed-surfaces derivation.
 *
 * Returns undefined (never throws) when the file is missing or malformed.
 * Throw `CpdError("E_PARSE_PLUGIN_JSON", ...)` only in contexts where an
 * explicit parse failure must surface to the caller.
 *
 * Source: SPEC-v1.0.md §7.2.1 + §4 (phase 3 implementation).
 */

import * as fs from "node:fs";

export type ParsedPluginJson = {
  version?: string;
  commands?: unknown;
  agents?: unknown;
  skills?: unknown;
  hooks?: unknown;
  mcpServers?: unknown;
  raw: Record<string, unknown>;
};

/**
 * Parse a plugin.json file at `filePath`.
 *
 * Returns undefined when:
 *   - the file does not exist
 *   - the file contains malformed JSON
 *   - the top-level value is not an object
 *
 * Never throws. Callers that need a typed error should call this and check
 * for undefined, then construct a CpdError("E_PARSE_PLUGIN_JSON", …) themselves.
 */
export function parsePluginJson(filePath: string): ParsedPluginJson | undefined {
  if (!fs.existsSync(filePath)) return undefined;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const obj = parsed as Record<string, unknown>;

  return {
    ...(typeof obj.version === "string" ? { version: obj.version } : {}),
    ...(obj.commands !== undefined ? { commands: obj.commands } : {}),
    ...(obj.agents !== undefined ? { agents: obj.agents } : {}),
    ...(obj.skills !== undefined ? { skills: obj.skills } : {}),
    ...(obj.hooks !== undefined ? { hooks: obj.hooks } : {}),
    ...(obj.mcpServers !== undefined ? { mcpServers: obj.mcpServers } : {}),
    raw: obj,
  };
}
