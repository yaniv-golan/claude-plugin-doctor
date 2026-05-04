import { describe, expect, it } from "vitest";
import { detectResolverDisagreement } from "../../../src/drift/disagreement.js";
import type {
  CliUpdateSim,
  DesktopBadgeSim,
  PluginRef,
  SessionStartSim,
} from "../../../src/types.js";

const pluginRef: PluginRef = {
  pluginName: "test-plugin",
  marketplace: "test-mp",
  root: { kind: "ccd" },
};

function makeCli(resolvedVersion?: string, unknowable?: boolean): CliUpdateSim {
  return {
    resolvedFrom: "plugin.json-in-clone",
    ...(resolvedVersion !== undefined && { resolvedVersion }),
    ...(unknowable && { unknowable: { reason: "upstream-unreachable" } }),
    evidence: { pluginEntrySourceKind: "string" },
  };
}

function makeBadge(resolvedVersion?: string, unknowable?: boolean): DesktopBadgeSim {
  return {
    resolvedFrom: "plugin.json-in-clone",
    ...(resolvedVersion !== undefined && { resolvedVersion }),
    ...(unknowable && { unknowable: { reason: "upstream-unreachable" } }),
    evidence: { pluginEntrySourceKind: "string" },
  };
}

function makeSession(resolvedVersion?: string, unknowable?: boolean): SessionStartSim {
  return {
    ...(resolvedVersion !== undefined && { resolvedVersion }),
    ...(unknowable && { unknowable: { reason: "not-installed" } }),
  };
}

describe("detectResolverDisagreement — all agree", () => {
  it("returns null when all three sims have the same version", () => {
    const result = detectResolverDisagreement({
      pluginRef,
      cli: makeCli("1.0.0"),
      badge: makeBadge("1.0.0"),
      sessionStart: makeSession("1.0.0"),
    });
    expect(result).toBeNull();
  });
});

describe("detectResolverDisagreement — disagreements", () => {
  it("detects cliVsBadge disagreement", () => {
    const result = detectResolverDisagreement({
      pluginRef,
      cli: makeCli("2.0.0"),
      badge: makeBadge("1.0.0"),
      sessionStart: makeSession("2.0.0"),
    });
    expect(result).not.toBeNull();
    expect(result?.pairs.cliVsBadge).toBe("disagree");
    expect(result?.pairs.cliVsSession).toBe("agree");
    expect(result?.pairs.badgeVsSession).toBe("disagree");
  });

  it("detects cliVsSession disagreement", () => {
    const result = detectResolverDisagreement({
      pluginRef,
      cli: makeCli("2.0.0"),
      badge: makeBadge("2.0.0"),
      sessionStart: makeSession("1.0.0"),
    });
    expect(result).not.toBeNull();
    expect(result?.pairs.cliVsBadge).toBe("agree");
    expect(result?.pairs.cliVsSession).toBe("disagree");
    expect(result?.pairs.badgeVsSession).toBe("disagree");
  });

  it("detects badgeVsSession disagreement", () => {
    const result = detectResolverDisagreement({
      pluginRef,
      cli: makeCli("1.0.0"),
      badge: makeBadge("2.0.0"),
      sessionStart: makeSession("2.0.0"),
    });
    expect(result).not.toBeNull();
    expect(result?.pairs.cliVsBadge).toBe("disagree");
    expect(result?.pairs.cliVsSession).toBe("disagree");
    expect(result?.pairs.badgeVsSession).toBe("agree");
  });
});

describe("detectResolverDisagreement — indeterminate", () => {
  it("marks pair as indeterminate when one sim has unknowable", () => {
    const result = detectResolverDisagreement({
      pluginRef,
      cli: makeCli(undefined, true),
      badge: makeBadge("1.0.0"),
      sessionStart: makeSession("1.0.0"),
    });
    expect(result).not.toBeNull();
    expect(result?.pairs.cliVsBadge).toBe("indeterminate");
    expect(result?.pairs.cliVsSession).toBe("indeterminate");
    expect(result?.pairs.badgeVsSession).toBe("agree");
  });

  it("marks pair as indeterminate when one sim has no resolved version", () => {
    const result = detectResolverDisagreement({
      pluginRef,
      cli: makeCli("1.0.0"),
      badge: makeBadge(undefined), // no version
      sessionStart: makeSession("1.0.0"),
    });
    expect(result).not.toBeNull();
    expect(result?.pairs.cliVsBadge).toBe("indeterminate");
    expect(result?.pairs.badgeVsSession).toBe("indeterminate");
  });

  it("all three indeterminate → returns a ResolverDisagreement (not null)", () => {
    const result = detectResolverDisagreement({
      pluginRef,
      cli: makeCli(undefined, true),
      badge: makeBadge(undefined, true),
      sessionStart: makeSession(undefined, true),
    });
    // indeterminate is not "agree", so should not return null
    expect(result).not.toBeNull();
  });

  it("carries the original sim objects in the result", () => {
    const cli = makeCli("2.0.0");
    const badge = makeBadge("1.0.0");
    const session = makeSession("2.0.0");
    const result = detectResolverDisagreement({ pluginRef, cli, badge, sessionStart: session });
    expect(result?.cli).toBe(cli);
    expect(result?.badge).toBe(badge);
    expect(result?.sessionStart).toBe(session);
  });
});
