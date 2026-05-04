/**
 * Tests for `snapshotSkillsPluginPair` — tier C skills-plugin layer.
 *
 * All tests use synthetic tmpdirs; no network, no git, no Claude Desktop.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotSkillsPluginPair } from "../../../src/caches/skills-plugin.js";
import type { SkillsPluginPair } from "../../../src/types.js";

function writeJson(p: string, data: unknown) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
}

function makePair(opts: {
  rootPath: string;
  orgId?: string;
  accountId?: string;
  skills?: Array<{
    skillName: string;
    hasSkillMd: boolean;
    dirMtime?: number;
  }>;
  manifestPath?: string;
  manifestMtime?: number;
}): SkillsPluginPair {
  const orgId = opts.orgId ?? "org1";
  const accountId = opts.accountId ?? "acc1";
  const skills = (opts.skills ?? []).map((s) => ({
    skillName: s.skillName,
    dirPath: path.join(opts.rootPath, "skills", s.skillName),
    hasSkillMd: s.hasSkillMd,
    ...(s.dirMtime !== undefined ? { dirMtime: s.dirMtime } : {}),
  }));
  return {
    orgId,
    accountId,
    rootPath: opts.rootPath,
    skills,
    ...(opts.manifestPath !== undefined ? { manifestPath: opts.manifestPath } : {}),
    ...(opts.manifestMtime !== undefined ? { manifestMtime: opts.manifestMtime } : {}),
  };
}

describe("snapshotSkillsPluginPair", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-skills-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns empty array when pair has no skills", () => {
    const pair = makePair({ rootPath: tmp });
    const snapshots = snapshotSkillsPluginPair({ pair, skillsPluginRootPath: tmp });
    expect(snapshots).toHaveLength(0);
  });

  it("presence:present when skill dir has SKILL.md", () => {
    const skillDir = path.join(tmp, "skills", "pdf");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# PDF");

    const pair = makePair({
      rootPath: tmp,
      skills: [{ skillName: "pdf", hasSkillMd: true, dirMtime: Date.now() - 60_000 }],
    });

    const snapshots = snapshotSkillsPluginPair({ pair, skillsPluginRootPath: tmp });
    expect(snapshots).toHaveLength(1);
    const snap = snapshots[0] as NonNullable<(typeof snapshots)[0]>;
    expect(snap.layer).toBe("skills_plugin");
    expect(snap.presence).toBe("present");
    expect(snap.data.kind).toBe("skills_plugin");
    expect(snap.data.skill.name).toBe("pdf");
    expect(snap.data.skill.hasSkillMd).toBe(true);
    expect(snap.data.stuckFailureSignature).toBe(false);
    expect(snap.subject).toMatchObject({ kind: "skill", skillName: "pdf" });
    expect(snap.rootRef).toMatchObject({ kind: "skills-plugin-pair" });
  });

  it("presence:absent when skill dir exists without SKILL.md", () => {
    const skillDir = path.join(tmp, "skills", "xlsx");
    fs.mkdirSync(skillDir, { recursive: true });
    // Intentionally do NOT create SKILL.md

    const pair = makePair({
      rootPath: tmp,
      skills: [{ skillName: "xlsx", hasSkillMd: false, dirMtime: Date.now() - 60_000 }],
    });

    const snapshots = snapshotSkillsPluginPair({ pair, skillsPluginRootPath: tmp });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.presence).toBe("absent");
  });

  it("presence:absent when skill dir does not exist", () => {
    // Tier A enumerated skill but it disappeared mid-scan (defensive case).
    const pair = makePair({
      rootPath: tmp,
      skills: [{ skillName: "vanished", hasSkillMd: false }],
    });
    // Do NOT create the skill dir

    const snapshots = snapshotSkillsPluginPair({ pair, skillsPluginRootPath: tmp });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.presence).toBe("absent");
  });

  it("stuckFailureSignature:false when no manifest", () => {
    const skillDir = path.join(tmp, "skills", "pdf");
    fs.mkdirSync(skillDir, { recursive: true });
    // No SKILL.md (so we'd normally flag stuck if manifest said recent)

    const pair = makePair({
      rootPath: tmp,
      skills: [{ skillName: "pdf", hasSkillMd: false }],
      // no manifestPath
    });

    const snapshots = snapshotSkillsPluginPair({ pair, skillsPluginRootPath: tmp });
    expect(snapshots[0]?.data.stuckFailureSignature).toBe(false);
    expect(snapshots[0]?.data.skill.manifestUpdatedAt).toBeUndefined();
  });

  it("stuckFailureSignature:true when manifest claims recent update but SKILL.md missing", () => {
    const skillDir = path.join(tmp, "skills", "pdf");
    fs.mkdirSync(skillDir, { recursive: true });
    // No SKILL.md

    const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago
    const manifestPath = path.join(tmp, "skills_plugin_manifest.json");
    writeJson(manifestPath, {
      pdf: { updatedAt: recentDate },
    });

    const pair = makePair({
      rootPath: tmp,
      skills: [{ skillName: "pdf", hasSkillMd: false }],
      manifestPath,
    });

    const snapshots = snapshotSkillsPluginPair({ pair, skillsPluginRootPath: tmp });
    const snap = snapshots[0] as NonNullable<(typeof snapshots)[0]>;
    expect(snap.data.skill.manifestUpdatedAt).toBe(recentDate);
    expect(snap.data.stuckFailureSignature).toBe(true);
  });

  it("stuckFailureSignature:true when dir mtime is much older than manifest's recent update", () => {
    const skillDir = path.join(tmp, "skills", "pdf");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# PDF");

    const now = Date.now();
    const recentDate = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago
    const staleMs = now - 5 * 24 * 60 * 60 * 1000; // dirMtime 5 days ago (> 24h behind manifest)

    const manifestPath = path.join(tmp, "skills_plugin_manifest.json");
    writeJson(manifestPath, {
      pdf: { updatedAt: recentDate },
    });

    const pair = makePair({
      rootPath: tmp,
      skills: [{ skillName: "pdf", hasSkillMd: true, dirMtime: staleMs }],
      manifestPath,
    });

    const snapshots = snapshotSkillsPluginPair({
      pair,
      skillsPluginRootPath: tmp,
      staleThresholdMs: 24 * 60 * 60 * 1000, // 24h
    });
    expect(snapshots[0]?.data.stuckFailureSignature).toBe(true);
  });

  it("stuckFailureSignature:false when dir mtime is fresh relative to manifest", () => {
    const skillDir = path.join(tmp, "skills", "pdf");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# PDF");

    const now = Date.now();
    const recentDate = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago
    const freshDirMtime = now - 1 * 60 * 60 * 1000; // dir 1h ago — fresher than threshold

    const manifestPath = path.join(tmp, "skills_plugin_manifest.json");
    writeJson(manifestPath, {
      pdf: { updatedAt: recentDate },
    });

    const pair = makePair({
      rootPath: tmp,
      skills: [{ skillName: "pdf", hasSkillMd: true, dirMtime: freshDirMtime }],
      manifestPath,
    });

    const snapshots = snapshotSkillsPluginPair({
      pair,
      skillsPluginRootPath: tmp,
      staleThresholdMs: 24 * 60 * 60 * 1000,
    });
    expect(snapshots[0]?.data.stuckFailureSignature).toBe(false);
  });

  it("stuckFailureSignature:false when manifest is old (outside recent window)", () => {
    const skillDir = path.join(tmp, "skills", "pdf");
    fs.mkdirSync(skillDir, { recursive: true });
    // No SKILL.md — would be stuck IF manifest was recent

    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
    const manifestPath = path.join(tmp, "skills_plugin_manifest.json");
    writeJson(manifestPath, {
      pdf: { updatedAt: oldDate },
    });

    const pair = makePair({
      rootPath: tmp,
      skills: [{ skillName: "pdf", hasSkillMd: false }],
      manifestPath,
    });

    const snapshots = snapshotSkillsPluginPair({
      pair,
      skillsPluginRootPath: tmp,
      recentWindowDays: 14, // 14-day window; 30-day-old manifest is outside
    });
    expect(snapshots[0]?.data.stuckFailureSignature).toBe(false);
  });

  it("returns multiple snapshots when manifest has multiple skills", () => {
    const skills = ["pdf", "xlsx", "csv"];
    for (const name of skills) {
      const skillDir = path.join(tmp, "skills", name);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), `# ${name}`);
    }

    const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const manifestPath = path.join(tmp, "skills_plugin_manifest.json");
    writeJson(manifestPath, {
      pdf: { updatedAt: recentDate },
      xlsx: { updatedAt: recentDate },
      csv: { updatedAt: recentDate },
    });

    const pair = makePair({
      rootPath: tmp,
      skills: skills.map((name) => ({
        skillName: name,
        hasSkillMd: true,
        dirMtime: Date.now() - 30 * 60 * 1000, // 30 min ago — fresh
      })),
      manifestPath,
    });

    const snapshots = snapshotSkillsPluginPair({ pair, skillsPluginRootPath: tmp });
    expect(snapshots).toHaveLength(3);
    const names = snapshots.map((s) => s.data.skill.name).sort();
    expect(names).toEqual(["csv", "pdf", "xlsx"]);
  });

  it("handles lastUpdated as alternative field name for manifest timestamp", () => {
    const skillDir = path.join(tmp, "skills", "pdf");
    fs.mkdirSync(skillDir, { recursive: true });
    // No SKILL.md

    const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const manifestPath = path.join(tmp, "skills_plugin_manifest.json");
    writeJson(manifestPath, {
      pdf: { lastUpdated: recentDate }, // alternative field name
    });

    const pair = makePair({
      rootPath: tmp,
      skills: [{ skillName: "pdf", hasSkillMd: false }],
      manifestPath,
    });

    const snapshots = snapshotSkillsPluginPair({ pair, skillsPluginRootPath: tmp });
    expect(snapshots[0]?.data.skill.manifestUpdatedAt).toBe(recentDate);
    expect(snapshots[0]?.data.stuckFailureSignature).toBe(true);
  });

  it("handles malformed manifest gracefully (stuckFailureSignature:false)", () => {
    const skillDir = path.join(tmp, "skills", "pdf");
    fs.mkdirSync(skillDir, { recursive: true });

    const manifestPath = path.join(tmp, "skills_plugin_manifest.json");
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, "not valid json }{");

    const pair = makePair({
      rootPath: tmp,
      skills: [{ skillName: "pdf", hasSkillMd: false }],
      manifestPath,
    });

    const snapshots = snapshotSkillsPluginPair({ pair, skillsPluginRootPath: tmp });
    expect(snapshots[0]?.data.skill.manifestUpdatedAt).toBeUndefined();
    expect(snapshots[0]?.data.stuckFailureSignature).toBe(false);
  });

  it("snapshot shape: evidencePaths includes skill dir and manifest when present", () => {
    const skillDir = path.join(tmp, "skills", "pdf");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# PDF");

    const manifestPath = path.join(tmp, "skills_plugin_manifest.json");
    writeJson(manifestPath, { pdf: { updatedAt: new Date().toISOString() } });

    const pair = makePair({
      rootPath: tmp,
      skills: [{ skillName: "pdf", hasSkillMd: true, dirMtime: Date.now() - 1000 }],
      manifestPath,
    });

    const snapshots = snapshotSkillsPluginPair({ pair, skillsPluginRootPath: tmp });
    const snap = snapshots[0] as NonNullable<(typeof snapshots)[0]>;
    expect(snap.evidencePaths).toContain(skillDir);
    expect(snap.evidencePaths).toContain(manifestPath);
  });

  it("parsedAt is an ISO date string", () => {
    const skillDir = path.join(tmp, "skills", "pdf");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# PDF");

    const pair = makePair({
      rootPath: tmp,
      skills: [{ skillName: "pdf", hasSkillMd: true }],
    });

    const snapshots = snapshotSkillsPluginPair({ pair, skillsPluginRootPath: tmp });
    expect(() => new Date(snapshots[0]?.parsedAt)).not.toThrow();
    expect(new Date(snapshots[0]?.parsedAt).toISOString()).toBe(snapshots[0]?.parsedAt);
  });
});
