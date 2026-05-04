import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies before importing.
vi.mock("../../../src/git.js", () => ({
  gitLsRemote: vi.fn(),
}));

vi.mock("../../../src/remote-fetch.js", () => ({
  buildRemoteSourceRef: vi.fn(),
  fetchRemotePluginVersion: vi.fn(),
  parseGithubUrl: vi.fn((url: string) => {
    // Real parse logic inline so we test the routing, not a mock of it.
    const https = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?\/?$/);
    if (https?.[1] && https[2]) return { owner: https[1], repo: https[2] };
    const ssh = url.match(/^git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (ssh?.[1] && ssh[2]) return { owner: ssh[1], repo: ssh[2] };
    return undefined;
  }),
}));

import type { LsRemoteResult } from "../../../src/git.js";
import { gitLsRemote } from "../../../src/git.js";
import type { RemoteFetchResult, RemoteSourceRef } from "../../../src/remote-fetch.js";
import { buildRemoteSourceRef, fetchRemotePluginVersion } from "../../../src/remote-fetch.js";
import { probeUrl } from "../../../src/sources/url.js";
import type { UpstreamProbeOpts } from "../../../src/types.js";

const opts: UpstreamProbeOpts = { network: true, timeoutMs: 5000 };
const mockedLsRemote = vi.mocked(gitLsRemote);
const mockedBuildRef = vi.mocked(buildRemoteSourceRef);
const mockedFetch = vi.mocked(fetchRemotePluginVersion);

const FAKE_SHA = "a".repeat(40);
const FAKE_REF: RemoteSourceRef = { owner: "owner", repo: "repo", ref: FAKE_SHA, pathInRepo: "" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("probeUrl", () => {
  it("returns no-network when opts.network is false (github URL)", async () => {
    const result = await probeUrl(
      { kind: "url", url: "https://github.com/owner/repo" },
      { ...opts, network: false },
    );
    expect(result).toEqual({ status: "no-network", reason: "--no-network" });
  });

  it("delegates github https URL to probeGithub and returns fresh", async () => {
    const refs = new Map([["refs/heads/main", FAKE_SHA]]);
    mockedLsRemote.mockResolvedValue({
      ok: true,
      refs,
      defaultBranchSha: FAKE_SHA,
    } satisfies LsRemoteResult);
    mockedBuildRef.mockReturnValue(FAKE_REF);
    mockedFetch.mockResolvedValue({
      ok: true,
      version: "1.0.0",
      rawBytes: 30,
    } satisfies RemoteFetchResult);

    const result = await probeUrl({ kind: "url", url: "https://github.com/owner/repo" }, opts);

    expect(result.status).toBe("fresh");
    if (result.status === "fresh") {
      expect(result.head).toBe(FAKE_SHA);
    }
  });

  it("delegates github SSH URL to probeGithub", async () => {
    const refs = new Map([["refs/heads/main", FAKE_SHA]]);
    mockedLsRemote.mockResolvedValue({
      ok: true,
      refs,
      defaultBranchSha: FAKE_SHA,
    } satisfies LsRemoteResult);
    mockedBuildRef.mockReturnValue(FAKE_REF);
    mockedFetch.mockResolvedValue({ ok: false, reason: "not found" } satisfies RemoteFetchResult);

    const result = await probeUrl({ kind: "url", url: "git@github.com:owner/repo.git" }, opts);

    expect(result.status).toBe("fresh");
  });

  it("returns unknowable for non-github URLs", async () => {
    const result = await probeUrl({ kind: "url", url: "https://gitlab.com/owner/repo" }, opts);
    expect(result).toEqual({ status: "unknowable", reason: "url-not-implemented" });
    expect(mockedLsRemote).not.toHaveBeenCalled();
  });

  it("returns unknowable for arbitrary HTTPS URLs", async () => {
    const result = await probeUrl(
      { kind: "url", url: "https://bitbucket.org/owner/repo.git" },
      opts,
    );
    expect(result).toEqual({ status: "unknowable", reason: "url-not-implemented" });
  });

  it("returns unknowable for non-github URLs even when network is disabled", async () => {
    const result = await probeUrl(
      { kind: "url", url: "https://example.com/archive.zip" },
      { ...opts, network: false },
    );
    expect(result).toEqual({ status: "unknowable", reason: "url-not-implemented" });
  });
});
