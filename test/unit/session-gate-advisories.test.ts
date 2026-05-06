/**
 * Tests for `buildSessionGateAdvisories` from `src/commands/scan.ts` —
 * the function that converts topology session-config data into
 * `session-plugins-disabled-detected` / `session-skills-disabled-detected` /
 * `session-config-enumeration-truncated` advisories.
 *
 * Covers the sparse-optional denominator framing (reviewer #5), the
 * lastActivityAt-desc sort for `exampleSessionIds`, and the
 * archived-vs-active partitioning.
 */

import { describe, expect, it } from "vitest";
import { buildSessionGateAdvisories } from "../../src/commands/scan.js";
import type { CoworkRoot, SessionConfig, Topology } from "../../src/types.js";

function topology(coworkRoots: CoworkRoot[]): Topology {
  return {
    cowork: coworkRoots,
    sessionLocals: [],
    scannedAt: "2026-05-06T00:00:00Z",
  };
}

function coworkRoot(
  configs: SessionConfig[],
  opts: {
    sessionConfigsTruncated?: boolean;
    sessionConfigsTotalScanned?: number;
    accountId?: string;
    orgId?: string;
    rootPath?: string;
  } = {},
): CoworkRoot {
  return {
    accountId: opts.accountId ?? "acc1",
    orgId: opts.orgId ?? "org1",
    rootPath: opts.rootPath ?? "/fake/cowork/acc1/org1",
    hasCoworkPlugins: true,
    hasRpm: false,
    isMostRecent: true,
    marketplaces: [],
    sessionConfigs: configs,
    ...(opts.sessionConfigsTruncated ? { sessionConfigsTruncated: true } : {}),
    ...(opts.sessionConfigsTotalScanned !== undefined
      ? { sessionConfigsTotalScanned: opts.sessionConfigsTotalScanned }
      : {}),
  };
}

describe("buildSessionGateAdvisories", () => {
  it("emits no advisories when no cowork roots have any disabled sessions", () => {
    const t = topology([
      coworkRoot([
        { filePath: "/x/local_a.json", sessionId: "a", pluginsEnabled: true, skillsEnabled: true },
        { filePath: "/x/local_b.json", sessionId: "b" }, // no flags
      ]),
    ]);
    expect(buildSessionGateAdvisories(t)).toEqual([]);
  });

  it("emits session-plugins-disabled-detected when ≥1 non-archived session has pluginsEnabled=false", () => {
    const t = topology([
      coworkRoot([
        {
          filePath: "/x/local_a.json",
          sessionId: "a",
          pluginsEnabled: false,
          isArchived: false,
          lastActivityAt: "2026-05-06T10:00:00Z",
        },
      ]),
    ]);
    const advisories = buildSessionGateAdvisories(t);
    const adv = advisories.find((a) => a.id === "session-plugins-disabled-detected");
    expect(adv).toBeDefined();
    if (adv?.id !== "session-plugins-disabled-detected") {
      throw new Error("type narrowing");
    }
    expect(adv.details.disabledSessions).toBe(1);
    expect(adv.details.sessionsWithFieldSet).toBe(1);
    expect(adv.details.totalScanned).toBe(1);
    expect(adv.details.exampleSessionIds).toEqual(["a"]);
    expect(adv.details.archivedDisabledCount).toBe(0);
  });

  it("does NOT emit session-plugins-disabled-detected when only archived sessions are disabled", () => {
    const t = topology([
      coworkRoot([
        {
          filePath: "/x/local_a.json",
          sessionId: "a",
          pluginsEnabled: false,
          isArchived: true,
        },
      ]),
    ]);
    const advisories = buildSessionGateAdvisories(t);
    expect(advisories.find((a) => a.id === "session-plugins-disabled-detected")).toBeUndefined();
  });

  it("counts archived disabled sessions in archivedDisabledCount when active disabled sessions also exist", () => {
    const t = topology([
      coworkRoot([
        {
          filePath: "/x/local_a.json",
          sessionId: "a",
          pluginsEnabled: false,
          isArchived: false,
          lastActivityAt: "2026-05-06T10:00:00Z",
        },
        {
          filePath: "/x/local_b.json",
          sessionId: "b",
          pluginsEnabled: false,
          isArchived: true,
        },
      ]),
    ]);
    const advisories = buildSessionGateAdvisories(t);
    const adv = advisories.find((a) => a.id === "session-plugins-disabled-detected");
    if (adv?.id !== "session-plugins-disabled-detected") {
      throw new Error("type narrowing");
    }
    expect(adv.details.disabledSessions).toBe(1);
    expect(adv.details.archivedDisabledCount).toBe(1);
  });

  it("denominator is sessionsWithFieldSet, not totalScanned (reviewer #5 framing)", () => {
    const t = topology([
      coworkRoot([
        // 1 with field set + disabled
        {
          filePath: "/x/local_a.json",
          sessionId: "a",
          pluginsEnabled: false,
          lastActivityAt: "2026-05-06T10:00:00Z",
        },
        // 5 without the field at all (default-on)
        { filePath: "/x/local_b.json", sessionId: "b" },
        { filePath: "/x/local_c.json", sessionId: "c" },
        { filePath: "/x/local_d.json", sessionId: "d" },
        { filePath: "/x/local_e.json", sessionId: "e" },
        { filePath: "/x/local_f.json", sessionId: "f" },
      ]),
    ]);
    const advisories = buildSessionGateAdvisories(t);
    const adv = advisories.find((a) => a.id === "session-plugins-disabled-detected");
    if (adv?.id !== "session-plugins-disabled-detected") {
      throw new Error("type narrowing");
    }
    expect(adv.details.totalScanned).toBe(6);
    expect(adv.details.sessionsWithFieldSet).toBe(1);
    expect(adv.details.disabledSessions).toBe(1);
  });

  it("exampleSessionIds is the 3 most-recent disabled sessions, sorted by lastActivityAt desc", () => {
    const t = topology([
      coworkRoot([
        {
          filePath: "/x/local_old.json",
          sessionId: "old",
          pluginsEnabled: false,
          lastActivityAt: "2024-01-01T00:00:00Z",
        },
        {
          filePath: "/x/local_new.json",
          sessionId: "new",
          pluginsEnabled: false,
          lastActivityAt: "2026-05-06T00:00:00Z",
        },
        {
          filePath: "/x/local_mid1.json",
          sessionId: "mid1",
          pluginsEnabled: false,
          lastActivityAt: "2025-06-15T12:00:00Z",
        },
        {
          filePath: "/x/local_mid2.json",
          sessionId: "mid2",
          pluginsEnabled: false,
          lastActivityAt: "2025-06-15T13:00:00Z",
        },
        {
          filePath: "/x/local_mid3.json",
          sessionId: "mid3",
          pluginsEnabled: false,
          lastActivityAt: "2025-06-15T14:00:00Z",
        },
      ]),
    ]);
    const advisories = buildSessionGateAdvisories(t);
    const adv = advisories.find((a) => a.id === "session-plugins-disabled-detected");
    if (adv?.id !== "session-plugins-disabled-detected") {
      throw new Error("type narrowing");
    }
    expect(adv.details.exampleSessionIds).toEqual(["new", "mid3", "mid2"]);
    expect(adv.details.disabledSessions).toBe(5);
    expect(adv.message).toMatch(/\(\+2 more\)/);
  });

  it("emits both pluginsEnabled and skillsEnabled advisories independently", () => {
    const t = topology([
      coworkRoot([
        {
          filePath: "/x/local_a.json",
          sessionId: "a",
          pluginsEnabled: false,
          skillsEnabled: false,
          lastActivityAt: "2026-05-06T00:00:00Z",
        },
      ]),
    ]);
    const advisories = buildSessionGateAdvisories(t);
    expect(advisories.map((a) => a.id).sort()).toEqual([
      "session-plugins-disabled-detected",
      "session-skills-disabled-detected",
    ]);
  });

  it("emits session-config-enumeration-truncated when a cowork root has the truncation flag", () => {
    const t = topology([
      coworkRoot([], {
        sessionConfigsTruncated: true,
        sessionConfigsTotalScanned: 2500,
        rootPath: "/fake/cowork/heavy",
      }),
    ]);
    const advisories = buildSessionGateAdvisories(t);
    const trunc = advisories.find((a) => a.id === "session-config-enumeration-truncated");
    expect(trunc).toBeDefined();
    if (trunc?.id !== "session-config-enumeration-truncated") {
      throw new Error("type narrowing");
    }
    expect(trunc.details.coworkRootPath).toBe("/fake/cowork/heavy");
    expect(trunc.details.capacity).toBe(2048);
  });

  it("emits no advisories on empty topology (no cowork roots)", () => {
    const t = topology([]);
    expect(buildSessionGateAdvisories(t)).toEqual([]);
  });
});
