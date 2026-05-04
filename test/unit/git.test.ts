import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { gitLogBetween, gitRevParseHead, isGitRepo } from "../../src/git.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, env: GIT_ENV, stdio: "ignore" });
}

function head(cwd: string): string {
  return execSync("git rev-parse HEAD", { cwd, env: GIT_ENV }).toString().trim();
}

describe("git helpers", () => {
  it("isGitRepo returns false for a plain directory", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    expect(isGitRepo(tmp)).toBe(false);
  });

  it("gitRevParseHead returns null for non-git directory", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    expect(gitRevParseHead(tmp)).toBeNull();
  });

  it("gitRevParseHead returns the SHA after a commit", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    git("git init -q", tmp);
    git("git commit -q --allow-empty -m init", tmp);
    const sha = gitRevParseHead(tmp);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("gitLogBetween returns ok:false on a non-git directory", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const r = await gitLogBetween(tmp, "deadbeef", "cafebabe");
    expect(r.ok).toBe(false);
  });

  it("gitLogBetween returns the commits between two SHAs", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    try {
      git("git init -q", tmp);
      git("git commit -q --allow-empty -m base", tmp);
      const baseSha = head(tmp);
      git("git commit -q --allow-empty -m feat:add-skill", tmp);
      git("git commit -q --allow-empty -m docs:update-readme", tmp);
      const tipSha = head(tmp);
      const r = await gitLogBetween(tmp, baseSha, tipSha);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.commits).toHaveLength(2);
      expect(r.commits[0]?.subject).toBe("docs:update-readme"); // newest first
      expect(r.commits[1]?.subject).toBe("feat:add-skill");
      expect(r.truncated).toBe(false);
      // SHAs are abbreviated.
      for (const c of r.commits) expect(c.sha).toMatch(/^[0-9a-f]{7,12}$/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("gitLogBetween scopes to a subdir when provided", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    try {
      git("git init -q", tmp);
      fs.mkdirSync(path.join(tmp, "plugins/foo"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "plugins/bar"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "plugins/foo/x.txt"), "v1");
      fs.writeFileSync(path.join(tmp, "plugins/bar/y.txt"), "v1");
      git("git add .", tmp);
      git("git commit -q -m base", tmp);
      const baseSha = head(tmp);
      // touch only foo
      fs.writeFileSync(path.join(tmp, "plugins/foo/x.txt"), "v2");
      git("git add .", tmp);
      git("git commit -q -m foo-update", tmp);
      // touch only bar
      fs.writeFileSync(path.join(tmp, "plugins/bar/y.txt"), "v2");
      git("git add .", tmp);
      git("git commit -q -m bar-update", tmp);
      const tipSha = head(tmp);
      const fooOnly = await gitLogBetween(tmp, baseSha, tipSha, { subdir: "plugins/foo" });
      expect(fooOnly.ok).toBe(true);
      if (!fooOnly.ok) return;
      expect(fooOnly.commits).toHaveLength(1);
      expect(fooOnly.commits[0]?.subject).toBe("foo-update");
      const both = await gitLogBetween(tmp, baseSha, tipSha);
      expect(both.ok).toBe(true);
      if (!both.ok) return;
      expect(both.commits).toHaveLength(2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("gitLogBetween marks truncated:true when more commits than max exist", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    try {
      git("git init -q", tmp);
      git("git commit -q --allow-empty -m base", tmp);
      const baseSha = head(tmp);
      for (let i = 0; i < 5; i++) git(`git commit -q --allow-empty -m c${i}`, tmp);
      const tipSha = head(tmp);
      const r = await gitLogBetween(tmp, baseSha, tipSha, { max: 2 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.commits).toHaveLength(2);
      expect(r.truncated).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("gitLogBetween returns ok:false on an unknown SHA", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    try {
      git("git init -q", tmp);
      git("git commit -q --allow-empty -m base", tmp);
      const sha = head(tmp);
      const r = await gitLogBetween(tmp, "1234567890abcdef1234567890abcdef12345678", sha);
      expect(r.ok).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
