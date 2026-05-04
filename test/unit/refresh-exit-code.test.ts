import { describe, expect, it } from "vitest";
import { computeRefreshExitCode } from "../../src/commands/refresh.js";

describe("computeRefreshExitCode (audit issues #3, #4)", () => {
  it("clean mutations + clean post-scan → exit 0", () => {
    expect(computeRefreshExitCode(0, true, false)).toBe(0);
  });

  it("failed claudeUpdate + clean post-scan → exit 3 (audit #3)", () => {
    // Pre-fix this returned 0: the report exit code was just `after.exitCode`,
    // so a silent failure of `claude plugin marketplace update` was masked
    // when the post-scan happened to be clean.
    expect(computeRefreshExitCode(0, false, false)).toBe(3);
  });

  it("any chain failure + clean post-scan → exit 3 (audit #4)", () => {
    expect(computeRefreshExitCode(0, true, true)).toBe(3);
  });

  it("both claudeUpdate and chain failed → exit 3 (verdict not double-counted)", () => {
    // The aggregator is `max`, so both failures collapse to a single 3 — we
    // don't emit 4 or 5 for "two things broke". The structured `mutations`
    // fields on RefreshReport carry the per-step detail.
    expect(computeRefreshExitCode(0, false, true)).toBe(3);
  });

  it("post-scan exit 2 + clean mutations → exit 2 (drift detected, no failures)", () => {
    expect(computeRefreshExitCode(2, true, false)).toBe(2);
  });

  it("post-scan exit 3 + clean mutations → exit 3 (destructive recommendation)", () => {
    // post-scan already returned 3 (e.g. destructive marketplace-update-broken
    // recovery); mutations cleanly succeeded; verdict stays 3.
    expect(computeRefreshExitCode(3, true, false)).toBe(3);
  });

  it("post-scan exit 2 + failed claudeUpdate → exit 3 (lifts the verdict)", () => {
    expect(computeRefreshExitCode(2, false, false)).toBe(3);
  });
});
