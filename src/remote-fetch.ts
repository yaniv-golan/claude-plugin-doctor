/**
 * Network-aware fetch of a plugin's `plugin.json#version` from a remote git
 * host. Used by Layer 2 to answer the user-facing question "what version is
 * on github vs what's installed?" — without requiring a `claude plugin
 * marketplace update` to refresh the local clone first.
 *
 * Currently supports raw.githubusercontent.com. Other hosts (gitlab, bitbucket,
 * git-mp) fall back to undefined; expanding host coverage is planned.
 *
 * Network failures (timeout, 404, parse error, rate-limit) all degrade
 * silently to undefined — the caller treats absence of remote info as "couldn't
 * determine" and falls back to local-clone-only diagnosis.
 */

import type { Logger } from "./logger.js";

export type RemoteFetchResult =
  | { ok: true; version: string | undefined; rawBytes: number }
  | { ok: false; reason: string };

/** A parsed remote source descriptor. Built from Layer 1's marketplace info
 *  + the per-plugin marketplace.json entry. */
export type RemoteSourceRef = {
  /** GitHub owner — e.g. "lool-ventures". */
  owner: string;
  /** GitHub repo — e.g. "founder-skills". */
  repo: string;
  /** Commit SHA / ref to fetch at. Caller passes the remote HEAD SHA Layer 1
   *  resolved via `git ls-remote`. */
  ref: string;
  /** Path of the plugin's source directory within the repo, relative to repo
   *  root. Empty string when the whole repo IS the plugin (object-source `url`
   *  with no `path` field). */
  pathInRepo: string;
};

/**
 * Build a `RemoteSourceRef` from a marketplace's git remote URL and a plugin
 * entry's source descriptor. Returns undefined when the marketplace isn't
 * github-hosted (no raw.githubusercontent.com path possible).
 */
export function buildRemoteSourceRef(args: {
  remoteUrl: string;
  ref: string;
  /** Plugin's source path within the marketplace repo. May be undefined (whole
   *  repo IS the plugin), a relative path with leading `./`, or a bare path. */
  pluginSourcePath: string | undefined;
}): RemoteSourceRef | undefined {
  const gh = parseGithubUrl(args.remoteUrl);
  if (!gh) return undefined;
  const raw = args.pluginSourcePath ?? "";
  const pathInRepo = raw.replace(/^\.?\/+/, "").replace(/\/+$/, "");
  return { owner: gh.owner, repo: gh.repo, ref: args.ref, pathInRepo };
}

/** Parse a github.com URL into owner/repo. Accepts:
 *  - https://github.com/<owner>/<repo>
 *  - https://github.com/<owner>/<repo>.git
 *  - git@github.com:<owner>/<repo>.git
 *  Returns undefined for non-github hosts.
 *
 *  GitHub repository names may contain dots (e.g. `node.js`, `socket.io`).
 *  The pre-fix regexes used `[^/.]+` for the repo capture, which silently
 *  rejected those — see audit issue #14. The strategy now is to capture
 *  greedily-but-non-greedy with `(.+?)`, peel an optional trailing `.git`
 *  separately, then validate the captured name (no slashes, not the
 *  reserved `.` or `..`, non-empty after the strip). */
function isValidRepoName(name: string): boolean {
  return name.length > 0 && !name.includes("/") && name !== "." && name !== "..";
}

function stripTrailingGit(name: string): string {
  return name.endsWith(".git") ? name.slice(0, -4) : name;
}

export function parseGithubUrl(url: string): { owner: string; repo: string } | undefined {
  const httpsMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)\/?$/);
  if (httpsMatch?.[1] && httpsMatch[2]) {
    const repo = stripTrailingGit(httpsMatch[2]);
    if (isValidRepoName(repo)) {
      return { owner: httpsMatch[1], repo };
    }
  }
  const sshMatch = url.match(/^git@github\.com:([^/]+)\/(.+?)$/);
  if (sshMatch?.[1] && sshMatch[2]) {
    const repo = stripTrailingGit(sshMatch[2]);
    if (isValidRepoName(repo)) {
      return { owner: sshMatch[1], repo };
    }
  }
  return undefined;
}

/**
 * Fetch the `version` field from a plugin's `plugin.json` at the given remote
 * ref. Uses `raw.githubusercontent.com`. Times out at 5s.
 *
 * Returns `{ ok: true, version }` even when version is undefined (file
 * existed but has no version field). Returns `{ ok: false, reason }` on any
 * network/parse failure — caller treats this as "couldn't determine."
 */
export async function fetchRemotePluginVersion(
  ref: RemoteSourceRef,
  opts: { logger?: Logger; timeoutMs?: number } = {},
): Promise<RemoteFetchResult> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const url = buildRawUrl(ref);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: {
        "User-Agent": "claude-plugin-doctor",
        Accept: "application/json, text/plain, */*",
      },
    });
    if (!res.ok) {
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    const text = await res.text();
    let version: string | undefined;
    try {
      const json = JSON.parse(text) as { version?: unknown };
      if (typeof json.version === "string") version = json.version;
    } catch (e) {
      return { ok: false, reason: `parse error: ${(e as Error).message}` };
    }
    return { ok: true, version, rawBytes: text.length };
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") return { ok: false, reason: `timeout (${timeoutMs}ms)` };
    return { ok: false, reason: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Compose the `raw.githubusercontent.com` URL for a plugin's `plugin.json`. */
export function buildRawUrl(ref: RemoteSourceRef): string {
  const dir = ref.pathInRepo ? `${ref.pathInRepo}/` : "";
  return `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${ref.ref}/${dir}.claude-plugin/plugin.json`;
}
