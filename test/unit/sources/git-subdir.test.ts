import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock src/git.ts before importing the adapter.
vi.mock("../../../src/git.js", () => ({
  gitLsRemote: vi.fn(),
}));

import { gitLsRemote } from "../../../src/git.js";
import type { LsRemoteResult } from "../../../src/git.js";
import { probeGitSubdir } from "../../../src/sources/git-subdir.js";
import type { UpstreamProbeOpts } from "../../../src/types.js";

const opts: UpstreamProbeOpts = { network: true, timeoutMs: 5000 };
const mockedLsRemote = vi.mocked(gitLsRemote);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("probeGitSubdir", () => {
  it("returns no-network when opts.network is false", async () => {
    const result = await probeGitSubdir(
      { kind: "git-subdir", url: "https://example.com/repo.git", path: "plugins/foo" },
      { ...opts, network: false },
    );
    expect(result).toEqual({ status: "no-network", reason: "--no-network" });
    expect(mockedLsRemote).not.toHaveBeenCalled();
  });

  it("returns fresh with head on success (delegates to probeGit)", async () => {
    const sha = "a".repeat(40);
    const refs = new Map([["refs/heads/main", sha]]);
    mockedLsRemote.mockResolvedValue({
      ok: true,
      refs,
      defaultBranchSha: sha,
    } satisfies LsRemoteResult);

    const result = await probeGitSubdir(
      { kind: "git-subdir", url: "https://example.com/repo.git", path: "plugins/foo" },
      opts,
    );
    expect(result.status).toBe("fresh");
    if (result.status === "fresh") {
      expect(result.head).toBe(sha);
      // pluginJsonVersion undefined in phase 2 — no subdir raw-content endpoint
      expect(result.pluginJsonVersion).toBeUndefined();
    }
  });

  it("passes the URL (not the subdir path) to git ls-remote", async () => {
    const sha = "b".repeat(40);
    const refs = new Map([["refs/heads/main", sha]]);
    mockedLsRemote.mockResolvedValue({
      ok: true,
      refs,
      defaultBranchSha: sha,
    } satisfies LsRemoteResult);

    await probeGitSubdir(
      { kind: "git-subdir", url: "https://example.com/monorepo.git", path: "packages/my-plugin" },
      opts,
    );

    expect(mockedLsRemote).toHaveBeenCalledWith("https://example.com/monorepo.git", undefined);
  });

  it("returns unreachable when ls-remote fails", async () => {
    mockedLsRemote.mockResolvedValue({
      ok: false,
      error: "network error",
    } satisfies LsRemoteResult);

    const result = await probeGitSubdir(
      { kind: "git-subdir", url: "https://example.com/repo.git", path: "foo" },
      opts,
    );
    expect(result).toEqual({ status: "unreachable", reason: "network error" });
  });
});
