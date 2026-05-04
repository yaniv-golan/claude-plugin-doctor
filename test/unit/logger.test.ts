import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Logger } from "../../src/logger.js";

describe("Logger (NDJSON, synchronous)", () => {
  it("writes one NDJSON line per log call", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-log-"));
    const logFile = path.join(tmp, "run.log");
    const lg = new Logger({ filePath: logFile, runId: "rid-1" });
    lg.info("hello", { phase: "init" });
    lg.warn("careful", { foo: 42 });
    lg.close();
    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const a = JSON.parse(lines[0] ?? "");
    const b = JSON.parse(lines[1] ?? "");
    expect(a).toMatchObject({ level: "info", msg: "hello", runId: "rid-1", phase: "init" });
    expect(b).toMatchObject({ level: "warn", msg: "careful", foo: 42 });
    expect(a.ts).toMatch(/T.*Z$/);
  });

  it("flushes synchronously — content readable mid-run without close()", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-log-"));
    const logFile = path.join(tmp, "run.log");
    const lg = new Logger({ filePath: logFile });
    lg.info("first");
    const content = fs.readFileSync(logFile, "utf8");
    expect(content).toMatch(/"msg":"first"/);
    lg.close();
  });

  it("respects fileLevel filtering", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-log-"));
    const logFile = path.join(tmp, "run.log");
    const lg = new Logger({ filePath: logFile, fileLevel: "warn" });
    lg.debug("dropped");
    lg.info("dropped");
    lg.warn("kept");
    lg.close();
    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "").msg).toBe("kept");
  });

  it("operates without a filePath (no-op file write)", () => {
    const lg = new Logger({});
    expect(() => lg.info("noop")).not.toThrow();
    lg.close();
  });

  it("auto-generates a UUID runId when none provided", () => {
    const lg = new Logger({});
    expect(lg.getRunId()).toMatch(/^[0-9a-f-]{36}$/);
    lg.close();
  });
});
