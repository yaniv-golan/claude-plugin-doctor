import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export function isGitRepo(dir: string): boolean {
  try {
    const s = fs.statSync(path.join(dir, ".git"));
    return s.isDirectory() || s.isFile();
  } catch {
    return false;
  }
}

// Local, fast, no event-loop concern → keep synchronous.
export function gitRevParseHead(dir: string): string | null {
  if (!isGitRepo(dir)) return null;
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 5_000,
  });
  if (r.status !== 0) return null;
  const out = r.stdout.trim();
  if (!/^[0-9a-f]{7,64}$/.test(out)) return null;
  return out;
}

export type LsRemoteResult =
  | { ok: true; refs: Map<string, string>; defaultBranchSha?: string }
  | { ok: false; error: string };

const LS_REMOTE_TIMEOUT_MS = 8_000;

// Network-bound — async so the event loop stays free for the spinner timer
// and so we can run multiple lookups in parallel.
export function gitLsRemote(remoteUrl: string, branch?: string): Promise<LsRemoteResult> {
  return new Promise((resolve) => {
    const args = ["ls-remote", remoteUrl];
    if (branch) args.push(branch);

    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });

    const settle = (result: LsRemoteResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      settle({ ok: false, error: `git ls-remote timed out after ${LS_REMOTE_TIMEOUT_MS}ms` });
    }, LS_REMOTE_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      settle({ ok: false, error: err.message });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        settle({
          ok: false,
          error: (stderr || stdout || `git ls-remote exit ${code}`).trim(),
        });
        return;
      }
      const refs = new Map<string, string>();
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const m = trimmed.match(/^([0-9a-f]{40})\s+(.+)$/);
        if (m?.[1] && m[2]) refs.set(m[2], m[1]);
      }
      // Heuristic default-branch resolution: HEAD → refs/heads/main → refs/heads/master.
      const headSym = refs.get("HEAD");
      const main = refs.get("refs/heads/main");
      const master = refs.get("refs/heads/master");
      const defaultBranchSha = headSym ?? main ?? master;
      settle(defaultBranchSha ? { ok: true, refs, defaultBranchSha } : { ok: true, refs });
    });
  });
}

// ── Local commit-range inspection ───────────────────────────────────────────
//
// Used by the install-snapshot diagnostic to surface the commits between a
// user's installed snapshot SHA and the local clone's HEAD, scoped to a
// single plugin's subdir. Pure-local: no network, no `git fetch`. Bounded
// by a short timeout because everything runs against an existing on-disk
// repo and oneline output is small.

export type GitLogCommit = { sha: string; subject: string };
export type GitLogBetweenResult =
  | { ok: true; commits: GitLogCommit[]; truncated: boolean }
  | { ok: false; error: string };

const GIT_LOG_TIMEOUT_MS = 5_000;

export type GitLogBetweenOpts = {
  /** Caller-controllable cap. The renderer uses 10. */
  max?: number;
  /** Restrict log to commits that touched this path (relative to dir). When
   *  omitted, scope is the whole repo. */
  subdir?: string;
};

/** `git log --oneline -n max+1 <from>..<to> -- [subdir]` against the local
 *  clone. Returns up to `max` commits; `truncated=true` indicates that more
 *  commits than `max` exist in the range (we ask for `max+1` to detect this). */
export function gitLogBetween(
  dir: string,
  fromSha: string,
  toSha: string,
  opts: GitLogBetweenOpts = {},
): Promise<GitLogBetweenResult> {
  return new Promise((resolve) => {
    const max = Math.max(1, opts.max ?? 10);
    if (!isGitRepo(dir)) {
      resolve({ ok: false, error: "not a git repo" });
      return;
    }
    // %h = abbrev sha, %s = subject. Use a TAB delimiter for safe parsing
    // (subjects may contain any other ASCII char including spaces/colons).
    const args = [
      "-C",
      dir,
      "log",
      `--max-count=${max + 1}`,
      "--pretty=format:%h%x09%s",
      `${fromSha}..${toSha}`,
    ];
    if (opts.subdir !== undefined) {
      args.push("--", opts.subdir);
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });

    const settle = (result: GitLogBetweenResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      settle({ ok: false, error: `git log timed out after ${GIT_LOG_TIMEOUT_MS}ms` });
    }, GIT_LOG_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      settle({ ok: false, error: err.message });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        settle({
          ok: false,
          error: (stderr || stdout || `git log exit ${code}`).trim(),
        });
        return;
      }
      const lines = stdout.split("\n").filter((l) => l.length > 0);
      const truncated = lines.length > max;
      const kept = truncated ? lines.slice(0, max) : lines;
      const commits: GitLogCommit[] = [];
      for (const line of kept) {
        const tab = line.indexOf("\t");
        if (tab < 0) continue;
        const sha = line.slice(0, tab);
        const subject = line.slice(tab + 1);
        if (sha && subject) commits.push({ sha, subject });
      }
      settle({ ok: true, commits, truncated });
    });
  });
}
