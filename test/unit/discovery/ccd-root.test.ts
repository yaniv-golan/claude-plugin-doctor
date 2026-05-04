import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverCcdRoot } from "../../../src/discovery/ccd-root.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-ccd-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Build context pointing at tmp as HOME. */
function ctx() {
  return { platform: "darwin" as NodeJS.Platform, home: tmp, env: {} };
}

/** Expected plugins root path. */
function pluginsRoot() {
  return path.join(tmp, ".claude", "plugins");
}

describe("discoverCcdRoot", () => {
  it("returns undefined on non-darwin platform", () => {
    expect(discoverCcdRoot({ platform: "linux", home: tmp, env: {} })).toBeUndefined();
  });

  it("returns undefined when plugins root does not exist", () => {
    // No .claude/plugins directory created.
    expect(discoverCcdRoot(ctx())).toBeUndefined();
  });

  it("returns a CcdRoot when plugins root exists but known_marketplaces.json is absent", () => {
    const root = pluginsRoot();
    fs.mkdirSync(root, { recursive: true });

    const result = discoverCcdRoot(ctx());
    expect(result).not.toBeUndefined();
    expect(result?.pluginsRoot).toBe(root);
    expect(result?.marketplaces).toEqual([]);
    expect(result?.installedPluginsMtime).toBeUndefined();
  });

  it("populates installedPluginsMtime when installed_plugins.json exists", () => {
    const root = pluginsRoot();
    fs.mkdirSync(root, { recursive: true });
    const installedPath = path.join(root, "installed_plugins.json");
    fs.writeFileSync(installedPath, JSON.stringify({ version: 2, plugins: {} }));

    const result = discoverCcdRoot(ctx());
    expect(typeof result?.installedPluginsMtime).toBe("number");
    expect(result?.installedPluginsMtime).toBeGreaterThan(0);
  });

  it("returns empty marketplaces array when known_marketplaces.json is absent", () => {
    fs.mkdirSync(pluginsRoot(), { recursive: true });
    const result = discoverCcdRoot(ctx());
    expect(result?.marketplaces).toEqual([]);
  });

  it("parses a well-formed known_marketplaces.json with github source", () => {
    const root = pluginsRoot();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, "known_marketplaces.json"),
      JSON.stringify({
        "my-marketplace": {
          source: { source: "github", repo: "owner/repo" },
        },
      }),
    );

    const result = discoverCcdRoot(ctx());
    expect(result?.marketplaces).toHaveLength(1);
    const mp = result?.marketplaces[0];
    expect(mp?.name).toBe("my-marketplace");
    expect(mp?.source.kind).toBe("github");
    expect(mp?.lastUpdated).toBeUndefined();
    expect(mp?.installLocation).toBeUndefined();
  });

  it("extracts lastUpdated from raw when it is a number", () => {
    const root = pluginsRoot();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, "known_marketplaces.json"),
      JSON.stringify({
        "mp-with-ts": {
          source: { source: "github", repo: "owner/repo" },
          lastUpdated: 1714000000000,
        },
      }),
    );

    const result = discoverCcdRoot(ctx());
    const mp = result?.marketplaces[0];
    expect(mp?.lastUpdated).toBe(1714000000000);
  });

  it("leaves lastUpdated undefined when raw.lastUpdated is an ISO string (not a number)", () => {
    const root = pluginsRoot();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, "known_marketplaces.json"),
      JSON.stringify({
        "mp-iso": {
          source: { source: "github", repo: "owner/repo" },
          lastUpdated: "2026-04-26T00:06:01.165Z",
        },
      }),
    );

    const result = discoverCcdRoot(ctx());
    const mp = result?.marketplaces[0];
    // ISO string is not a number — leave undefined per spec.
    expect(mp?.lastUpdated).toBeUndefined();
  });

  it("extracts installLocation from raw when it is a string", () => {
    const root = pluginsRoot();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, "known_marketplaces.json"),
      JSON.stringify({
        "mp-with-loc": {
          source: { source: "directory", path: "/tmp/mp" },
          installLocation: "/Users/me/.claude/plugins/marketplaces/mp-with-loc",
        },
      }),
    );

    const result = discoverCcdRoot(ctx());
    const mp = result?.marketplaces[0];
    expect(mp?.installLocation).toBe("/Users/me/.claude/plugins/marketplaces/mp-with-loc");
  });

  it("preserves raw marketplace data", () => {
    const root = pluginsRoot();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, "known_marketplaces.json"),
      JSON.stringify({
        "my-mp": {
          source: { source: "github", repo: "owner/repo" },
          extraField: "preserved",
        },
      }),
    );

    const result = discoverCcdRoot(ctx());
    const mp = result?.marketplaces[0];
    expect(mp?.raw.extraField).toBe("preserved");
  });

  it("source.raw contains the full source object", () => {
    const root = pluginsRoot();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, "known_marketplaces.json"),
      JSON.stringify({
        "my-mp": {
          source: { source: "github", repo: "owner/repo", ref: "main" },
        },
      }),
    );

    const result = discoverCcdRoot(ctx());
    const mp = result?.marketplaces[0];
    expect(mp?.source.raw).toMatchObject({ source: "github", repo: "owner/repo", ref: "main" });
  });

  it("propagates errors on malformed known_marketplaces.json", () => {
    const root = pluginsRoot();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "known_marketplaces.json"), "{ not json");
    expect(() => discoverCcdRoot(ctx())).toThrow(/known_marketplaces\.json/);
  });

  it("returns correct knownMarketplacesPath and installedPluginsPath", () => {
    const root = pluginsRoot();
    fs.mkdirSync(root, { recursive: true });
    const result = discoverCcdRoot(ctx());
    expect(result?.knownMarketplacesPath).toBe(path.join(root, "known_marketplaces.json"));
    expect(result?.installedPluginsPath).toBe(path.join(root, "installed_plugins.json"));
    expect(result?.marketplacesDir).toBe(path.join(root, "marketplaces"));
    expect(result?.cacheDir).toBe(path.join(root, "cache"));
  });
});
