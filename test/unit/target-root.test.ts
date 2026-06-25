import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTargetRootForMarketplace } from "../../src/target-root.js";

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  tmp.length = 0;
});

function fixture(): { home: string; ccd: string; cwPlugins: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-tr-"));
  tmp.push(home);
  const ccd = path.join(home, ".claude", "plugins");
  const cwPlugins = path.join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "local-agent-mode-sessions",
    "acc1",
    "org1",
    "cowork_plugins",
  );
  fs.mkdirSync(ccd, { recursive: true });
  fs.mkdirSync(cwPlugins, { recursive: true });
  return { home, ccd, cwPlugins };
}

function writeKnown(root: string, names: string[]) {
  const obj: Record<string, unknown> = {};
  for (const n of names) obj[n] = { source: { source: "github", repo: `x/${n}` } };
  fs.writeFileSync(path.join(root, "known_marketplaces.json"), JSON.stringify(obj));
}

function makeClone(root: string, name: string) {
  fs.mkdirSync(path.join(root, "marketplaces", name), { recursive: true });
}

const base = (home: string) => ({
  platform: "darwin" as NodeJS.Platform,
  home,
  env: { HOME: home },
});

describe("resolveTargetRootForMarketplace", () => {
  it("registered + cloned only in CCD → directive ccd (even if cowork exists)", () => {
    const { home, ccd, cwPlugins } = fixture();
    writeKnown(ccd, ["demo"]);
    makeClone(ccd, "demo");
    writeKnown(cwPlugins, []);
    const r = resolveTargetRootForMarketplace({ ...base(home), marketplaceName: "demo" });
    expect(r.directive).toEqual({ kind: "ccd" });
    expect(r.ambiguous).toBe(false);
  });

  it("registered + cloned only in a cowork root → directive cowork with acc/org", () => {
    const { home, ccd, cwPlugins } = fixture();
    writeKnown(ccd, []);
    writeKnown(cwPlugins, ["demo"]);
    makeClone(cwPlugins, "demo");
    const r = resolveTargetRootForMarketplace({ ...base(home), marketplaceName: "demo" });
    expect(r.directive).toEqual({ kind: "cowork", accountId: "acc1", orgId: "org1" });
  });

  it("registered in both, cloned only in CCD → prefer the root with the clone", () => {
    const { home, ccd, cwPlugins } = fixture();
    writeKnown(ccd, ["demo"]);
    makeClone(ccd, "demo");
    writeKnown(cwPlugins, ["demo"]);
    const r = resolveTargetRootForMarketplace({ ...base(home), marketplaceName: "demo" });
    expect(r.directive).toEqual({ kind: "ccd" });
    expect(r.ambiguous).toBe(true);
  });

  it("registered nowhere → undefined directive, searched lists roots", () => {
    const { home, ccd, cwPlugins } = fixture();
    writeKnown(ccd, []);
    writeKnown(cwPlugins, []);
    const r = resolveTargetRootForMarketplace({ ...base(home), marketplaceName: "demo" });
    expect(r.directive).toBeUndefined();
    expect(r.searched.length).toBeGreaterThanOrEqual(2);
    expect(r.searched.some((s) => s.includes(".claude"))).toBe(true);
  });

  it("a corrupt cowork known_marketplaces.json does NOT throw; CCD marketplace still resolves", () => {
    const { home, ccd, cwPlugins } = fixture();
    writeKnown(ccd, ["demo"]);
    makeClone(ccd, "demo");
    fs.writeFileSync(path.join(cwPlugins, "known_marketplaces.json"), "{ this is not json");
    let r!: ReturnType<typeof resolveTargetRootForMarketplace>;
    expect(() => {
      r = resolveTargetRootForMarketplace({ ...base(home), marketplaceName: "demo" });
    }).not.toThrow();
    expect(r.directive).toEqual({ kind: "ccd" });
  });
});
