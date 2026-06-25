import { describe, expect, it } from "vitest";
import { evaluateForceFetchPreconditions } from "../../src/commands/refresh.js";

describe("evaluateForceFetchPreconditions (force-fetch clone gate)", () => {
  it("clone exists and is a git repo → ok, returns cloneDir", () => {
    const g = evaluateForceFetchPreconditions({
      marketplaceName: "cowork-harness",
      cloneDir: "/home/u/.claude/plugins/marketplaces/cowork-harness",
      cloneDirExists: true,
      cloneDirIsGitRepo: true,
    });
    expect(g).toEqual({
      ok: true,
      cloneDir: "/home/u/.claude/plugins/marketplaces/cowork-harness",
    });
  });

  it("regression: clone exists & is git repo but HEAD unresolved → still ok (gate ignores headLocal)", () => {
    const g = evaluateForceFetchPreconditions({
      marketplaceName: "cowork-harness",
      cloneDir: "/c/cowork-harness",
      cloneDirExists: true,
      cloneDirIsGitRepo: true,
    });
    expect(g.ok).toBe(true);
  });

  it("clone dir set but missing on disk → not ok, message names the path", () => {
    const g = evaluateForceFetchPreconditions({
      marketplaceName: "cowork-harness",
      cloneDir: "/c/cowork-harness",
      cloneDirExists: false,
      cloneDirIsGitRepo: false,
    });
    expect(g.ok).toBe(false);
    if (g.ok) throw new Error("unreachable");
    expect(g.code).toBe("E_USAGE");
    expect(g.message).toContain("/c/cowork-harness");
    expect(g.message).toMatch(/no clone found|does not exist/i);
    expect(g.message).not.toMatch(/must be a github\/git source/i);
  });

  it("clone dir exists but not a git repo → not ok, message mentions .git / not a git repo", () => {
    const g = evaluateForceFetchPreconditions({
      marketplaceName: "cowork-harness",
      cloneDir: "/c/cowork-harness",
      cloneDirExists: true,
      cloneDirIsGitRepo: false,
    });
    expect(g.ok).toBe(false);
    if (g.ok) throw new Error("unreachable");
    expect(g.code).toBe("E_USAGE");
    expect(g.message).toMatch(/not a git repo|\.git/i);
  });

  it("clone dir unknown (empty) → not ok", () => {
    const g = evaluateForceFetchPreconditions({
      marketplaceName: "cowork-harness",
      cloneDir: "",
      cloneDirExists: false,
      cloneDirIsGitRepo: false,
    });
    expect(g.ok).toBe(false);
  });
});
