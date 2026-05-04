import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock src/git.ts before importing the adapter.
vi.mock("../../../src/git.js", () => ({
  gitLsRemote: vi.fn(),
}));

import { gitLsRemote } from "../../../src/git.js";
import type { LsRemoteResult } from "../../../src/git.js";
import { probeGit } from "../../../src/sources/git.js";
import type { UpstreamProbeOpts } from "../../../src/types.js";

const opts: UpstreamProbeOpts = { network: true, timeoutMs: 5000 };
const mockedLsRemote = vi.mocked(gitLsRemote);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("probeGit", () => {
  it("returns no-network when opts.network is false", async () => {
    const result = await probeGit(
      { kind: "git", url: "https://example.com/repo.git" },
      { ...opts, network: false },
    );
    expect(result).toEqual({ status: "no-network", reason: "--no-network" });
    expect(mockedLsRemote).not.toHaveBeenCalled();
  });

  it("returns fresh with defaultBranchSha as head on success", async () => {
    const sha = "a".repeat(40);
    const refs = new Map([["refs/heads/main", sha]]);
    mockedLsRemote.mockResolvedValue({
      ok: true,
      refs,
      defaultBranchSha: sha,
    } satisfies LsRemoteResult);

    const result = await probeGit({ kind: "git", url: "https://example.com/repo.git" }, opts);
    expect(result.status).toBe("fresh");
    if (result.status === "fresh") {
      expect(result.head).toBe(sha);
      expect(result.pluginJsonVersion).toBeUndefined();
      expect(result.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("resolves named ref when source.ref is specified", async () => {
    const sha = "b".repeat(40);
    const refs = new Map([["refs/heads/dev", sha]]);
    mockedLsRemote.mockResolvedValue({
      ok: true,
      refs,
      defaultBranchSha: sha,
    } satisfies LsRemoteResult);

    const result = await probeGit(
      { kind: "git", url: "https://example.com/repo.git", ref: "dev" },
      opts,
    );
    expect(result.status).toBe("fresh");
    if (result.status === "fresh") {
      expect(result.head).toBe(sha);
    }
  });

  it("returns unreachable when gitLsRemote fails", async () => {
    mockedLsRemote.mockResolvedValue({
      ok: false,
      error: "connection refused",
    } satisfies LsRemoteResult);

    const result = await probeGit({ kind: "git", url: "https://example.com/repo.git" }, opts);
    expect(result).toEqual({ status: "unreachable", reason: "connection refused" });
  });

  it("returns unreachable with git-ls-remote-timeout reason on timeout error", async () => {
    mockedLsRemote.mockResolvedValue({
      ok: false,
      error: "git ls-remote timed out after 8000ms",
    } satisfies LsRemoteResult);

    const result = await probeGit({ kind: "git", url: "https://example.com/repo.git" }, opts);
    expect(result).toEqual({ status: "unreachable", reason: "git-ls-remote-timeout" });
  });

  it("returns unreachable when no default branch sha is resolved", async () => {
    const refs = new Map<string, string>();
    mockedLsRemote.mockResolvedValue({ ok: true, refs } satisfies LsRemoteResult);

    const result = await probeGit({ kind: "git", url: "https://example.com/repo.git" }, opts);
    expect(result).toEqual({ status: "unreachable", reason: "no-default-branch-sha" });
  });

  it("returns unreachable when named ref is not found", async () => {
    const sha = "c".repeat(40);
    const refs = new Map([["refs/heads/main", sha]]);
    mockedLsRemote.mockResolvedValue({
      ok: true,
      refs,
      defaultBranchSha: sha,
    } satisfies LsRemoteResult);

    const result = await probeGit(
      { kind: "git", url: "https://example.com/repo.git", ref: "nonexistent-branch" },
      opts,
    );
    expect(result).toEqual({ status: "unreachable", reason: "ref-not-found: nonexistent-branch" });
  });
});
