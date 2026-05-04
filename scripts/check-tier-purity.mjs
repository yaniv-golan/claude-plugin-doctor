#!/usr/bin/env node
/**
 * Tier-boundary purity checker — enforces spec §14 import rules.
 *
 * Pure tiers (D: resolvers, E: drift, F: recommendations) MUST NOT import
 * I/O modules. This script scans every .ts file under those three directories
 * and exits non-zero if a forbidden import is found.
 *
 * Forbidden under src/resolvers/, src/drift/, src/recommendations/:
 *   - node:fs (and subpaths like node:fs/promises)
 *   - node:child_process
 *   - node:net
 *   - node:http
 *   - node:https
 *   - fetch( calls (global fetch used for HTTP)
 *
 * Allowed (pure utilities):
 *   - node:path
 *   - node:url
 *   - node:crypto
 *
 * Usage:
 *   node scripts/check-tier-purity.mjs            # check src/
 *   node scripts/check-tier-purity.mjs <dir>...   # check specific dirs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Directories housing pure tiers — no I/O allowed.
const PURE_TIER_DIRS = ["src/resolvers", "src/drift", "src/recommendations"].map((d) =>
  resolve(repoRoot, d),
);

// Forbidden import patterns. Tested against the string inside from "..." quotes.
// Bare string match (startsWith) for module paths; regex for fetch calls.
const FORBIDDEN_IMPORTS = [
  // node: builtins that do I/O
  (s) => s.startsWith("node:fs"),
  (s) => s.startsWith("node:child_process"),
  (s) => s.startsWith("node:net"),
  (s) => s.startsWith("node:http"),
  (s) => s.startsWith("node:https"),
];

// Patterns on the raw source text (not just import paths) — catches global fetch().
const FORBIDDEN_SOURCE_PATTERNS = [/\bfetch\s*\(/];

/** Recursively collect .ts files (excluding .d.ts) from a directory. */
function collectTsFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results; // directory doesn't exist — skip silently
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Extract the quoted string from a static import / require line.
 * Returns null if the line isn't a static import.
 */
function extractImportPath(line) {
  // Match: import ... from "..."  or  import "..."  or  export ... from "..."
  const m = line.match(/\bfrom\s+["']([^"']+)["']/) ?? line.match(/\bimport\s+["']([^"']+)["']/);
  return m ? m[1] : null;
}

let violations = 0;

for (const dir of PURE_TIER_DIRS) {
  const files = collectTsFiles(dir);
  for (const file of files) {
    const rel = relative(repoRoot, file);
    let src;
    try {
      src = readFileSync(file, "utf8");
    } catch (e) {
      console.error(`[tier-purity] Cannot read ${rel}: ${e.message}`);
      violations++;
      continue;
    }
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineno = i + 1;

      // Check static import paths.
      const importPath = extractImportPath(line);
      if (importPath) {
        for (const forbid of FORBIDDEN_IMPORTS) {
          if (forbid(importPath)) {
            console.error(
              `[tier-purity] FORBIDDEN IMPORT in ${rel}:${lineno}: "${importPath}"\n  Pure tier (D/E/F) must not import I/O modules. See spec §14.`,
            );
            violations++;
          }
        }
      }

      // Check raw source for fetch() calls.
      for (const pattern of FORBIDDEN_SOURCE_PATTERNS) {
        if (pattern.test(line)) {
          console.error(
            `[tier-purity] FORBIDDEN CALL in ${rel}:${lineno}: fetch()\n  Pure tier (D/E/F) must not make network calls. See spec §14.`,
          );
          violations++;
        }
      }
    }
  }
}

if (violations === 0) {
  console.log(
    "[tier-purity] OK — no forbidden imports in pure tiers (src/resolvers/, src/drift/, src/recommendations/).",
  );
  process.exit(0);
} else {
  console.error(
    `\n[tier-purity] ${violations} violation(s) found. Pure tiers must not import I/O modules.`,
  );
  process.exit(1);
}
