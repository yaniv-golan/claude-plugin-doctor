import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock both dependencies before importing the adapter.
vi.mock("../../../src/git.js", () => ({
  gitLsRemote: vi.fn(),
}));

vi.mock("../../../src/remote-fetch.js", () => ({
  buildRemoteSourceRef: vi.fn(),
  fetchRemotePluginVersion: vi.fn(),
  parseGithubUrl: vi.fn(),
}));

import { gitLsRemote } from "../../../src/git.js";
import type { LsRemoteResult } from "../../../src/git.js";
import { buildRemoteSourceRef, fetchRemotePluginVersion } from "../../../src/remote-fetch.js";
import type { RemoteFetchResult, RemoteSourceRef } from "../../../src/remote-fetch.js";
import { probeGithub } from "../../../src/sources/github.js";
import type { UpstreamProbeOpts } from "../../../src/types.js";

const opts: UpstreamProbeOpts = { network: true, timeoutMs: 5000 };
const mockedLsRemote = vi.mocked(gitLsRemote);
const mockedBuildRef = vi.mocked(buildRemoteSourceRef);
const mockedFetch = vi.mocked(fetchRemotePluginVersion);

const FAKE_SHA = "a".repeat(40);
const FAKE_REF: RemoteSourceRef = {
  owner: "owner",
  repo: "repo",
  ref: FAKE_SHA,
  pathInRepo: "",
};

beforeEach(() => {
  vi.clearAllMocks();
});

function makeRefs(sha: string) {
  return new Map([
    ["HEAD", sha],
    ["refs/heads/main", sha],
  ]);
}

describe("probeGithub", () => {
  it("returns no-network when opts.network is false", async () => {
    const result = await probeGithub(
      { kind: "github", repo: "owner/repo" },
      { ...opts, network: false },
    );
    expect(result).toEqual({ status: "no-network", reason: "--no-network" });
    expect(mockedLsRemote).not.toHaveBeenCalled();
  });

  it("returns fresh with head and pluginJsonVersion on full success", async () => {
    mockedLsRemote.mockResolvedValue({
      ok: true,
      refs: makeRefs(FAKE_SHA),
      defaultBranchSha: FAKE_SHA,
    } satisfies LsRemoteResult);
    mockedBuildRef.mockReturnValue(FAKE_REF);
    mockedFetch.mockResolvedValue({
      ok: true,
      version: "1.2.3",
      rawBytes: 50,
    } satisfies RemoteFetchResult);

    const result = await probeGithub({ kind: "github", repo: "owner/repo" }, opts);

    expect(result.status).toBe("fresh");
    if (result.status === "fresh") {
      expect(result.head).toBe(FAKE_SHA);
      expect(result.pluginJsonVersion).toBe("1.2.3");
      expect(result.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("returns fresh without pluginJsonVersion when remote fetch fails", async () => {
    mockedLsRemote.mockResolvedValue({
      ok: true,
      refs: makeRefs(FAKE_SHA),
      defaultBranchSha: FAKE_SHA,
    } satisfies LsRemoteResult);
    mockedBuildRef.mockReturnValue(FAKE_REF);
    mockedFetch.mockResolvedValue({ ok: false, reason: "HTTP 404" } satisfies RemoteFetchResult);

    const result = await probeGithub({ kind: "github", repo: "owner/repo" }, opts);

    expect(result.status).toBe("fresh");
    if (result.status === "fresh") {
      expect(result.head).toBe(FAKE_SHA);
      expect(result.pluginJsonVersion).toBeUndefined();
    }
  });

  it("returns fresh without pluginJsonVersion when version is undefined in plugin.json", async () => {
    mockedLsRemote.mockResolvedValue({
      ok: true,
      refs: makeRefs(FAKE_SHA),
      defaultBranchSha: FAKE_SHA,
    } satisfies LsRemoteResult);
    mockedBuildRef.mockReturnValue(FAKE_REF);
    mockedFetch.mockResolvedValue({
      ok: true,
      version: undefined,
      rawBytes: 30,
    } satisfies RemoteFetchResult);

    const result = await probeGithub({ kind: "github", repo: "owner/repo" }, opts);

    expect(result.status).toBe("fresh");
    if (result.status === "fresh") {
      expect(result.pluginJsonVersion).toBeUndefined();
    }
  });

  it("returns unreachable when gitLsRemote fails with network error", async () => {
    mockedLsRemote.mockResolvedValue({
      ok: false,
      error: "ssh: connect failed",
    } satisfies LsRemoteResult);

    const result = await probeGithub({ kind: "github", repo: "owner/repo" }, opts);
    expect(result).toEqual({ status: "unreachable", reason: "ssh: connect failed" });
  });

  it("returns unreachable with github-ls-remote-timeout reason on timeout", async () => {
    mockedLsRemote.mockResolvedValue({
      ok: false,
      error: "git ls-remote timed out after 8000ms",
    } satisfies LsRemoteResult);

    const result = await probeGithub({ kind: "github", repo: "owner/repo" }, opts);
    expect(result).toEqual({ status: "unreachable", reason: "github-ls-remote-timeout" });
  });

  it("returns unreachable when no default branch SHA is resolved", async () => {
    mockedLsRemote.mockResolvedValue({ ok: true, refs: new Map() } satisfies LsRemoteResult);

    const result = await probeGithub({ kind: "github", repo: "owner/repo" }, opts);
    expect(result).toEqual({ status: "unreachable", reason: "no-default-branch-sha" });
  });

  it("resolves a named ref from the refs map", async () => {
    const sha = "b".repeat(40);
    const refs = new Map([
      ["refs/heads/main", FAKE_SHA],
      ["refs/heads/feature-x", sha],
    ]);
    mockedLsRemote.mockResolvedValue({
      ok: true,
      refs,
      defaultBranchSha: FAKE_SHA,
    } satisfies LsRemoteResult);
    mockedBuildRef.mockReturnValue(FAKE_REF);
    mockedFetch.mockResolvedValue({ ok: false, reason: "irrelevant" } satisfies RemoteFetchResult);

    const result = await probeGithub(
      { kind: "github", repo: "owner/repo", ref: "feature-x" },
      opts,
    );

    expect(result.status).toBe("fresh");
    if (result.status === "fresh") {
      expect(result.head).toBe(sha);
    }
  });

  it("returns unreachable when named ref is not found in refs map", async () => {
    const refs = new Map([["refs/heads/main", FAKE_SHA]]);
    mockedLsRemote.mockResolvedValue({
      ok: true,
      refs,
      defaultBranchSha: FAKE_SHA,
    } satisfies LsRemoteResult);

    const result = await probeGithub(
      { kind: "github", repo: "owner/repo", ref: "nonexistent" },
      opts,
    );
    expect(result).toEqual({ status: "unreachable", reason: "ref-not-found: nonexistent" });
  });
});
