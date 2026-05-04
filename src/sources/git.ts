/**
 * Tier B upstream probe for `kind: "git"` sources (arbitrary HTTPS/SSH URLs).
 *
 * Uses `gitLsRemote` from `src/git.ts` to fetch the remote HEAD SHA.
 * `pluginJsonVersion` is left undefined — no generic remote raw-content
 * endpoint exists for arbitrary git URLs (planned, not yet implemented).
 */

import { gitLsRemote } from "../git.js";
import type { UpstreamProbeOpts, UpstreamProbeResult } from "../types.js";

export async function probeGit(
  source: { kind: "git"; url: string; ref?: string },
  opts: UpstreamProbeOpts,
): Promise<UpstreamProbeResult> {
  if (!opts.network) {
    return { status: "no-network", reason: "--no-network" };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", () => ac.abort(), { once: true });
  }

  try {
    const lsResult = await gitLsRemote(source.url, source.ref);

    if (!lsResult.ok) {
      const reason = lsResult.error;
      if (reason.includes("timed out")) {
        return { status: "unreachable", reason: "git-ls-remote-timeout" };
      }
      return { status: "unreachable", reason };
    }

    let head: string | undefined;
    if (source.ref) {
      head =
        lsResult.refs.get(source.ref) ??
        lsResult.refs.get(`refs/heads/${source.ref}`) ??
        lsResult.refs.get(`refs/tags/${source.ref}`);
    } else {
      head = lsResult.defaultBranchSha;
    }

    if (!head) {
      return {
        status: "unreachable",
        reason: source.ref ? `ref-not-found: ${source.ref}` : "no-default-branch-sha",
      };
    }

    return {
      status: "fresh",
      head,
      fetchedAt: new Date().toISOString(),
    };
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") {
      return { status: "unreachable", reason: "git-fetch-timeout" };
    }
    return { status: "unreachable", reason: err.message };
  } finally {
    clearTimeout(timer);
  }
}
