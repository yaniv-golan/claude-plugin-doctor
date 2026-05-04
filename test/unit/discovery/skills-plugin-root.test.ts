import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSkillsPluginRoot } from "../../../src/discovery/skills-plugin-root.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-skp-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function ctx() {
  return { platform: "darwin" as NodeJS.Platform, home: tmp };
}

/** <userData>/local-agent-mode-sessions/skills-plugin/ */
function skillsPluginDir(): string {
  return path.join(
    tmp,
    "Library",
    "Application Support",
    "Claude",
    "local-agent-mode-sessions",
    "skills-plugin",
  );
}

describe("discoverSkillsPluginRoot", () => {
  it("returns undefined on non-darwin platform", () => {
    expect(discoverSkillsPluginRoot({ platform: "linux", home: tmp })).toBeUndefined();
  });

  it("returns undefined when skills-plugin/ does not exist", () => {
    expect(discoverSkillsPluginRoot(ctx())).toBeUndefined();
  });

  it("returns a root with empty pairs when skills-plugin/ is empty", () => {
    fs.mkdirSync(skillsPluginDir(), { recursive: true });
    const result = discoverSkillsPluginRoot(ctx());
    expect(result).not.toBeUndefined();
    expect(result?.rootPath).toBe(skillsPluginDir());
    expect(result?.pairs).toEqual([]);
  });

  it("uses inverted orgId/accountId order (org first, account second)", () => {
    const spDir = skillsPluginDir();
    // Skills-plugin tree: skills-plugin/<orgId>/<accountId>/
    fs.mkdirSync(path.join(spDir, "org-abc", "acc-xyz"), { recursive: true });

    const result = discoverSkillsPluginRoot(ctx());
    expect(result?.pairs).toHaveLength(1);
    const pair = result?.pairs[0];
    // orgId is the first segment, accountId is the second.
    expect(pair?.orgId).toBe("org-abc");
    expect(pair?.accountId).toBe("acc-xyz");
  });

  it("enumerates skills under the skills/ subdirectory", () => {
    const spDir = skillsPluginDir();
    const pairDir = path.join(spDir, "org1", "acc1");
    const skillA = path.join(pairDir, "skills", "pdf");
    const skillB = path.join(pairDir, "skills", "xlsx");
    fs.mkdirSync(path.join(skillA), { recursive: true });
    fs.mkdirSync(path.join(skillB), { recursive: true });
    // pdf has a SKILL.md; xlsx does not.
    fs.writeFileSync(path.join(skillA, "SKILL.md"), "# PDF\n");

    const result = discoverSkillsPluginRoot(ctx());
    const pair = result?.pairs[0];
    expect(pair?.skills).toHaveLength(2);

    const byName = Object.fromEntries((pair?.skills ?? []).map((s) => [s.skillName, s]));
    expect(byName.pdf?.hasSkillMd).toBe(true);
    expect(byName.xlsx?.hasSkillMd).toBe(false);
  });

  it("populates dirPath and dirMtime for each skill", () => {
    const spDir = skillsPluginDir();
    const pairDir = path.join(spDir, "org1", "acc1");
    const skillDir = path.join(pairDir, "skills", "pdf");
    fs.mkdirSync(skillDir, { recursive: true });

    const result = discoverSkillsPluginRoot(ctx());
    const skill = result?.pairs[0]?.skills[0];
    expect(skill?.dirPath).toBe(skillDir);
    expect(typeof skill?.dirMtime).toBe("number");
  });

  it("sets manifestPath and manifestMtime when skills_plugin_manifest.json exists", () => {
    const spDir = skillsPluginDir();
    const pairDir = path.join(spDir, "org1", "acc1");
    fs.mkdirSync(pairDir, { recursive: true });
    fs.writeFileSync(path.join(pairDir, "skills_plugin_manifest.json"), JSON.stringify({}));

    const result = discoverSkillsPluginRoot(ctx());
    const pair = result?.pairs[0];
    expect(pair?.manifestPath).toBe(path.join(pairDir, "skills_plugin_manifest.json"));
    expect(typeof pair?.manifestMtime).toBe("number");
  });

  it("leaves manifestPath undefined when skills_plugin_manifest.json is absent", () => {
    const spDir = skillsPluginDir();
    fs.mkdirSync(path.join(spDir, "org1", "acc1"), { recursive: true });

    const result = discoverSkillsPluginRoot(ctx());
    const pair = result?.pairs[0];
    expect(pair?.manifestPath).toBeUndefined();
    expect(pair?.manifestMtime).toBeUndefined();
  });

  it("does NOT parse manifest content (tier A stat only)", () => {
    const spDir = skillsPluginDir();
    const pairDir = path.join(spDir, "org1", "acc1");
    fs.mkdirSync(pairDir, { recursive: true });
    // Write intentionally malformed manifest — if tier A parsed it, this would throw.
    fs.writeFileSync(path.join(pairDir, "skills_plugin_manifest.json"), "{ not valid json");

    // Should not throw — tier A just stats the file.
    expect(() => discoverSkillsPluginRoot(ctx())).not.toThrow();
  });

  it("handles multiple org/account pairs", () => {
    const spDir = skillsPluginDir();
    fs.mkdirSync(path.join(spDir, "org1", "acc1"), { recursive: true });
    fs.mkdirSync(path.join(spDir, "org1", "acc2"), { recursive: true });
    fs.mkdirSync(path.join(spDir, "org2", "acc1"), { recursive: true });

    const result = discoverSkillsPluginRoot(ctx());
    expect(result?.pairs).toHaveLength(3);
  });
});
