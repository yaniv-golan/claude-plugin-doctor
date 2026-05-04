import { describe, expect, it } from "vitest";
import { CpdError } from "../../src/errors.js";

describe("CpdError", () => {
  it("preserves the code, message, and hint", () => {
    const e = new CpdError("E_USAGE", "missing arg", "see --help");
    expect(e.code).toBe("E_USAGE");
    expect(e.message).toBe("missing arg");
    expect(e.hint).toBe("see --help");
    expect(e instanceof Error).toBe(true);
    expect(e.name).toBe("CpdError");
  });

  it("toEnvelope produces an ErrorEnvelope without runId/logFile when not provided", () => {
    const e = new CpdError("E_PARSE_INSTALLED_PLUGINS", "bad json");
    expect(e.toEnvelope()).toEqual({
      ok: false,
      code: "E_PARSE_INSTALLED_PLUGINS",
      message: "bad json",
    });
  });

  it("toEnvelope merges runId and logFile when provided", () => {
    const e = new CpdError("E_GIT_TIMEOUT", "ls-remote slow", "try --no-network");
    expect(e.toEnvelope({ runId: "abc", logFile: "/tmp/x.log" })).toEqual({
      ok: false,
      code: "E_GIT_TIMEOUT",
      message: "ls-remote slow",
      hint: "try --no-network",
      runId: "abc",
      logFile: "/tmp/x.log",
    });
  });
});
