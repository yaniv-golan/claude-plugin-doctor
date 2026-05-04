import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { hashSourceDir } from "../../src/source-hash.js";

describe("hashSourceDir", () => {
  it("returns the same hash for identical trees", () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    fs.writeFileSync(path.join(a, "x.md"), "hello");
    fs.mkdirSync(path.join(a, "sub"));
    fs.writeFileSync(path.join(a, "sub", "y.json"), '{"k":1}');
    fs.writeFileSync(path.join(b, "x.md"), "hello");
    fs.mkdirSync(path.join(b, "sub"));
    fs.writeFileSync(path.join(b, "sub", "y.json"), '{"k":1}');
    expect(hashSourceDir(a)).toBe(hashSourceDir(b));
  });

  it("returns different hashes when one byte differs", () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    fs.writeFileSync(path.join(a, "x.md"), "hello");
    fs.writeFileSync(path.join(b, "x.md"), "Hello"); // case differs
    expect(hashSourceDir(a)).not.toBe(hashSourceDir(b));
  });

  it("ignores .git, node_modules, .DS_Store", () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    fs.writeFileSync(path.join(a, "x.md"), "x");
    const baseline = hashSourceDir(a);
    fs.mkdirSync(path.join(a, ".git"));
    fs.writeFileSync(path.join(a, ".git", "HEAD"), "ref: refs/heads/main");
    fs.mkdirSync(path.join(a, "node_modules"));
    fs.writeFileSync(path.join(a, ".DS_Store"), "junk");
    expect(hashSourceDir(a)).toBe(baseline);
  });

  it("returns empty string when root doesn't exist", () => {
    expect(hashSourceDir("/does/not/exist")).toBe("");
  });

  it("hashes prefixed with sha256-", () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    fs.writeFileSync(path.join(a, "x.md"), "x");
    expect(hashSourceDir(a)).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  it("ignores .orphaned_at (Claude cache metadata) and .registry (MCP runtime state)", () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-"));
    fs.writeFileSync(path.join(a, "plugin.json"), '{"name":"p","version":"1.0.0"}');
    const baseline = hashSourceDir(a);
    // Add a Claude-written .orphaned_at marker (cache-side only in real installs).
    fs.writeFileSync(path.join(a, ".orphaned_at"), "2026-04-29T10:55:49Z");
    // Add an MCP-style .registry dir with runtime state.
    fs.mkdirSync(path.join(a, "mcp-server", ".registry"), { recursive: true });
    fs.writeFileSync(path.join(a, "mcp-server", ".registry", "tools.json"), '{"tools":[]}');
    expect(hashSourceDir(a)).toBe(baseline);
  });
});
