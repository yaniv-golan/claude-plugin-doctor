/**
 * Tier B upstream probe for `kind: "directory"` sources.
 *
 * Checks local directory mtime. No network I/O. Returns "fresh" with mtime
 * as the head if the path is accessible; "unreachable" otherwise.
 *
 * `pluginJsonVersion` is left undefined — per-plugin manifest reading is
 * tier C's responsibility.
 */

import * as fs from "node:fs";
import type { UpstreamProbeOpts, UpstreamProbeResult } from "../types.js";

export function probeDirectory(
  source: { kind: "directory"; path: string },
  _opts: UpstreamProbeOpts,
): UpstreamProbeResult {
  try {
    const stat = fs.statSync(source.path);
    // Use mtime in milliseconds as the "head" — a stable, monotonic marker.
    const mtimeMs = stat.mtimeMs;
    return {
      status: "fresh",
      head: String(mtimeMs),
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return { status: "unreachable", reason: "directory-not-found" };
  }
}
