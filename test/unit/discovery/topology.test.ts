import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverTopology, runId } from "../../../src/discovery/topology.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-topo-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function ctx() {
  return { platform: "darwin" as NodeJS.Platform, home: tmp, env: {} };
}

/** ~/.claude/plugins root. */
function ccdPluginsDir() {
  return path.join(tmp, ".claude", "plugins");
}

/** <userData>/local-agent-mode-sessions. */
function sessionsDir() {
  return path.join(tmp, "Library", "Application Support", "Claude", "local-agent-mode-sessions");
}

describe("discoverTopology", () => {
  it("returns a Topology with all-empty collections when nothing exists", () => {
    const topo = discoverTopology(ctx());
    expect(topo.ccd).toBeUndefined();
    expect(topo.cowork).toEqual([]);
    expect(topo.skillsPlugin).toBeUndefined();
    expect(topo.sessionLocals).toEqual([]);
    expect(topo.scannedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("populates ccd when ~/.claude/plugins exists", () => {
    fs.mkdirSync(ccdPluginsDir(), { recursive: true });
    const topo = discoverTopology(ctx());
    expect(topo.ccd).not.toBeUndefined();
    expect(topo.ccd?.pluginsRoot).toBe(ccdPluginsDir());
  });

  it("populates cowork roots when sessions dir has (acc, org) dirs", () => {
    const sessions = sessionsDir();
    fs.mkdirSync(path.join(sessions, "acc1", "org1"), { recursive: true });
    fs.mkdirSync(path.join(sessions, "acc1", "org2"), { recursive: true });

    const topo = discoverTopology(ctx());
    expect(topo.cowork).toHaveLength(2);
  });

  it("populates skillsPlugin when skills-plugin/ exists", () => {
    const sessions = sessionsDir();
    fs.mkdirSync(path.join(sessions, "skills-plugin", "org1", "acc1"), { recursive: true });

    const topo = discoverTopology(ctx());
    expect(topo.skillsPlugin).not.toBeUndefined();
    expect(topo.skillsPlugin?.pairs).toHaveLength(1);
  });

  it("populates sessionLocals for local_<UUID> dirs", () => {
    const sessions = sessionsDir();
    const accDir = path.join(sessions, "acc1");
    fs.mkdirSync(path.join(accDir, "org1"), { recursive: true });
    fs.mkdirSync(path.join(accDir, "local_550e8400-e29b-41d4-a716-446655440000"), {
      recursive: true,
    });

    const topo = discoverTopology(ctx());
    expect(topo.sessionLocals).toHaveLength(1);
    expect(topo.sessionLocals[0]?.kind).toBe("session-local");
  });

  it("sets scannedAt to a valid ISO string", () => {
    const topo = discoverTopology(ctx());
    expect(new Date(topo.scannedAt).toISOString()).toBe(topo.scannedAt);
  });

  it("orchestrates all four walkers into one shape", () => {
    const sessions = sessionsDir();
    // CCD root
    fs.mkdirSync(ccdPluginsDir(), { recursive: true });
    // Cowork root
    const accDir = path.join(sessions, "acc1");
    fs.mkdirSync(path.join(accDir, "org1"), { recursive: true });
    // Skills-plugin
    fs.mkdirSync(path.join(sessions, "skills-plugin", "orgX", "accY"), { recursive: true });
    // Session-local (sibling of org1)
    fs.mkdirSync(path.join(accDir, "local_550e8400-e29b-41d4-a716-446655440000"), {
      recursive: true,
    });

    const topo = discoverTopology(ctx());
    expect(topo.ccd).not.toBeUndefined();
    expect(topo.cowork).toHaveLength(1);
    expect(topo.skillsPlugin?.pairs).toHaveLength(1);
    expect(topo.sessionLocals).toHaveLength(1);
  });
});

describe("runId", () => {
  it("returns a string matching UUID v4 format", () => {
    const id = runId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("returns a different value each call", () => {
    expect(runId()).not.toBe(runId());
  });
});
