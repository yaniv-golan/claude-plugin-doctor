import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverCoworkRoots } from "../../../src/discovery/cowork-roots.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cowork-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Context pointing at tmp as HOME (darwin). */
function ctx() {
  return { platform: "darwin" as NodeJS.Platform, home: tmp };
}

/** Returns <userData>/local-agent-mode-sessions path. */
function sessionsDir() {
  return path.join(tmp, "Library", "Application Support", "Claude", "local-agent-mode-sessions");
}

/** Creates <sessionsDir>/<accountId>/<orgId> directory. */
function makeOrgDir(accountId: string, orgId: string): string {
  const dir = path.join(sessionsDir(), accountId, orgId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("discoverCoworkRoots", () => {
  it("returns [] on non-darwin platform", () => {
    expect(discoverCoworkRoots({ platform: "linux", home: tmp })).toEqual([]);
  });

  it("returns [] when local-agent-mode-sessions does not exist", () => {
    // No userData dir created.
    expect(discoverCoworkRoots(ctx())).toEqual([]);
  });

  it("returns [] when sessions dir is empty", () => {
    fs.mkdirSync(sessionsDir(), { recursive: true });
    expect(discoverCoworkRoots(ctx())).toEqual([]);
  });

  it("skips the skills-plugin directory", () => {
    fs.mkdirSync(path.join(sessionsDir(), "skills-plugin", "org1", "acc1"), { recursive: true });
    expect(discoverCoworkRoots(ctx())).toEqual([]);
  });

  it("returns one CoworkRoot for a single (accountId, orgId) pair", () => {
    makeOrgDir("acc1", "org1");
    const roots = discoverCoworkRoots(ctx());
    expect(roots).toHaveLength(1);
    const root = roots[0];
    expect(root?.accountId).toBe("acc1");
    expect(root?.orgId).toBe("org1");
    expect(root?.hasCoworkPlugins).toBe(false);
    expect(root?.hasRpm).toBe(false);
    expect(root?.marketplaces).toEqual([]);
    expect(root?.installedPluginsMtime).toBeUndefined();
    expect(root?.isMostRecent).toBe(false);
  });

  it("sets hasCoworkPlugins and hasRpm when the directories exist", () => {
    const orgDir = makeOrgDir("acc1", "org1");
    fs.mkdirSync(path.join(orgDir, "cowork_plugins"), { recursive: true });
    fs.mkdirSync(path.join(orgDir, "rpm"), { recursive: true });

    const roots = discoverCoworkRoots(ctx());
    expect(roots[0]?.hasCoworkPlugins).toBe(true);
    expect(roots[0]?.hasRpm).toBe(true);
  });

  it("populates knownMarketplacesPath, installedPluginsPath when files exist", () => {
    const orgDir = makeOrgDir("acc1", "org1");
    const coworkPluginsDir = path.join(orgDir, "cowork_plugins");
    fs.mkdirSync(coworkPluginsDir, { recursive: true });
    fs.writeFileSync(path.join(coworkPluginsDir, "known_marketplaces.json"), JSON.stringify({}));
    fs.writeFileSync(
      path.join(coworkPluginsDir, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: {} }),
    );

    const roots = discoverCoworkRoots(ctx());
    const root = roots[0];
    expect(root?.knownMarketplacesPath).toBe(
      path.join(coworkPluginsDir, "known_marketplaces.json"),
    );
    expect(root?.installedPluginsPath).toBe(path.join(coworkPluginsDir, "installed_plugins.json"));
  });

  it("populates rpmManifestPath when rpm/manifest.json exists", () => {
    const orgDir = makeOrgDir("acc1", "org1");
    const rpmDir = path.join(orgDir, "rpm");
    fs.mkdirSync(rpmDir, { recursive: true });
    fs.writeFileSync(path.join(rpmDir, "manifest.json"), JSON.stringify([]));

    const roots = discoverCoworkRoots(ctx());
    expect(roots[0]?.rpmManifestPath).toBe(path.join(rpmDir, "manifest.json"));
  });

  it("populates coworkSettingsPath when cowork_settings.json exists", () => {
    const orgDir = makeOrgDir("acc1", "org1");
    fs.writeFileSync(path.join(orgDir, "cowork_settings.json"), JSON.stringify({}));

    const roots = discoverCoworkRoots(ctx());
    expect(roots[0]?.coworkSettingsPath).toBe(path.join(orgDir, "cowork_settings.json"));
  });

  it("reads installed_plugins.json mtime when file exists", () => {
    const orgDir = makeOrgDir("acc1", "org1");
    const coworkPluginsDir = path.join(orgDir, "cowork_plugins");
    fs.mkdirSync(coworkPluginsDir, { recursive: true });
    fs.writeFileSync(
      path.join(coworkPluginsDir, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: {} }),
    );

    const roots = discoverCoworkRoots(ctx());
    expect(typeof roots[0]?.installedPluginsMtime).toBe("number");
    expect(roots[0]?.installedPluginsMtime).toBeGreaterThan(0);
  });

  it("sets isMostRecent on the root with the largest mtime (multi-org)", () => {
    const orgDir1 = makeOrgDir("acc1", "org1");
    const orgDir2 = makeOrgDir("acc1", "org2");

    const cp1 = path.join(orgDir1, "cowork_plugins");
    const cp2 = path.join(orgDir2, "cowork_plugins");
    fs.mkdirSync(cp1, { recursive: true });
    fs.mkdirSync(cp2, { recursive: true });

    // Write org1's file first, then org2's — org2's mtime will be newer.
    fs.writeFileSync(
      path.join(cp1, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: {} }),
    );
    // Small delay to ensure different mtime on slow filesystems.
    // We set mtime explicitly instead to avoid race conditions.
    fs.utimesSync(path.join(cp1, "installed_plugins.json"), new Date(1000), new Date(1000));
    fs.writeFileSync(
      path.join(cp2, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: {} }),
    );
    fs.utimesSync(path.join(cp2, "installed_plugins.json"), new Date(5000), new Date(5000));

    const roots = discoverCoworkRoots(ctx());
    expect(roots).toHaveLength(2);

    const byOrg = Object.fromEntries(roots.map((r) => [r.orgId, r]));
    expect(byOrg.org1?.isMostRecent).toBe(false);
    expect(byOrg.org2?.isMostRecent).toBe(true);
  });

  it("no root is isMostRecent when no root has a defined mtime", () => {
    makeOrgDir("acc1", "org1");
    makeOrgDir("acc1", "org2");

    const roots = discoverCoworkRoots(ctx());
    expect(roots.every((r) => r.isMostRecent === false)).toBe(true);
  });

  it("parses known_marketplaces.json when present in cowork_plugins", () => {
    const orgDir = makeOrgDir("acc1", "org1");
    const cp = path.join(orgDir, "cowork_plugins");
    fs.mkdirSync(cp, { recursive: true });
    fs.writeFileSync(
      path.join(cp, "known_marketplaces.json"),
      JSON.stringify({
        "my-mp": { source: { source: "github", repo: "owner/repo" } },
      }),
    );

    const roots = discoverCoworkRoots(ctx());
    expect(roots[0]?.marketplaces).toHaveLength(1);
    expect(roots[0]?.marketplaces[0]?.name).toBe("my-mp");
    expect(roots[0]?.marketplaces[0]?.source.kind).toBe("github");
  });

  it("returns empty marketplaces when known_marketplaces.json is absent", () => {
    const orgDir = makeOrgDir("acc1", "org1");
    fs.mkdirSync(path.join(orgDir, "cowork_plugins"), { recursive: true });
    // No known_marketplaces.json inside.

    const roots = discoverCoworkRoots(ctx());
    expect(roots[0]?.marketplaces).toEqual([]);
  });

  it("returns multiple roots for multiple (acc, org) combinations", () => {
    makeOrgDir("acc1", "org1");
    makeOrgDir("acc1", "org2");
    makeOrgDir("acc2", "orgA");

    const roots = discoverCoworkRoots(ctx());
    expect(roots).toHaveLength(3);
    const keys = roots.map((r) => `${r.accountId}/${r.orgId}`).sort();
    expect(keys).toEqual(["acc1/org1", "acc1/org2", "acc2/orgA"]);
  });
});
