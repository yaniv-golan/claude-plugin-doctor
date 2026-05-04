import { describe, expect, it } from "vitest";
import { detectSkillsPluginStuck } from "../../../../src/drift/traps/skills-plugin-stuck.js";
import type { CacheSnapshot } from "../../../../src/types.js";

type SkillsPluginSnapshot = Extract<CacheSnapshot, { layer: "skills_plugin" }>;

function makeSnapshot(
  stuckFailureSignature: boolean,
  skillName = "my-skill",
): SkillsPluginSnapshot {
  return {
    layer: "skills_plugin",
    rootRef: { kind: "cowork", accountId: "acc1", orgId: "org1" },
    subject: {
      kind: "skill",
      pair: { orgId: "org1", accountId: "acc1" },
      skillName,
    },
    presence: "present",
    evidencePaths: ["/some/path"],
    parsedAt: new Date().toISOString(),
    data: {
      kind: "skills_plugin",
      pair: { orgId: "org1", accountId: "acc1", rootPath: "/some/path" },
      skill: {
        name: skillName,
        dirPath: `/some/path/${skillName}`,
        hasSkillMd: true,
        dirMtime: Date.now() - 10_000,
        manifestUpdatedAt: new Date().toISOString(),
      },
      stuckFailureSignature,
    },
  };
}

describe("detectSkillsPluginStuck", () => {
  it("returns trap when stuckFailureSignature is true", () => {
    const snap = makeSnapshot(true, "broken-skill");
    const result = detectSkillsPluginStuck(snap);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("skills-plugin-stuck");
    expect(result?.skill).toBe("broken-skill");
    expect(result?.subject).toEqual({
      kind: "root",
      ref: { kind: "cowork", accountId: "acc1", orgId: "org1" },
    });
  });

  it("returns null when stuckFailureSignature is false", () => {
    const snap = makeSnapshot(false);
    const result = detectSkillsPluginStuck(snap);
    expect(result).toBeNull();
  });

  it("preserves the rootRef from the snapshot", () => {
    const snap: SkillsPluginSnapshot = {
      ...makeSnapshot(true),
      rootRef: { kind: "ccd" },
    };
    const result = detectSkillsPluginStuck(snap);
    expect(result?.subject.ref).toEqual({ kind: "ccd" });
  });
});
