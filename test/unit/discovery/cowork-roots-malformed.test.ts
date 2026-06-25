import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverCoworkRoots } from "../../../src/discovery/cowork-roots.js";

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  tmp.length = 0;
});

function coworkRoot(home: string, acc: string, org: string): string {
  const p = path.join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "local-agent-mode-sessions",
    acc,
    org,
    "cowork_plugins",
  );
  fs.mkdirSync(p, { recursive: true });
  return p;
}

describe("discoverCoworkRoots: one malformed known_marketplaces.json must not abort discovery", () => {
  it("skips the bad root's marketplaces and still discovers the good root", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-cwm-"));
    tmp.push(home);
    const good = coworkRoot(home, "accGood", "org1");
    const bad = coworkRoot(home, "accBad", "org1");
    fs.writeFileSync(
      path.join(good, "known_marketplaces.json"),
      JSON.stringify({ goodmp: { source: { source: "github", repo: "x/goodmp" } } }),
    );
    fs.writeFileSync(path.join(bad, "known_marketplaces.json"), "{ this is not json");

    let roots!: ReturnType<typeof discoverCoworkRoots>;
    expect(() => {
      roots = discoverCoworkRoots({ home, platform: "darwin" });
    }).not.toThrow();

    expect(roots.length).toBe(2);
    const g = roots.find((r) => r.accountId === "accGood");
    const b = roots.find((r) => r.accountId === "accBad");
    expect(g?.marketplaces.some((m) => m.name === "goodmp")).toBe(true);
    expect(b?.marketplaces.some((m) => m.name === "goodmp")).toBe(false);
  });
});
