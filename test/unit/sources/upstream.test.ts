import { describe, expect, it } from "vitest";
import { probeUpstream } from "../../../src/sources/upstream.js";
import type { UpstreamProbeOpts, UpstreamSource } from "../../../src/types.js";

/**
 * Upstream dispatcher tests focus on:
 * 1. --no-network short-circuits before any adapter is called for network-bound kinds.
 * 2. I/O-free kinds (backend, npm) run regardless of the network flag.
 * 3. Each `kind` routes to the right adapter (verified via the returned status shape).
 *
 * Network-bound adapters are tested with --no-network so no real I/O occurs.
 */

const BASE_OPTS: UpstreamProbeOpts = { network: true, timeoutMs: 5000 };
const NO_NET: UpstreamProbeOpts = { ...BASE_OPTS, network: false };

describe("probeUpstream dispatcher", () => {
  // ── no-network short-circuit ─────────────────────────────────────────────

  it("github: returns no-network when network=false", async () => {
    const source: UpstreamSource = { kind: "github", repo: "owner/repo" };
    const result = await probeUpstream(source, NO_NET);
    expect(result).toEqual({ status: "no-network", reason: "--no-network" });
  });

  it("git: returns no-network when network=false", async () => {
    const source: UpstreamSource = { kind: "git", url: "https://example.com/repo.git" };
    const result = await probeUpstream(source, NO_NET);
    expect(result).toEqual({ status: "no-network", reason: "--no-network" });
  });

  it("git-subdir: returns no-network when network=false", async () => {
    const source: UpstreamSource = {
      kind: "git-subdir",
      url: "https://example.com/repo.git",
      path: "plugins/foo",
    };
    const result = await probeUpstream(source, NO_NET);
    expect(result).toEqual({ status: "no-network", reason: "--no-network" });
  });

  it("url: returns no-network when network=false and URL is github", async () => {
    const source: UpstreamSource = { kind: "url", url: "https://github.com/owner/repo" };
    const result = await probeUpstream(source, NO_NET);
    expect(result).toEqual({ status: "no-network", reason: "--no-network" });
  });

  // ── always-unknowable adapters ──────────────────────────────────────────

  it("backend: returns unknowable regardless of network flag", async () => {
    const source: UpstreamSource = { kind: "backend" };
    expect(await probeUpstream(source, BASE_OPTS)).toEqual({
      status: "unknowable",
      reason: "backend",
    });
    expect(await probeUpstream(source, NO_NET)).toEqual({
      status: "unknowable",
      reason: "backend",
    });
  });

  it("npm: returns unknowable regardless of network flag", async () => {
    const source: UpstreamSource = { kind: "npm", package: "my-pkg" };
    expect(await probeUpstream(source, BASE_OPTS)).toEqual({
      status: "unknowable",
      reason: "npm-not-implemented",
    });
    expect(await probeUpstream(source, NO_NET)).toEqual({
      status: "unknowable",
      reason: "npm-not-implemented",
    });
  });

  // ── local-I/O adapters ───────────────────────────────────────────────────

  it("directory: returns unreachable for a missing path (no I/O gating on network flag)", async () => {
    const source: UpstreamSource = {
      kind: "directory",
      path: "/nonexistent/path/that/does/not/exist",
    };
    const result = await probeUpstream(source, NO_NET);
    expect(result).toEqual({ status: "unreachable", reason: "directory-not-found" });
  });

  it("string: treats string kind as directory probe (missing path → unreachable)", async () => {
    const source: UpstreamSource = { kind: "string", path: "/nonexistent/string-path" };
    const result = await probeUpstream(source, NO_NET);
    expect(result).toEqual({ status: "unreachable", reason: "directory-not-found" });
  });

  it("unsupported: returns unknowable with url-not-implemented", async () => {
    const source: UpstreamSource = { kind: "unrecognized", raw: { source: "ftp" } };
    const result = await probeUpstream(source, BASE_OPTS);
    expect(result).toEqual({ status: "unknowable", reason: "url-not-implemented" });
  });

  // ── non-github URL → unknowable (no network needed) ─────────────────────

  it("url: non-github URL returns unknowable even with network=true", async () => {
    const source: UpstreamSource = { kind: "url", url: "https://bitbucket.org/owner/repo" };
    const result = await probeUpstream(source, BASE_OPTS);
    expect(result).toEqual({ status: "unknowable", reason: "url-not-implemented" });
  });
});
