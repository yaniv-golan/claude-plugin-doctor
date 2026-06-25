import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runRefresh } from "../../src/commands/refresh.js";

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  tmp.length = 0;
  vi.restoreAllMocks();
});

function gitInit(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  execSync("git init -q && git commit -q --allow-empty -m init", {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

describe("runRefresh --force-fetch clone gate (reporter regression)", () => {
  it("attempts force-fetch when clone exists & is a git repo even though headLocal is unresolved", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-ff-"));
    tmp.push(home);
    const pluginsRoot = path.join(home, ".claude", "plugins");
    const mp = "cowork-harness";
    const cloneDir = path.join(pluginsRoot, "marketplaces", mp);

    // Real git clone on disk, but intentionally NO .claude-plugin/marketplace.json
    // → checkMarketplaceClone returns early and never populates evidence.headLocal.
    gitInit(cloneDir);
    fs.mkdirSync(pluginsRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginsRoot, "known_marketplaces.json"),
      JSON.stringify({
        [mp]: {
          source: { source: "github", repo: "yaniv-golan/cowork-harness" },
          installLocation: cloneDir,
          lastUpdated: "2026-06-25T04:17:19.638Z",
        },
      }),
    );

    const gitCalls: string[][] = [];
    const gitRunner = vi.fn(async (gitArgs: string[]) => {
      gitCalls.push(gitArgs);
      if (gitArgs[0] === "symbolic-ref") {
        return { ok: true, exitCode: 0, stdout: "origin/main\n", stderr: "" };
      }
      return { ok: true, exitCode: 0, stdout: "", stderr: "" };
    });

    const report = await runRefresh({
      home,
      platform: "darwin",
      env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(home, ".claude") },
      mode: "ccd",
      noNetwork: true,
      marketplaceName: mp,
      forceFetch: true,
      gitRunner,
      claudeRunner: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "" }),
    });

    // OLD code threw E_USAGE here. Now force-fetch is attempted AND succeeds.
    // (Do NOT assert report.refreshMethod — refresh.ts:340 sets it whenever
    // opts.forceFetch is truthy regardless of success, so it proves nothing.)
    expect(gitCalls.some((c) => c[0] === "fetch")).toBe(true);
    expect(gitCalls.some((c) => c[0] === "reset")).toBe(true);
    expect(report.claudeUpdate.ok).toBe(true);
  });

  it("refuses with a path-specific message when the clone dir is absent", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-ff-"));
    tmp.push(home);
    const pluginsRoot = path.join(home, ".claude", "plugins");
    const mp = "cowork-harness";
    fs.mkdirSync(pluginsRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginsRoot, "known_marketplaces.json"),
      JSON.stringify({
        [mp]: { source: { source: "github", repo: "yaniv-golan/cowork-harness" } },
      }),
    );

    await expect(
      runRefresh({
        home,
        platform: "darwin",
        env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(home, ".claude") },
        mode: "ccd",
        noNetwork: true,
        marketplaceName: mp,
        forceFetch: true,
        gitRunner: vi.fn(),
        claudeRunner: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).rejects.toThrow(/no clone found|does not exist/i);
  });
});
