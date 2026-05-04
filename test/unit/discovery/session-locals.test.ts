import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSessionLocals } from "../../../src/discovery/session-locals.js";
import type { CoworkRoot } from "../../../src/types.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-sl-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const UUID = "550e8400-e29b-41d4-a716-446655440000";
const ORG_UUID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

/** Build a minimal CoworkRoot pointing at accDir/orgDir under tmp. */
function makeRoot(accId: string, orgId: string): { root: CoworkRoot; accDir: string } {
  const accDir = path.join(tmp, accId);
  const rootPath = path.join(accDir, orgId);
  fs.mkdirSync(rootPath, { recursive: true });
  const root: CoworkRoot = {
    accountId: accId,
    orgId,
    rootPath,
    hasCoworkPlugins: false,
    hasRpm: false,
    isMostRecent: false,
    marketplaces: [],
  };
  return { root, accDir };
}

describe("discoverSessionLocals", () => {
  it("returns [] for empty coworkRoots array", () => {
    expect(discoverSessionLocals([])).toEqual([]);
  });

  it("returns [] when no session-local dirs exist", () => {
    const { root } = makeRoot("acc1", "org1");
    expect(discoverSessionLocals([root])).toEqual([]);
  });

  it("matches local_<UUID> directories as session-local", () => {
    const { root, accDir } = makeRoot("acc1", "org1");
    const localDir = path.join(accDir, `local_${UUID}`);
    fs.mkdirSync(localDir, { recursive: true });

    const results = discoverSessionLocals([root]);
    expect(results).toHaveLength(1);
    const entry = results[0];
    expect(entry?.kind).toBe("session-local");
    expect(entry?.uuid).toBe(UUID);
    expect(entry?.pathOnDisk).toBe(localDir);
    expect(entry?.parentRoot).toBe(root.rootPath);
    expect(typeof entry?.lastModified).toBe("number");
    expect(typeof entry?.approxSizeBytes).toBe("number");
  });

  it("matches local_ditto_<orgUuid>_g<N> directories as ditto-bridge-history", () => {
    const { root, accDir } = makeRoot("acc1", "org1");
    const dittoDir = path.join(accDir, `local_ditto_${ORG_UUID}_g3`);
    fs.mkdirSync(dittoDir, { recursive: true });

    const results = discoverSessionLocals([root]);
    expect(results).toHaveLength(1);
    const entry = results[0];
    expect(entry?.kind).toBe("ditto-bridge-history");
    expect(entry?.orgUuid).toBe(ORG_UUID);
    expect(entry?.generation).toBe(3);
    expect(entry?.pathOnDisk).toBe(dittoDir);
  });

  it("ignores directories that don't match either pattern", () => {
    const { root, accDir } = makeRoot("acc1", "org1");
    // These should not match.
    fs.mkdirSync(path.join(accDir, "org1"), { recursive: true }); // the cowork root itself
    fs.mkdirSync(path.join(accDir, "random-dir"), { recursive: true });
    fs.mkdirSync(path.join(accDir, "local_not-a-uuid"), { recursive: true });

    const results = discoverSessionLocals([root]);
    expect(results).toHaveLength(0);
  });

  it("handles multiple session-local dirs across multiple roots", () => {
    const { root: root1, accDir: accDir1 } = makeRoot("acc1", "org1");
    const { root: root2, accDir: accDir2 } = makeRoot("acc2", "org1");

    fs.mkdirSync(path.join(accDir1, `local_${UUID}`), { recursive: true });
    fs.mkdirSync(path.join(accDir2, `local_ditto_${ORG_UUID}_g1`), { recursive: true });

    const results = discoverSessionLocals([root1, root2]);
    expect(results).toHaveLength(2);
    expect(results.some((r) => r.kind === "session-local")).toBe(true);
    expect(results.some((r) => r.kind === "ditto-bridge-history")).toBe(true);
  });

  it("deduplicates when multiple orgs share the same account directory", () => {
    // Two roots under the same acc1 directory — session-local dirs should be
    // counted once, not twice.
    const accDir = path.join(tmp, "acc1");
    fs.mkdirSync(path.join(accDir, "org1"), { recursive: true });
    fs.mkdirSync(path.join(accDir, "org2"), { recursive: true });
    fs.mkdirSync(path.join(accDir, `local_${UUID}`), { recursive: true });

    const root1: CoworkRoot = {
      accountId: "acc1",
      orgId: "org1",
      rootPath: path.join(accDir, "org1"),
      hasCoworkPlugins: false,
      hasRpm: false,
      isMostRecent: false,
      marketplaces: [],
    };
    const root2: CoworkRoot = {
      accountId: "acc1",
      orgId: "org2",
      rootPath: path.join(accDir, "org2"),
      hasCoworkPlugins: false,
      hasRpm: false,
      isMostRecent: false,
      marketplaces: [],
    };

    const results = discoverSessionLocals([root1, root2]);
    // Should appear exactly once even though two roots share the same accDir.
    expect(results).toHaveLength(1);
  });

  it("populates approxSizeBytes as a non-negative number", () => {
    const { root, accDir } = makeRoot("acc1", "org1");
    fs.mkdirSync(path.join(accDir, `local_${UUID}`), { recursive: true });

    const results = discoverSessionLocals([root]);
    expect(results[0]?.approxSizeBytes).toBeGreaterThanOrEqual(0);
  });
});
