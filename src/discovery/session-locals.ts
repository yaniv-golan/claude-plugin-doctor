/**
 * Tier A — Discovery: session-local directory enumerator.
 *
 * For each cowork root, scans sibling directories matching:
 *   - local_<UUID>/           → kind: "session-local"
 *   - local_ditto_<orgUuid>_g<N>/ → kind: "ditto-bridge-history"
 *
 * Returns a flat array across all roots.
 *
 * NOTE: `approxSizeBytes` uses fs.statSync(dir).size — on macOS this is the
 * directory-entry size (~64-512 bytes, not a recursive du). A recursive du is
 * too expensive for a topology pass; later phases can opt into it. The field
 * name intentionally says "approx" to set expectations.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { CoworkRoot, SessionLocalDir } from "../types.js";

// Pattern for session-local dirs: local_<UUID>
// UUID format: 8-4-4-4-12 hex chars (RFC 4122)
const SESSION_LOCAL_RE = /^local_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

// Pattern for ditto-bridge-history dirs: local_ditto_<orgUuid>_g<N>
const DITTO_BRIDGE_RE =
  /^local_ditto_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_g(\d+)$/i;

/**
 * Enumerates session-local and ditto-bridge-history directories inside a
 * cowork root's parent directory (the <accountId>/ level, siblings to <orgId>).
 *
 * The cowork root path is <sessionsDir>/<accountId>/<orgId>. Session-local
 * dirs live alongside the <orgId>/ directory, i.e. at the <accountId>/ level.
 *
 * Example tree:
 *   local-agent-mode-sessions/
 *     acc1/
 *       org1/           ← cowork root
 *       local_<UUID>/   ← session-local dir (sibling of org1)
 *       local_ditto_<orgUuid>_g2/ ← ditto dir
 */
export function discoverSessionLocals(coworkRoots: CoworkRoot[]): SessionLocalDir[] {
  const out: SessionLocalDir[] = [];

  // Track which account-level directories we've already scanned to avoid
  // duplicate enumeration when multiple orgs share the same accountId.
  const scannedAccDirs = new Set<string>();

  for (const root of coworkRoots) {
    // root.rootPath = <sessionsDir>/<accountId>/<orgId>
    // accDir       = <sessionsDir>/<accountId>
    const accDir = path.dirname(root.rootPath);

    if (scannedAccDirs.has(accDir)) continue;
    scannedAccDirs.add(accDir);

    let entries: string[];
    try {
      entries = fs.readdirSync(accDir);
    } catch {
      continue;
    }

    for (const name of entries) {
      const sessionMatch = SESSION_LOCAL_RE.exec(name);
      const dittoMatch = DITTO_BRIDGE_RE.exec(name);

      if (sessionMatch === null && dittoMatch === null) continue;

      const dirPath = path.join(accDir, name);
      let dirStat: fs.Stats;
      try {
        dirStat = fs.statSync(dirPath);
      } catch {
        continue;
      }
      if (!dirStat.isDirectory()) continue;

      // approxSizeBytes: directory entry size from stat. On macOS this is
      // typically 64–512 bytes (directory block size), NOT the recursive size.
      // A real du would be too expensive for a topology scan. Later phases
      // can opt into a recursive walk when the user explicitly requests cleanup.
      const approxSizeBytes = dirStat.size;
      const lastModified = dirStat.mtimeMs;

      if (sessionMatch !== null) {
        const uuid = sessionMatch[1];
        out.push({
          kind: "session-local",
          pathOnDisk: dirPath,
          parentRoot: root.rootPath,
          lastModified,
          approxSizeBytes,
          ...(uuid !== undefined ? { uuid } : {}),
        });
      } else if (dittoMatch !== null) {
        const orgUuid = dittoMatch[1];
        const generationStr = dittoMatch[2];
        const generation =
          generationStr !== undefined ? Number.parseInt(generationStr, 10) : undefined;
        out.push({
          kind: "ditto-bridge-history",
          pathOnDisk: dirPath,
          parentRoot: root.rootPath,
          lastModified,
          approxSizeBytes,
          ...(orgUuid !== undefined ? { orgUuid } : {}),
          ...(generation !== undefined ? { generation } : {}),
        });
      }
    }
  }

  return out;
}
