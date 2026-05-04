import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkInstallSnapshot,
  readPluginSubdir,
  snapshotInstallSnapshot,
} from "../../../src/caches/install-snapshot.js";
import type { InstalledPlugin } from "../../../src/installed-plugins.js";

function writeJson(p: string, data: unknown) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
}

function makeInstalled(opts: {
  pluginName: string;
  marketplace: string;
  version: string;
  installPath: string;
  gitCommitSha?: string;
}): InstalledPlugin {
  return {
    id: `${opts.pluginName}@${opts.marketplace}`,
    pluginName: opts.pluginName,
    marketplace: opts.marketplace,
    scopes: [
      {
        scope: "user",
        version: opts.version,
        installPath: opts.installPath,
        ...(opts.gitCommitSha ? { gitCommitSha: opts.gitCommitSha } : {}),
        raw: {},
      },
    ],
  };
}

describe("checkInstallSnapshot", () => {
  it("returns fresh when installed version matches marketplace entry", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp1");
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), {
      plugins: [{ name: "frontend-design", version: "1.4.2" }],
    });
    const installPath = path.join(tmp, "cache", "mp1", "frontend-design", "1.4.2");
    fs.mkdirSync(installPath, { recursive: true });
    const r = checkInstallSnapshot({
      pluginsRoot: tmp,
      installed: makeInstalled({
        pluginName: "frontend-design",
        marketplace: "mp1",
        version: "1.4.2",
        installPath,
      }),
    });
    expect(r.status).toBe("fresh");
  });

  it("returns stale when installed version is behind marketplace entry", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp1");
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), {
      plugins: [{ name: "proof-engine", version: "0.4.0" }],
    });
    const installPath = path.join(tmp, "cache", "mp1", "proof-engine", "0.3.1");
    fs.mkdirSync(installPath, { recursive: true });
    const r = checkInstallSnapshot({
      pluginsRoot: tmp,
      installed: makeInstalled({
        pluginName: "proof-engine",
        marketplace: "mp1",
        version: "0.3.1",
        installPath,
      }),
    });
    expect(r.status).toBe("stale");
    expect(r.recommendation?.cmd).toBe("claude plugin update proof-engine@mp1");
    expect(r.evidence.marketplaceEntryVersion).toBe("0.4.0");
    expect(r.evidence.resolvedVersion).toBe("0.4.0");
    expect(r.evidence.resolvedVersionSource).toBe("marketplace.json");
    expect(r.evidence.installedVersion).toBe("0.3.1");
  });

  it("returns missing when installPath does not exist", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp1");
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), {
      plugins: [{ name: "p", version: "1.0.0" }],
    });
    const r = checkInstallSnapshot({
      pluginsRoot: tmp,
      installed: makeInstalled({
        pluginName: "p",
        marketplace: "mp1",
        version: "1.0.0",
        installPath: path.join(tmp, "does-not-exist"),
      }),
    });
    expect(r.status).toBe("missing");
  });

  it("returns missing when marketplace.json doesn't list the plugin", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp1");
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), {
      plugins: [{ name: "other", version: "1.0.0" }],
    });
    const installPath = path.join(tmp, "cache", "mp1", "p", "1.0.0");
    fs.mkdirSync(installPath, { recursive: true });
    const r = checkInstallSnapshot({
      pluginsRoot: tmp,
      installed: makeInstalled({
        pluginName: "p",
        marketplace: "mp1",
        version: "1.0.0",
        installPath,
      }),
    });
    expect(r.status).toBe("missing");
    expect(r.detail).toMatch(/not listed/i);
  });

  it("returns unknowable when marketplace.json is absent", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const installPath = path.join(tmp, "cache", "mp1", "p", "1.0.0");
    fs.mkdirSync(installPath, { recursive: true });
    const r = checkInstallSnapshot({
      pluginsRoot: tmp,
      installed: makeInstalled({
        pluginName: "p",
        marketplace: "mp1",
        version: "1.0.0",
        installPath,
      }),
    });
    expect(r.status).toBe("unknowable");
  });

  it("`unknowable` when no plugin.json AND no marketplace.json#version (resolver can't produce cliVersion)", () => {
    // this case fired "version-trap A" with status:stale. v0.3
    // resolver returns undefined (levels 1+2 both fail; levels 3-5 deferred
    // to v0.4) → status:unknowable with a
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp1");
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), {
      plugins: [{ name: "p" }],
    });
    const installPath = path.join(tmp, "cache", "mp1", "p", "0.2.0");
    fs.mkdirSync(installPath, { recursive: true });
    const r = checkInstallSnapshot({
      pluginsRoot: tmp,
      installed: makeInstalled({
        pluginName: "p",
        marketplace: "mp1",
        version: "0.2.0",
        installPath,
        gitCommitSha: "aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1",
      }),
      cloneHeadSha: "bbbbbbb1bbbbbbb1bbbbbbb1bbbbbbb1bbbbbbb1",
      marketplaceCloneStatus: "stale",
    });
    expect(r.status).toBe("unknowable");
    //   copy: "Resolver levels 4-6 ... " → plain language about
    // git-SHA fallback resolution not being implemented yet.
    expect(r.detail).toMatch(/Git-SHA fallback|cannot compare/i);
  });

  it("`unknowable` with clearer message for url-source / git-subdir plugins", () => {
    // claude-plugins-official-style entries: source object with `url` kind.
    // Plugin sources don't live in the marketplace clone → resolver returns
    // undefined → unknowable, but with a more specific cause message.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp1");
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), {
      plugins: [{ name: "p", source: { source: "url", url: "https://example.com/foo.git" } }],
    });
    const installPath = path.join(tmp, "cache", "mp1", "p", "1.0.0");
    fs.mkdirSync(installPath, { recursive: true });
    const r = checkInstallSnapshot({
      pluginsRoot: tmp,
      installed: makeInstalled({
        pluginName: "p",
        marketplace: "mp1",
        version: "1.0.0",
        installPath,
      }),
    });
    expect(r.status).toBe("unknowable");
    expect(r.detail).toMatch(/url.*network fetch/i);
    expect(r.evidence.pluginEntrySourceKind).toBe("url");
  });

  it("`refresh-needed`: matching versions + commit drift + Layer 1 stale", () => {
    // Versions match (cliVersion comes from marketplace.json — there's no
    // plugin.json in the fixture) but commits diverged AND Layer 1 is stale
    // → remote may already carry a bump → refresh-first chain.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp1");
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), {
      plugins: [{ name: "p", version: "1.0.0" }],
    });
    const installPath = path.join(tmp, "cache", "mp1", "p", "1.0.0");
    fs.mkdirSync(installPath, { recursive: true });
    const r = checkInstallSnapshot({
      pluginsRoot: tmp,
      installed: makeInstalled({
        pluginName: "p",
        marketplace: "mp1",
        version: "1.0.0",
        installPath,
        gitCommitSha: "aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1",
      }),
      cloneHeadSha: "bbbbbbb1bbbbbbb1bbbbbbb1bbbbbbb1bbbbbbb1",
      marketplaceCloneStatus: "stale",
    });
    expect(r.status).toBe("stale");
    expect(r.evidence.versionTrapKind).toBe("refresh-needed");
    // Detail uses plain language; the structured `versionTrapKind` evidence
    // remains the stable identifier (machine-readable).
    expect(r.detail).toMatch(/marketplace clone behind remote/i);
    // Recommendation is the simple chain — no bump needed (yet).
    expect(r.recommendation?.cmd).toBe(
      "claude plugin marketplace update mp1 && claude plugin update p@mp1",
    );
  });

  it("`bump-needed`: matching versions + commit drift + Layer 1 fresh", () => {
    // Same drift, but Layer 1 is fresh — remote has no newer commits, so
    // the only way out is to bump plugin.json#version.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp1");
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), {
      plugins: [{ name: "p", version: "1.0.0" }],
    });
    const installPath = path.join(tmp, "cache", "mp1", "p", "1.0.0");
    fs.mkdirSync(installPath, { recursive: true });
    const r = checkInstallSnapshot({
      pluginsRoot: tmp,
      installed: makeInstalled({
        pluginName: "p",
        marketplace: "mp1",
        version: "1.0.0",
        installPath,
        gitCommitSha: "aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1",
      }),
      cloneHeadSha: "bbbbbbb1bbbbbbb1bbbbbbb1bbbbbbb1bbbbbbb1",
      marketplaceCloneStatus: "fresh",
    });
    expect(r.status).toBe("stale");
    expect(r.evidence.versionTrapKind).toBe("bump-needed");
    expect(r.detail).toMatch(/updates blocked|version unchanged/i);
    expect(r.recommendation?.cmd).toMatch(/<bump plugin\.json#version>/);
    expect(r.recommendation?.cmd).toContain("git commit");
    expect(r.recommendation?.cmd).toContain("claude plugin marketplace update mp1");
    expect(r.recommendation?.cmd).toContain("claude plugin update p@mp1");
  });

  it("bump-needed surfaces commitsBetween in evidence and detail when provided", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp1");
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), {
      plugins: [{ name: "p", version: "1.0.0" }],
    });
    const installPath = path.join(tmp, "cache", "mp1", "p", "1.0.0");
    fs.mkdirSync(installPath, { recursive: true });
    const commits = [
      { sha: "bbbbbbb", subject: "feat: add quarterly report skill" },
      { sha: "aaaaaaa", subject: "docs: README touchups" },
    ];
    const r = checkInstallSnapshot({
      pluginsRoot: tmp,
      installed: makeInstalled({
        pluginName: "p",
        marketplace: "mp1",
        version: "1.0.0",
        installPath,
        gitCommitSha: "aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1",
      }),
      cloneHeadSha: "bbbbbbb1bbbbbbb1bbbbbbb1bbbbbbb1bbbbbbb1",
      marketplaceCloneStatus: "fresh",
      commitsBetween: commits,
    });
    expect(r.status).toBe("stale");
    expect(r.evidence.versionTrapKind).toBe("bump-needed");
    expect(r.evidence.commitsBetween).toEqual(commits);
    // Detail includes a header + one row per commit.
    expect(r.detail).toContain("new commits 2 commits");
    expect(r.detail).toContain("feat: add quarterly report skill");
    expect(r.detail).toContain("docs: README touchups");
    expect(r.detail).not.toContain("(+more — passed cap)");
  });

  it("bump-needed shows the truncation marker when commitsBetween is capped", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp1");
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), {
      plugins: [{ name: "p", version: "1.0.0" }],
    });
    const installPath = path.join(tmp, "cache", "mp1", "p", "1.0.0");
    fs.mkdirSync(installPath, { recursive: true });
    const r = checkInstallSnapshot({
      pluginsRoot: tmp,
      installed: makeInstalled({
        pluginName: "p",
        marketplace: "mp1",
        version: "1.0.0",
        installPath,
        gitCommitSha: "aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1",
      }),
      cloneHeadSha: "bbbbbbb1bbbbbbb1bbbbbbb1bbbbbbb1bbbbbbb1",
      marketplaceCloneStatus: "fresh",
      commitsBetween: [{ sha: "abc1234", subject: "x" }],
      commitsBetweenTruncated: true,
    });
    expect(r.detail).toContain("(+more — passed cap)");
    expect(r.evidence.commitsBetweenTruncated).toBe(true);
  });

  it("`unknowable` when commits diverge AND Layer 1 status is unknowable (--no-network)", () => {
    // Without remote knowledge, can't distinguish refresh-needed from bump-needed.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp1");
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), {
      plugins: [{ name: "p", version: "1.0.0" }],
    });
    const installPath = path.join(tmp, "cache", "mp1", "p", "1.0.0");
    fs.mkdirSync(installPath, { recursive: true });
    const r = checkInstallSnapshot({
      pluginsRoot: tmp,
      installed: makeInstalled({
        pluginName: "p",
        marketplace: "mp1",
        version: "1.0.0",
        installPath,
        gitCommitSha: "aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1",
      }),
      cloneHeadSha: "bbbbbbb1bbbbbbb1bbbbbbb1bbbbbbb1bbbbbbb1",
      marketplaceCloneStatus: "unknowable",
    });
    expect(r.status).toBe("unknowable");
    expect(r.detail).toMatch(/--no-network/);
  });

  it("`badge-only-needed` does NOT fire for string-source (impossible by construction)", () => {
    // cpd would fire badge-only-needed when plugin.json#version on
    // disk differed from marketplace.json#plugins[].version. v0.5 corrects:
    // for string-source plugins, BOTH Desktop badge and CLI's update op read
    // the same plugin.json file (it's in the clone). They cannot disagree.
    // Plugin.json says 0.4.1, marketplace.json says 0.2.0, installed 0.4.1 →
    // both surfaces resolve to 0.4.1 (plugin.json wins) → fresh.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp1");
    const pluginSrc = path.join(cloneDir, "p");
    fs.mkdirSync(path.join(pluginSrc, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginSrc, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "p", version: "0.4.1" }),
    );
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), {
      plugins: [{ name: "p", version: "0.2.0", source: "./p" }],
    });
    const installPath = path.join(tmp, "cache", "mp1", "p", "0.4.1");
    fs.mkdirSync(installPath, { recursive: true });
    const r = checkInstallSnapshot({
      pluginsRoot: tmp,
      installed: makeInstalled({
        pluginName: "p",
        marketplace: "mp1",
        version: "0.4.1",
        installPath,
        gitCommitSha: "aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1",
      }),
      cloneHeadSha: "aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1",
      marketplaceCloneStatus: "fresh",
    });
    expect(r.status).toBe("fresh");
    expect(r.evidence.pluginEntrySourceKind).toBe("string");
    expect(r.evidence.resolvedVersion).toBe("0.4.1");
    expect(r.evidence.resolvedVersionSource).toBe("plugin.json-in-clone");
    expect(r.evidence.versionTrapKind).toBeNull();
  });

  it("`badge-only-needed` fires for object-source when remote ≠ marketplace.json#version", () => {
    // For object-source plugins, plugin.json lives outside the marketplace
    // clone. Desktop badge can't see it; the CLI fetches fresh on update.
    // When remote plugin.json#version is ahead of marketplace.json's catalog
    // entry, the CLI updates fine but the badge stays silent → badge-only-needed.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp1");
    fs.mkdirSync(path.join(cloneDir, ".claude-plugin"), { recursive: true });
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), {
      plugins: [
        {
          name: "p",
          version: "0.2.0", // catalog entry says 0.2.0 (badge sees this)
          source: { source: "url", url: "https://example.com/p.git" },
        },
      ],
    });
    const installPath = path.join(tmp, "cache", "mp1", "p", "0.4.1");
    fs.mkdirSync(installPath, { recursive: true });
    const r = checkInstallSnapshot({
      pluginsRoot: tmp,
      installed: makeInstalled({
        pluginName: "p",
        marketplace: "mp1",
        version: "0.4.1",
        installPath,
        gitCommitSha: "aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1",
      }),
      cloneHeadSha: "aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1aaaaaaa1",
      marketplaceCloneStatus: "fresh",
      remoteCliVersion: "0.4.1", // remote plugin.json says 0.4.1
    });
    expect(r.status).toBe("stale");
    expect(r.evidence.pluginEntrySourceKind).toBe("url");
    expect(r.evidence.versionTrapKind).toBe("badge-only-needed");
    expect(r.evidence.remoteCliVersion).toBe("0.4.1");
    expect(r.evidence.marketplaceEntryVersion).toBe("0.2.0");
    expect(r.detail).toMatch(/badge-only-needed/i);
    expect(r.recommendation?.cmd).toBeUndefined();
    expect(r.recommendation?.action).toMatch(/marketplace\.json#plugins\[\]\.version/);
  });

  it("CLI resolver level 2: marketplace.json#version when plugin.json missing", () => {
    // No plugin.json on disk — resolver falls through to marketplace.json
    // entry's version. Source-kind tracking should record this.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp1");
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), {
      // string-source path that doesn't actually exist on disk → no plugin.json
      plugins: [{ name: "p", version: "1.0.0", source: "./does-not-exist" }],
    });
    const installPath = path.join(tmp, "cache", "mp1", "p", "0.9.0");
    fs.mkdirSync(installPath, { recursive: true });
    const r = checkInstallSnapshot({
      pluginsRoot: tmp,
      installed: makeInstalled({
        pluginName: "p",
        marketplace: "mp1",
        version: "0.9.0",
        installPath,
      }),
    });
    expect(r.status).toBe("stale");
    expect(r.evidence.resolvedVersion).toBe("1.0.0");
    expect(r.evidence.resolvedVersionSource).toBe("marketplace.json");
    expect(r.detail).toContain("marketplace.json has 1.0.0");
  });

  it("accepts object-form `source` (claude-plugins-official compat)", () => {
    // Real-world: marketplace.json may use { source: "url" | "git-subdir"
    // | "github", ... } object instead of string. Parser should accept and
    // normalize.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp1");
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), {
      plugins: [
        {
          name: "p",
          version: "2.0.0",
          source: { source: "git-subdir", url: "https://x/y.git", path: "plugins/p" },
        },
      ],
    });
    const installPath = path.join(tmp, "cache", "mp1", "p", "2.0.0");
    fs.mkdirSync(installPath, { recursive: true });
    const r = checkInstallSnapshot({
      pluginsRoot: tmp,
      installed: makeInstalled({
        pluginName: "p",
        marketplace: "mp1",
        version: "2.0.0",
        installPath,
      }),
    });
    // Versions match (cliVersion=2.0.0 from marketplace.json fallback since
    // plugin.json doesn't exist at the resolved path) → fresh.
    expect(r.status).toBe("fresh");
    expect(r.evidence.resolvedVersionSource).toBe("marketplace.json");
  });

  it("plugin.json takes priority over marketplace.json (CLI resolver level 1)", () => {
    // marketplace.json says 0.2.0; plugin.json says 0.4.1. CLI resolver
    // returns 0.4.1 with source=plugin.json. Installed 0.2.0 → mismatch →
    // recommend `claude plugin update`.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp1");
    const pluginSrc = path.join(cloneDir, "p");
    fs.mkdirSync(path.join(pluginSrc, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginSrc, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "p", version: "0.4.1" }),
    );
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), {
      plugins: [{ name: "p", version: "0.2.0", source: "./p" }],
    });
    const installPath = path.join(tmp, "cache", "mp1", "p", "0.2.0");
    fs.mkdirSync(installPath, { recursive: true });
    const r = checkInstallSnapshot({
      pluginsRoot: tmp,
      installed: makeInstalled({
        pluginName: "p",
        marketplace: "mp1",
        version: "0.2.0",
        installPath,
      }),
    });
    expect(r.status).toBe("stale");
    expect(r.evidence.resolvedVersion).toBe("0.4.1");
    expect(r.evidence.resolvedVersionSource).toBe("plugin.json-in-clone");
    expect(r.detail).toContain("plugin.json has 0.4.1");
    expect(r.detail).toContain("you have 0.2.0");
    expect(r.recommendation?.cmd).toBe("claude plugin update p@mp1");
  });

  it("no version-trap when commits match (everything fresh)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp1");
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), {
      plugins: [{ name: "p", version: "1.0.0" }],
    });
    const installPath = path.join(tmp, "cache", "mp1", "p", "1.0.0");
    fs.mkdirSync(installPath, { recursive: true });
    const r = checkInstallSnapshot({
      pluginsRoot: tmp,
      installed: makeInstalled({
        pluginName: "p",
        marketplace: "mp1",
        version: "1.0.0",
        installPath,
        gitCommitSha: "ccccccc1ccccccc1ccccccc1ccccccc1ccccccc1",
      }),
      cloneHeadSha: "ccccccc1ccccccc1ccccccc1ccccccc1ccccccc1",
    });
    expect(r.status).toBe("fresh");
  });

  it("source-drift: directory source differs from cache install", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    // Marketplace source root with one plugin under /plugins/p
    const mpRoot = path.join(tmp, "src");
    const sourcePluginDir = path.join(mpRoot, "plugins", "p");
    fs.mkdirSync(sourcePluginDir, { recursive: true });
    fs.writeFileSync(path.join(sourcePluginDir, "plugin.json"), '{"name":"p","version":"1.0.0"}');
    fs.writeFileSync(path.join(sourcePluginDir, "skill.md"), "# updated content");

    // marketplace.json with explicit `source` field pointing into the source root
    const cloneDir = path.join(tmp, "marketplaces", "mp1");
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), {
      plugins: [{ name: "p", version: "1.0.0", source: "./plugins/p" }],
    });

    // Cache install with stale content
    const installPath = path.join(tmp, "cache", "mp1", "p", "1.0.0");
    fs.mkdirSync(installPath, { recursive: true });
    fs.writeFileSync(path.join(installPath, "plugin.json"), '{"name":"p","version":"1.0.0"}');
    fs.writeFileSync(path.join(installPath, "skill.md"), "# original content");

    const r = checkInstallSnapshot({
      pluginsRoot: tmp,
      installed: makeInstalled({
        pluginName: "p",
        marketplace: "mp1",
        version: "1.0.0",
        installPath,
      }),
      marketplaceSourceType: "directory",
      marketplaceSourceRoot: mpRoot,
    });
    expect(r.status).toBe("stale");
    expect(r.detail).toMatch(/source drift/i);
    expect(r.recommendation?.cmd).toBe("claude plugin update p@mp1");
  });

  it("source-drift: skipped when source path can't be resolved (no false positive)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const mpRoot = path.join(tmp, "src");
    fs.mkdirSync(mpRoot);
    // marketplace.json with no `source`/`path` field, no conventional dir
    const cloneDir = path.join(tmp, "marketplaces", "mp1");
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), {
      plugins: [{ name: "p", version: "1.0.0" }],
    });
    const installPath = path.join(tmp, "cache", "mp1", "p", "1.0.0");
    fs.mkdirSync(installPath, { recursive: true });
    const r = checkInstallSnapshot({
      pluginsRoot: tmp,
      installed: makeInstalled({
        pluginName: "p",
        marketplace: "mp1",
        version: "1.0.0",
        installPath,
      }),
      marketplaceSourceType: "directory",
      marketplaceSourceRoot: mpRoot,
    });
    expect(r.status).toBe("fresh");
  });

  it("no version-trap when cloneHeadSha is unknown (graceful degradation)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp1");
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), {
      plugins: [{ name: "p", version: "1.0.0" }],
    });
    const installPath = path.join(tmp, "cache", "mp1", "p", "1.0.0");
    fs.mkdirSync(installPath, { recursive: true });
    const r = checkInstallSnapshot({
      pluginsRoot: tmp,
      installed: makeInstalled({
        pluginName: "p",
        marketplace: "mp1",
        version: "1.0.0",
        installPath,
        gitCommitSha: "ccccccc1ccccccc1ccccccc1ccccccc1ccccccc1",
      }),
      // cloneHeadSha intentionally absent
    });
    expect(r.status).toBe("fresh");
  });
});

// ── v1.0 snapshotInstallSnapshot ──────────────────────────────────────────────

describe("snapshotInstallSnapshot", () => {
  it("presence:present when install path exists", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const installPath = path.join(tmp, "cache", "mp1", "myplugin", "1.0.0");
    fs.mkdirSync(installPath, { recursive: true });
    writeJson(path.join(tmp, "marketplaces", "mp1", ".claude-plugin", "marketplace.json"), {
      plugins: [{ name: "myplugin", version: "1.0.0", source: "./myplugin" }],
    });
    const snap = snapshotInstallSnapshot({
      installed: makeInstalled({
        pluginName: "myplugin",
        marketplace: "mp1",
        version: "1.0.0",
        installPath,
      }),
      rootRef: { kind: "ccd" },
      pluginsRoot: tmp,
    });
    expect(snap.layer).toBe("install_snapshot");
    expect(snap.presence).toBe("present");
    expect(snap.data.kind).toBe("install_snapshot");
    expect(snap.data.installPathExists).toBe(true);
    expect(snap.data.pluginEntrySourceKind).toBe("string");
    expect(snap.subject).toMatchObject({ kind: "plugin" });
  });

  it("presence:absent when install path does not exist", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const installPath = path.join(tmp, "cache", "mp1", "myplugin", "1.0.0");
    // Do NOT create installPath
    const snap = snapshotInstallSnapshot({
      installed: makeInstalled({
        pluginName: "myplugin",
        marketplace: "mp1",
        version: "1.0.0",
        installPath,
      }),
      rootRef: { kind: "ccd" },
    });
    expect(snap.presence).toBe("absent");
    expect(snap.data.installPathExists).toBe(false);
  });

  it("pluginEntrySourceKind:github for object-source github plugin", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const installPath = path.join(tmp, "cache", "mp1", "myplugin", "1.0.0");
    fs.mkdirSync(installPath, { recursive: true });
    writeJson(path.join(tmp, "marketplaces", "mp1", ".claude-plugin", "marketplace.json"), {
      plugins: [
        {
          name: "myplugin",
          version: "1.0.0",
          source: { source: "github", repo: "org/myplugin" },
        },
      ],
    });
    const snap = snapshotInstallSnapshot({
      installed: makeInstalled({
        pluginName: "myplugin",
        marketplace: "mp1",
        version: "1.0.0",
        installPath,
      }),
      rootRef: { kind: "ccd" },
      pluginsRoot: tmp,
    });
    expect(snap.data.pluginEntrySourceKind).toBe("github");
  });

  it("pluginEntrySourceKind:clone-unreadable when pluginsRoot is absent", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const installPath = path.join(tmp, "cache", "mp1", "myplugin", "1.0.0");
    fs.mkdirSync(installPath, { recursive: true });
    const snap = snapshotInstallSnapshot({
      installed: makeInstalled({
        pluginName: "myplugin",
        marketplace: "mp1",
        version: "1.0.0",
        installPath,
      }),
      rootRef: { kind: "ccd" },
      // pluginsRoot intentionally absent
    });
    expect(snap.data.pluginEntrySourceKind).toBe("clone-unreadable");
  });

  it("scopes are carried through from InstalledPlugin", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const installPath = path.join(tmp, "cache", "mp1", "myplugin", "1.0.0");
    fs.mkdirSync(installPath, { recursive: true });
    const snap = snapshotInstallSnapshot({
      installed: makeInstalled({
        pluginName: "myplugin",
        marketplace: "mp1",
        version: "1.0.0",
        installPath,
      }),
      rootRef: { kind: "ccd" },
    });
    expect(snap.data.scopes).toHaveLength(1);
    expect(snap.data.scopes[0]?.scope).toBe("user");
    expect(snap.data.scopes[0]?.version).toBe("1.0.0");
  });

  it("rootRef is preserved in snapshot and subject", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const installPath = path.join(tmp, "cache", "mp1", "myplugin", "1.0.0");
    fs.mkdirSync(installPath, { recursive: true });
    const rootRef = { kind: "cowork" as const, accountId: "acc1", orgId: "org1" };
    const snap = snapshotInstallSnapshot({
      installed: makeInstalled({
        pluginName: "myplugin",
        marketplace: "mp1",
        version: "1.0.0",
        installPath,
      }),
      rootRef,
    });
    expect(snap.rootRef).toMatchObject(rootRef);
    if (snap.subject.kind === "plugin") {
      expect(snap.subject.ref.root).toMatchObject(rootRef);
    }
  });
});

describe("readPluginSubdir", () => {
  it("returns the recorded `source` path for a string-source plugin", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp");
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), {
      plugins: [{ name: "foo", source: "plugins/foo" }],
    });
    expect(readPluginSubdir(tmp, "mp", "foo")).toBe("plugins/foo");
  });

  it("falls back to legacy `path` field", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp");
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), {
      plugins: [{ name: "foo", path: "legacy/foo" }],
    });
    expect(readPluginSubdir(tmp, "mp", "foo")).toBe("legacy/foo");
  });

  it("falls back to conventional <pluginName>/ when neither source nor path is set, and the dir exists", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp");
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), {
      plugins: [{ name: "bar" }],
    });
    fs.mkdirSync(path.join(cloneDir, "bar"), { recursive: true });
    expect(readPluginSubdir(tmp, "mp", "bar")).toBe("bar");
  });

  it("returns undefined for an object-source plugin", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp");
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), {
      plugins: [{ name: "foo", source: { source: "github", repo: "x/y" } }],
    });
    expect(readPluginSubdir(tmp, "mp", "foo")).toBeUndefined();
  });

  it("returns undefined when the marketplace clone is missing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    expect(readPluginSubdir(tmp, "missing-mp", "foo")).toBeUndefined();
  });

  it("returns undefined when the plugin is not in marketplace.json", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const cloneDir = path.join(tmp, "marketplaces", "mp");
    writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), {
      plugins: [{ name: "foo", source: "plugins/foo" }],
    });
    expect(readPluginSubdir(tmp, "mp", "not-a-plugin")).toBeUndefined();
  });
});
