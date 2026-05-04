/**
 * Tier B upstream probe for `kind: "git-subdir"` sources.
 *
 * Delegates to the same git ls-remote logic as `probeGit`. The `path` field
 * is recorded on the source for future per-subdir plugin.json fetch — no
 * subdir raw-content endpoint exists yet.
 */

import type { UpstreamProbeOpts, UpstreamProbeResult } from "../types.js";
import { probeGit } from "./git.js";

export async function probeGitSubdir(
  source: { kind: "git-subdir"; url: string; path: string; ref?: string },
  opts: UpstreamProbeOpts,
): Promise<UpstreamProbeResult> {
  // path is preserved on source for future phase 3 use; phase 2 ignores it.
  const gitSource =
    source.ref !== undefined
      ? { kind: "git" as const, url: source.url, ref: source.ref }
      : { kind: "git" as const, url: source.url };
  return probeGit(gitSource, opts);
}
