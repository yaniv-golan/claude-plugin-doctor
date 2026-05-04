/**
 * Tier B upstream probe for `kind: "url"` sources.
 *
 * If the URL is a GitHub URL (git@github.com: or https://github.com/),
 * parses the repo and delegates to `probeGithub`. Otherwise returns
 * "unknowable" — v1.1 will expand non-github URL support.
 */

import { parseGithubUrl } from "../remote-fetch.js";
import type { UpstreamProbeOpts, UpstreamProbeResult } from "../types.js";
import { probeGithub } from "./github.js";

export async function probeUrl(
  source: { kind: "url"; url: string; ref?: string },
  opts: UpstreamProbeOpts,
): Promise<UpstreamProbeResult> {
  const gh = parseGithubUrl(source.url);
  if (gh) {
    const repo = `${gh.owner}/${gh.repo}`;
    const ghSource =
      source.ref !== undefined
        ? { kind: "github" as const, repo, ref: source.ref }
        : { kind: "github" as const, repo };
    return probeGithub(ghSource, opts);
  }
  return { status: "unknowable", reason: "url-not-implemented" };
}
