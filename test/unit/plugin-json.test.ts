/**
 * Unit tests for src/plugin-json.ts — parsePluginJson helper (Gap 4, v1.0).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePluginJson } from "../../src/plugin-json.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-plugin-json-unit-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

describe("parsePluginJson — returns undefined for unreadable inputs", () => {
  it("returns undefined for non-existent file", () => {
    expect(parsePluginJson(path.join(tmpDir, "missing.json"))).toBeUndefined();
  });

  it("returns undefined for malformed JSON", () => {
    const p = write("bad.json", "{ not json ]");
    expect(parsePluginJson(p)).toBeUndefined();
  });

  it("returns undefined for a JSON array", () => {
    const p = write("arr.json", JSON.stringify([1, 2, 3]));
    expect(parsePluginJson(p)).toBeUndefined();
  });

  it("returns undefined for a JSON null", () => {
    const p = write("null.json", "null");
    expect(parsePluginJson(p)).toBeUndefined();
  });

  it("returns undefined for a JSON number", () => {
    const p = write("num.json", "42");
    expect(parsePluginJson(p)).toBeUndefined();
  });
});

describe("parsePluginJson — well-formed inputs", () => {
  it("parses version field", () => {
    const p = write("p.json", JSON.stringify({ version: "1.2.3" }));
    expect(parsePluginJson(p)?.version).toBe("1.2.3");
  });

  it("omits version when not a string", () => {
    const p = write("p.json", JSON.stringify({ version: 123 }));
    expect(parsePluginJson(p)?.version).toBeUndefined();
  });

  it("parses commands, agents, skills, hooks, mcpServers", () => {
    const data = {
      version: "1.0.0",
      commands: [{ name: "foo" }],
      agents: { myAgent: {} },
      skills: ["bar"],
      hooks: { onStart: "script.sh" },
      mcpServers: { local: { command: "node server.js" } },
    };
    const p = write("p.json", JSON.stringify(data));
    const result = parsePluginJson(p);
    expect(result?.commands).toEqual([{ name: "foo" }]);
    expect(result?.agents).toEqual({ myAgent: {} });
    expect(result?.skills).toEqual(["bar"]);
    expect(result?.hooks).toEqual({ onStart: "script.sh" });
    expect(result?.mcpServers).toEqual({ local: { command: "node server.js" } });
  });

  it("includes extra fields in raw", () => {
    const p = write("p.json", JSON.stringify({ version: "1.0.0", customField: "hello" }));
    const result = parsePluginJson(p);
    expect(result?.raw.customField).toBe("hello");
  });

  it("returns empty-ish result for an empty object {}", () => {
    const p = write("p.json", "{}");
    const result = parsePluginJson(p);
    expect(result).toBeDefined();
    expect(result?.version).toBeUndefined();
    expect(result?.raw).toEqual({});
  });
});
