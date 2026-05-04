import { describe, expect, it } from "vitest";
import { shellQuote } from "../../../src/output/cmd-format.js";

describe("shellQuote (audit issue #11)", () => {
  it("wraps plain ASCII in single quotes", () => {
    expect(shellQuote("plain")).toBe("'plain'");
  });

  it("escapes embedded single quotes via the POSIX '\\'' trick", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it("preserves shell metacharacters inside the quotes (no special handling needed)", () => {
    // The whole point of single-quoting in POSIX shells is that nothing
    // inside is interpreted, so $ ` ; & | ( ) > < etc. round-trip literally.
    expect(shellQuote("$EVIL;rm -rf /")).toBe("'$EVIL;rm -rf /'");
    expect(shellQuote("a`b`c")).toBe("'a`b`c'");
    expect(shellQuote("x|y&z")).toBe("'x|y&z'");
  });

  it("handles the empty string", () => {
    expect(shellQuote("")).toBe("''");
  });

  it("handles strings of only single quotes", () => {
    expect(shellQuote("'")).toBe("''\\'''");
    expect(shellQuote("''")).toBe("''\\'''\\'''");
  });
});
