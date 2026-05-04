import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  enumerateCoworkRoots,
  resolveCcdPluginsRoot,
  resolveUserDataDir,
} from "../../src/paths.js";

const ORIG_ENV = { ...process.env };

describe("paths (macOS)", () => {
  beforeEach(() => {
    process.env.CLAUDE_CONFIG_DIR = undefined;
  });
  afterEach(() => {
    process.env = { ...ORIG_ENV };
  });

  it("resolveUserDataDir returns ~/Library/Application Support/Claude on darwin", () => {
    expect(resolveUserDataDir({ platform: "darwin", home: "/Users/me" })).toBe(
      "/Users/me/Library/Application Support/Claude",
    );
  });

  it("resolveCcdPluginsRoot returns ~/.claude/plugins by default on darwin", () => {
    expect(resolveCcdPluginsRoot({ platform: "darwin", home: "/Users/me", env: {} })).toBe(
      "/Users/me/.claude/plugins",
    );
  });

  it("CLAUDE_CONFIG_DIR overrides ~/.claude location", () => {
    expect(
      resolveCcdPluginsRoot({
        platform: "darwin",
        home: "/Users/me",
        env: { CLAUDE_CONFIG_DIR: "/tmp/c" },
      }),
    ).toBe("/tmp/c/plugins");
  });

  it("non-darwin platforms throw NotImplementedError", () => {
    expect(() => resolveUserDataDir({ platform: "linux", home: "/home/me" })).toThrow(
      /macOS only/i,
    );
  });

  it("enumerateCoworkRoots returns [] when local-agent-mode-sessions/ is missing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    try {
      expect(enumerateCoworkRoots(tmp)).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("enumerateCoworkRoots returns one entry per <acc>/<org> dir", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    try {
      const sessions = path.join(tmp, "local-agent-mode-sessions");
      fs.mkdirSync(path.join(sessions, "acc1", "org1"), { recursive: true });
      fs.mkdirSync(path.join(sessions, "acc1", "org2"), { recursive: true });
      const roots = enumerateCoworkRoots(tmp);
      expect(roots).toHaveLength(2);
      expect(roots.map((r) => `${r.accountId}/${r.orgId}`).sort()).toEqual([
        "acc1/org1",
        "acc1/org2",
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
