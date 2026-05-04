/**
 * Tier B upstream probe dispatcher.
 *
 * Routes an `UpstreamSource` to the appropriate per-kind adapter.
 * Network gating (`opts.network === false`) short-circuits before any adapter
 * is called for network-bound kinds; I/O-free kinds (directory, backend, npm)
 * run regardless of the network flag.
 */

import type { UpstreamProbeOpts, UpstreamProbeResult, UpstreamSource } from "../types.js";
import { probeBackend } from "./backend.js";
import { probeDirectory } from "./directory.js";
import { probeGit } from "./git.js";
import { probeGitSubdir } from "./git-subdir.js";
import { probeGithub } from "./github.js";
import { probeNpm } from "./npm.js";
import { probeUrl } from "./url.js";

export async function probeUpstream(
  source: UpstreamSource,
  opts: UpstreamProbeOpts,
): Promise<UpstreamProbeResult> {
  switch (source.kind) {
    case "github":
      if (!opts.network) return { status: "no-network", reason: "--no-network" };
      return probeGithub(source, opts);

    case "git":
      if (!opts.network) return { status: "no-network", reason: "--no-network" };
      return probeGit(source, opts);

    case "git-subdir":
      if (!opts.network) return { status: "no-network", reason: "--no-network" };
      return probeGitSubdir(source, opts);

    case "url":
      if (!opts.network) return { status: "no-network", reason: "--no-network" };
      return probeUrl(source, opts);

    case "directory":
      // Local I/O — no network gating needed.
      return Promise.resolve(probeDirectory(source, opts));

    case "backend":
      // Always unknowable — no network gating needed.
      return Promise.resolve(probeBackend(source, opts));

    case "npm":
      // Not yet implemented — always unknowable.
      return Promise.resolve(probeNpm(source, opts));

    case "string":
      // String-form paths are local aliases; treat as directory probe.
      return Promise.resolve(probeDirectory({ kind: "directory", path: source.path }, opts));

    case "unrecognized":
      // Tier-B: the discriminator value isn't one cpd recognizes. The
      // higher-layer source-advisory detector ("Upgrade Claude Code") is
      // the right signal; the upstream probe itself can't classify, so
      // it's unknowable.
      return Promise.resolve({
        status: "unknowable",
        reason: "url-not-implemented",
      } as UpstreamProbeResult);
  }
}
