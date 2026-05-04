import { describe, expect, it } from "vitest";
import { computeExitCode } from "../../src/commands/scan.js";
import type { Drift, PluginRef, RecommendedAction } from "../../src/types.js";

const pluginRef: PluginRef = {
  pluginName: "p",
  marketplace: "mp",
  root: { kind: "ccd" },
};

function versionDrift(ahead: "upstream" | "installed" | "incomparable"): Drift {
  return {
    kind: "version-drift",
    subject: { kind: "plugin", ref: pluginRef },
    upstreamVersion: "2.0.0",
    installedVersion: "1.0.0",
    ahead,
  };
}

function refreshNeeded(): Drift {
  return {
    kind: "refresh-needed",
    subject: { kind: "plugin", ref: pluginRef },
    detail: "test",
    installedGitCommitSha: "aaa",
    cloneHeadSha: "bbb",
  };
}

function runtimeBoundary(): Drift {
  return {
    kind: "runtime-boundary",
    subject: { kind: "plugin", ref: pluginRef },
    changedSurfaces: ["command"],
    changedSurfacesSource: "diff-installed-vs-resolved",
    refreshBy: "new-task",
  };
}

const safeRec = (id: string): RecommendedAction => ({
  id,
  conditionId: "install_snapshot:version_drift",
  ordinal: 1,
  description: "x",
  cmd: "claude plugin update p@mp",
  fixes: [],
  doesNotFix: [],
  refs: {},
  recipes: [],
  risk: "safe",
  requiresYes: false,
  requiresManualStep: false,
});

describe("computeExitCode (audit issue #1)", () => {
  it("version-drift with ahead=upstream is actionable → exit 2", () => {
    // Pre-fix this returned 0 because version-drift was missing from the
    // actionable set, so automation couldn't gate on the exit code when the
    // only finding was a stale install.
    expect(computeExitCode([versionDrift("upstream")], [safeRec("a:vd")])).toBe(2);
  });

  it("version-drift with ahead=installed is NOT actionable → exit 0", () => {
    // Installed-newer-than-upstream is informational only; planner doesn't
    // emit a runnable rec for this case.
    expect(computeExitCode([versionDrift("installed")], [])).toBe(0);
  });

  it("version-drift with ahead=incomparable is NOT actionable → exit 0", () => {
    expect(computeExitCode([versionDrift("incomparable")], [])).toBe(0);
  });

  it("refresh-needed alone exits 2 (regression guard for the existing trap path)", () => {
    expect(computeExitCode([refreshNeeded()], [safeRec("a:rn")])).toBe(2);
  });

  it("subsumption case: refresh-needed + version-drift on same plugin still exits 2", () => {
    // Planner drops version-drift when a higher-fidelity trap already covers
    // the plugin (recommendations/plan.ts:122-132). The exit-code path sees
    // both drifts and must not double-count or change the verdict.
    expect(computeExitCode([refreshNeeded(), versionDrift("upstream")], [safeRec("a:rn")])).toBe(2);
  });

  it("runtime-boundary alone is NOT actionable → exit 0", () => {
    // runtime-boundary is an advisory; it never drives exit code on its own.
    expect(computeExitCode([runtimeBoundary()], [])).toBe(0);
  });

  it("destructive recommendation lifts to exit 3 when an actionable drift exists", () => {
    expect(
      computeExitCode([refreshNeeded()], [{ ...safeRec("a:dest"), risk: "destructive" }]),
    ).toBe(3);
  });

  it("manual-no-cmd recommendation lifts to exit 3", () => {
    expect(
      computeExitCode(
        [refreshNeeded()],
        [{ ...safeRec("a:m"), requiresManualStep: true, cmd: undefined }],
      ),
    ).toBe(3);
  });

  it("no drifts → exit 0", () => {
    expect(computeExitCode([], [])).toBe(0);
  });
});
