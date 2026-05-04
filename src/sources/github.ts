/**
 * Tier B upstream probe for `kind: "github"` sources.
 *
 * Fetches the remote HEAD SHA via `git ls-remote` and optionally retrieves the
 * `version` field from `.claude-plugin/plugin.json` at that SHA via
 * raw.githubusercontent.com.
 *
 * Uses `gitLsRemote` from `src/git.ts` and `fetchRemotePluginVersion` from
 * `src/remote-fetch.ts` — wraps, does not replace.
 */

import { gitLsRemote } from "../git.js";
import { buildRemoteSourceRef, fetchRemotePluginVersion } from "../remote-fetch.js";
import type { UpstreamProbeOpts, UpstreamProbeResult } from "../types.js";

export async function probeGithub(
  source: { kind: "github"; repo: string; ref?: string },
  opts: UpstreamProbeOpts,
): Promise<UpstreamProbeResult> {
  if (!opts.network) {
    return { status: "no-network", reason: "--no-network" };
  }

  const remoteUrl = `https://github.com/${source.repo}`;

  // Build an AbortController that respects both timeoutMs and caller's signal.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", () => ac.abort(), { once: true });
  }

  try {
    const lsResult = await gitLsRemote(remoteUrl, source.ref);

    if (!lsResult.ok) {
      const reason = lsResult.error;
      if (reason.includes("timed out")) {
        return { status: "unreachable", reason: "github-ls-remote-timeout" };
      }
      return { status: "unreachable", reason };
    }

    // Resolve the target SHA: if a ref was requested, look it up; otherwise use default branch.
    let head: string | undefined;
    if (source.ref) {
      // Try exact ref match first, then refs/heads/<ref>, refs/tags/<ref>.
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

    // Optionally fetch plugin.json version from raw.githubusercontent.com.
    const [owner, ...repoParts] = source.repo.split("/");
    let pluginJsonVersion: string | undefined;
    if (owner && repoParts.length > 0) {
      const repoName = repoParts.join("/");
      const remoteRef = buildRemoteSourceRef({
        remoteUrl: `https://github.com/${source.repo}`,
        ref: head,
        pluginSourcePath: undefined,
      });
      if (remoteRef) {
        const fetchResult = await fetchRemotePluginVersion(remoteRef, {
          timeoutMs: opts.timeoutMs,
        });
        if (fetchResult.ok) {
          pluginJsonVersion = fetchResult.version;
        }
        // Failures degrade silently — pluginJsonVersion stays undefined.
      }
    }

    const result: UpstreamProbeResult = {
      status: "fresh",
      head,
      fetchedAt: new Date().toISOString(),
    };
    if (pluginJsonVersion !== undefined) {
      return { ...result, pluginJsonVersion };
    }
    return result;
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") {
      return { status: "unreachable", reason: "github-fetch-timeout" };
    }
    return { status: "unreachable", reason: err.message };
  } finally {
    clearTimeout(timer);
  }
}
