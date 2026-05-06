/**
 * Gap-fix / gist-adoption tests for v1.0.0-.
 *
 * Covers the 11 items from PLAN-gist-adoption.md:
 *  1.1 - RpmReport.marketplaceId (array-form + object-keyed)
 *  2.1 - alias-differs note rewrite (new framing)
 *  2.2 - cpd explain three-namespace section
 *  3.1 - cross-layer invariant: no claude plugin update cmd on RPM-installed plugin
 *  4.1 - multi-match disambiguation in runV05Check (+ json shape)
 *  4.2 - source URL evidence line in alias-differs note
 *  4.3 - cross-store + intra-store collision annotations in cpd list (+ json shape)
 *  5.1 - managed scope recognized + Desktop-dropped note
 *  5.2 - BUILTIN_SKILLS exemption in stuckFailureSignature
 *  5.3 - skills-plugin-stuck recommendation text update
 *  5.4 - skills-plugin section in cpd list + (built-in) annotation
 *  5.5 - object-source bump-needed 5-step fix + string-source regression
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { snapshotSkillsPluginPair } from "../../src/caches/skills-plugin.js";
import { runExplain } from "../../src/commands/explain.js";
import { runList } from "../../src/commands/list.js";
import { parseInstalledPlugins } from "../../src/installed-plugins.js";
import { formatManualSteps } from "../../src/output/cmd-format.js";
import { renderHumanList } from "../../src/output/human.js";
import { actionForDrift } from "../../src/recommendations/catalog.js";
import type { SkillsPluginPair } from "../../src/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function writeJson(p: string, data: unknown) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
}

// ── 1.1: RpmReport.marketplaceId ─────────────────────────────────────────────

describe("1.1 RpmReport.marketplaceId", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-rc4-rpm-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("array-form manifest: marketplaceId is surfaced in the scan result", async () => {
    // Build a minimal fixture with array-form RPM manifest carrying marketplaceId
    const plugins = path.join(tmp, ".claude", "plugins");
    fs.mkdirSync(plugins, { recursive: true });
    writeJson(path.join(plugins, "known_marketplaces.json"), {});
    writeJson(path.join(plugins, "installed_plugins.json"), { version: 2, plugins: {} });

    // Set up a cowork root
    const userData = path.join(tmp, "Library", "Application Support", "Claude");
    const acc = "acc1";
    const org = "org1";
    const coworkRoot = path.join(userData, "local-agent-mode-sessions", acc, org);
    const coworkPlugins = path.join(coworkRoot, "cowork_plugins");
    fs.mkdirSync(coworkPlugins, { recursive: true });
    writeJson(path.join(coworkPlugins, "known_marketplaces.json"), {});
    writeJson(path.join(coworkPlugins, "installed_plugins.json"), { version: 2, plugins: {} });

    const rpm = path.join(coworkRoot, "rpm");
    fs.mkdirSync(rpm, { recursive: true });
    writeJson(path.join(rpm, "manifest.json"), {
      plugins: [
        {
          id: "plugin_01ABC",
          name: "test-plugin",
          marketplaceName: "test-mp",
          marketplaceId: "marketplace_01K1Tj",
          installedBy: "user",
        },
      ],
    });

    const { runV05Scan } = await import("../../src/commands/scan.js");
    const result = await runV05Scan({
      home: tmp,
      platform: "darwin",
      env: { HOME: tmp },
      mode: "cowork",
      noNetwork: true,
      coworkAccount: acc,
      coworkOrg: org,
    });

    expect(result.rpmPlugins).toHaveLength(1);
    const rpm1 = result.rpmPlugins[0];
    expect(rpm1?.marketplaceId).toBe("marketplace_01K1Tj");
  });

  it("object-keyed manifest: marketplaceId is undefined (no artifact in render)", async () => {
    // Object-keyed manifests don't carry marketplaceId
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-rc4-rpm2-"));
    try {
      const plugins = path.join(tmp2, ".claude", "plugins");
      fs.mkdirSync(plugins, { recursive: true });
      writeJson(path.join(plugins, "known_marketplaces.json"), {});
      writeJson(path.join(plugins, "installed_plugins.json"), { version: 2, plugins: {} });

      const userData = path.join(tmp2, "Library", "Application Support", "Claude");
      const acc = "acc1";
      const org = "org1";
      const coworkRoot = path.join(userData, "local-agent-mode-sessions", acc, org);
      const coworkPlugins = path.join(coworkRoot, "cowork_plugins");
      fs.mkdirSync(coworkPlugins, { recursive: true });
      writeJson(path.join(coworkPlugins, "known_marketplaces.json"), {});
      writeJson(path.join(coworkPlugins, "installed_plugins.json"), { version: 2, plugins: {} });

      const rpm = path.join(coworkRoot, "rpm");
      fs.mkdirSync(rpm, { recursive: true });
      // Object-keyed form: no marketplaceId field
      writeJson(path.join(rpm, "manifest.json"), {
        plugins: {
          plugin_01OBJ: { installedBy: "user", updatedAt: "2026-01-01T00:00:00Z" },
        },
      });

      const { runV05Scan } = await import("../../src/commands/scan.js");
      const result = await runV05Scan({
        home: tmp2,
        platform: "darwin",
        env: { HOME: tmp2 },
        mode: "cowork",
        noNetwork: true,
        coworkAccount: acc,
        coworkOrg: org,
      });

      // marketplaceId should be undefined for object-keyed form
      expect(result.rpmPlugins).toHaveLength(1);
      const rpm1 = result.rpmPlugins[0];
      expect(rpm1?.marketplaceId).toBeUndefined();

      // JSON output should not include marketplaceId key at all (no artifact)
      const jsonStr = JSON.stringify(result.rpmPlugins[0]);
      expect(jsonStr).not.toContain("marketplaceId");
    } finally {
      fs.rmSync(tmp2, { recursive: true, force: true });
    }
  });
});

// ── 2.2: cpd explain three-namespace section ──────────────────────────────────

describe("2.2 cpd explain three-namespace section", () => {
  it("runExplain output contains the three-namespace section header", () => {
    const output = runExplain();
    expect(output).toMatch(/there are THREE of them|three.*namespace|Marketplace names.*THREE/i);
  });

  it("runExplain output describes all three marketplace identifier sources", () => {
    const output = runExplain();
    expect(output).toContain("Your local alias");
    expect(output).toContain("marketplace.json#name");
    expect(output).toContain("Cowork's backend name");
  });

  it("runExplain output includes the gist reference URL", () => {
    const output = runExplain();
    expect(output).toContain("gist.github.com/yaniv-golan");
  });
});

// ── 3.1: Cross-layer invariant: no claude plugin update on RPM plugin ─────────

describe("3.1 Cross-layer invariant: no claude plugin update cmd on RPM-installed plugin", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-rc4-invariant-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("no layer's CheckResult attaches claude plugin update cmd to an RPM-managed plugin", async () => {
    // Build fixture with both CCD installed_plugins entry AND cowork RPM entry
    // for the same plugin name — the scenario where the invariant could be violated.
    const plugins = path.join(tmp, ".claude", "plugins");
    fs.mkdirSync(plugins, { recursive: true });
    writeJson(path.join(plugins, "known_marketplaces.json"), {
      "my-mp": { source: { source: "github", repo: "owner/my-mp" } },
    });
    const installPath = path.join(plugins, "cache", "my-mp", "my-plugin", "1.0.0");
    fs.mkdirSync(installPath, { recursive: true });
    writeJson(path.join(plugins, "installed_plugins.json"), {
      version: 2,
      plugins: {
        "my-plugin@my-mp": [{ version: "1.0.0", installPath }],
      },
    });
    // Stale marketplace clone — this will trigger install_snapshot recommendations.
    const mpClone = path.join(plugins, "marketplaces", "my-mp", ".claude-plugin");
    fs.mkdirSync(mpClone, { recursive: true });
    writeJson(path.join(mpClone, "marketplace.json"), {
      plugins: [{ name: "my-plugin", version: "1.0.0", source: "plugins/my-plugin" }],
    });

    // Cowork root with RPM entry for the same plugin
    const userData = path.join(tmp, "Library", "Application Support", "Claude");
    const acc = "acc1";
    const org = "org1";
    const coworkRoot = path.join(userData, "local-agent-mode-sessions", acc, org);
    const coworkPlugins = path.join(coworkRoot, "cowork_plugins");
    fs.mkdirSync(coworkPlugins, { recursive: true });
    writeJson(path.join(coworkPlugins, "known_marketplaces.json"), {});
    writeJson(path.join(coworkPlugins, "installed_plugins.json"), { version: 2, plugins: {} });

    const rpm = path.join(coworkRoot, "rpm");
    fs.mkdirSync(rpm, { recursive: true });
    writeJson(path.join(rpm, "manifest.json"), {
      plugins: [
        {
          id: "plugin_01RPM",
          name: "my-plugin",
          marketplaceName: "my-mp",
          marketplaceId: "marketplace_01XYZ",
          installedBy: "user",
        },
      ],
    });

    const { runV05Scan } = await import("../../src/commands/scan.js");
    const result = await runV05Scan({
      home: tmp,
      platform: "darwin",
      env: { HOME: tmp },
      mode: "cowork",
      noNetwork: true,
      coworkAccount: acc,
      coworkOrg: org,
    });

    // The cross-layer invariant: for each RPM plugin, walk every layer's
    // CheckResult from every installed plugin and assert NO recommendation
    // attaches `claude plugin update <id>`.
    for (const rpmPlugin of result.rpmPlugins) {
      for (const installedPlugin of result.plugins) {
        for (const [_layer, check] of Object.entries(installedPlugin.checks)) {
          const cmd = (check as { recommendation?: { cmd?: string } }).recommendation?.cmd;
          if (cmd?.startsWith("claude plugin update ")) {
            // This is a violation: claude plugin update should not be recommended for RPM plugins
            // Check if this is actually for the RPM plugin (same name)
            const pluginNameInCmd = cmd.replace("claude plugin update ", "").split("@")[0];
            if (pluginNameInCmd === rpmPlugin.name) {
              throw new Error(
                `Invariant violated: layer "${_layer}" for RPM plugin "${rpmPlugin.name}" has cmd: "${cmd}"`,
              );
            }
          }
        }
      }
    }

    // If we get here, no violation was found.
    expect(result.rpmPlugins.length).toBeGreaterThan(0);
  });
});

// ── 5.1: managed scope ────────────────────────────────────────────────────────

describe("5.1 InstalledScope managed", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-rc4-scope-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("managed scope is parsed correctly (was 'unknown' before)", () => {
    const file = path.join(tmp, "installed_plugins.json");
    const installPath = path.join(tmp, "cache", "my-mp", "my-plugin", "1.0.0");
    fs.mkdirSync(installPath, { recursive: true });
    writeJson(file, {
      version: 2,
      plugins: {
        "my-plugin@my-mp": [{ version: "1.0.0", installPath, scope: "managed" }],
      },
    });
    const result = parseInstalledPlugins(file);
    expect(result.plugins).toHaveLength(1);
    const scope = result.plugins[0]?.scopes[0]?.scope;
    expect(scope).toBe("managed");
  });

  it("renderHumanList shows Desktop-dropped note for managed scope entry", async () => {
    const file = path.join(tmp, "installed_plugins.json");
    const installPath = path.join(tmp, "cache", "my-mp", "my-plugin", "1.0.0");
    fs.mkdirSync(installPath, { recursive: true });
    writeJson(file, {
      version: 2,
      plugins: {
        "my-plugin@my-mp": [{ version: "1.0.0", installPath, scope: "managed" }],
      },
    });

    const plugins = path.join(tmp, ".claude", "plugins");
    fs.mkdirSync(plugins, { recursive: true });
    writeJson(path.join(plugins, "known_marketplaces.json"), {});
    // Copy the file
    fs.cpSync(file, path.join(plugins, "installed_plugins.json"));

    const { runV05Scan } = await import("../../src/commands/scan.js");
    const result = await runV05Scan({
      home: tmp,
      platform: "darwin",
      env: { HOME: tmp },
      mode: "ccd",
      noNetwork: true,
    });

    const listReport = {
      schemaVersion: "1.0" as const,
      marketplaces: result.marketplaces,
      plugins: result.plugins,
      rpmPlugins: result.rpmPlugins,
      coworkRoots: result.coworkRoots,
      exitCode: result.exitCode,
      runId: result.runId,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
    };

    const out = renderHumanList(listReport, { color: false });
    expect(out).toContain("managed");
    expect(out).toMatch(/managed scope.*dropped by Desktop/i);
  });
});

// ── 5.2: BUILTIN_SKILLS exemption in stuckFailureSignature ───────────────────

describe("5.2 BUILTIN_SKILLS stuckFailureSignature exemption", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-rc4-builtin-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function makeSkillPair(skillName: string, rootPath: string): SkillsPluginPair {
    const skillDir = path.join(rootPath, "skills", skillName);
    fs.mkdirSync(skillDir, { recursive: true });
    // Do NOT create SKILL.md (to simulate a "stuck" condition).
    const manifestPath = path.join(rootPath, "manifest.json");
    // Write manifest with a recent update so stuckFailureSignature would normally fire.
    writeJson(manifestPath, {
      [skillName]: { updatedAt: new Date().toISOString() },
    });
    return {
      orgId: "org1",
      accountId: "acc1",
      rootPath,
      manifestPath,
      skills: [
        {
          skillName,
          dirPath: skillDir,
          hasSkillMd: false,
          dirMtime: Date.now() - 48 * 60 * 60 * 1000, // 48h old
        },
      ],
    };
  }

  for (const builtInName of ["schedule", "setup-cowork", "consolidate-memory"]) {
    it(`built-in "${builtInName}" is exempted from stuckFailureSignature`, () => {
      const pair = makeSkillPair(builtInName, tmp);
      const snaps = snapshotSkillsPluginPair({ pair, skillsPluginRootPath: tmp });
      expect(snaps).toHaveLength(1);
      const snap = snaps[0];
      expect(snap?.data.kind).toBe("skills_plugin");
      // Built-ins must NOT fire stuckFailureSignature
      expect((snap?.data as { stuckFailureSignature: boolean }).stuckFailureSignature).toBe(false);
    });
  }

  it("non-built-in skill (pdf) DOES fire stuckFailureSignature (regression)", () => {
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-rc4-builtin2-"));
    try {
      const pair = makeSkillPair("pdf", tmp2);
      const snaps = snapshotSkillsPluginPair({ pair, skillsPluginRootPath: tmp2 });
      expect(snaps).toHaveLength(1);
      const snap = snaps[0];
      // Non-built-in skills SHOULD still fire stuckFailureSignature
      expect((snap?.data as { stuckFailureSignature: boolean }).stuckFailureSignature).toBe(true);
    } finally {
      fs.rmSync(tmp2, { recursive: true, force: true });
    }
  });
});

// ── 5.2b: local-only user-created skill exemption (validation 2026-05-06) ────
//
// Per the gist's revised §"Note on user-created local skills" (revision
// 2026-05-06T11:27:26Z), only LOCAL-ONLY user-created skills are immune to
// the silent-stale bug — these are tagged `creatorType: "user"` AND
// `syncManaged: false` in the manifest, written by `saveLocalSkill`'s
// local-save branch.
//
// **Uploaded user skills DO re-enter the download cycle**: once
// `saveLocalSkill`'s upload branch posts to the backend `save_skill` API,
// the skill returns through the regular `list-skills` /
// `download-dot-skill-file` path and is subject to the same silent-stale
// failure as Anthropic-managed `pdf` / `xlsx` etc. They presumably retain
// `creatorType: "user"` but flip `syncManaged` to `true` (or absent) — so
// the exemption MUST require the conjunction, not just `creatorType === "user"`.
//
// Critical edge cases verified below:
//   - both fields together → exempt
//   - either field alone → NOT exempt (defensive — prevents over-exempting
//     uploaded user skills which carry creatorType:"user" but not
//     syncManaged:false)
//   - syncManaged absent (legacy Desktop) → NOT exempt

describe("5.2b local-only user-created skill stuckFailureSignature exemption", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-rc4-usercreated-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Build a stuck-shaped skill pair (manifest claims a recent update, on-disk
   *  skill dir is old and SKILL.md missing) with the manifest entry shape
   *  controlled by `manifestEntryExtras`. The skill is named "my-custom-skill"
   *  so it cannot collide with BUILTIN_SKILLS. */
  function makeStuckShapedPair(
    rootPath: string,
    manifestEntryExtras: Record<string, unknown>,
  ): SkillsPluginPair {
    const skillName = "my-custom-skill";
    const skillDir = path.join(rootPath, "skills", skillName);
    fs.mkdirSync(skillDir, { recursive: true });
    // No SKILL.md → matches the stuck-failure shape on its own.
    const manifestPath = path.join(rootPath, "manifest.json");
    writeJson(manifestPath, {
      [skillName]: {
        updatedAt: new Date().toISOString(),
        ...manifestEntryExtras,
      },
    });
    return {
      orgId: "org1",
      accountId: "acc1",
      rootPath,
      manifestPath,
      skills: [
        {
          skillName,
          dirPath: skillDir,
          hasSkillMd: false,
          dirMtime: Date.now() - 48 * 60 * 60 * 1000,
        },
      ],
    };
  }

  it("creatorType: 'user' AND syncManaged: false (local-only) EXEMPTS the skill", () => {
    const pair = makeStuckShapedPair(tmp, { creatorType: "user", syncManaged: false });
    const snaps = snapshotSkillsPluginPair({ pair, skillsPluginRootPath: tmp });
    expect(snaps).toHaveLength(1);
    expect((snaps[0]?.data as { stuckFailureSignature: boolean }).stuckFailureSignature).toBe(
      false,
    );
    // Topology side: isUserCreated must be set so renderers / JSON output
    // can annotate the skill as `(user-created)`.
    expect(pair.skills[0]?.isUserCreated).toBe(true);
  });

  it("creatorType: 'user' ALONE does NOT exempt (presumed uploaded user skill)", () => {
    // Once a user-created skill is uploaded via `saveLocalSkill`'s upload
    // branch, it re-enters the API download cycle and IS subject to the
    // silent-stale bug. Such skills are presumed to retain
    // `creatorType: "user"` but flip `syncManaged` to `true` (or absent).
    // Exempting on `creatorType` alone would over-exempt them.
    const pair = makeStuckShapedPair(tmp, { creatorType: "user" });
    const snaps = snapshotSkillsPluginPair({ pair, skillsPluginRootPath: tmp });
    expect(snaps).toHaveLength(1);
    expect((snaps[0]?.data as { stuckFailureSignature: boolean }).stuckFailureSignature).toBe(true);
    expect(pair.skills[0]?.isUserCreated).toBeUndefined();
  });

  it("creatorType: 'user' WITH syncManaged: true does NOT exempt (uploaded user skill)", () => {
    // Explicit case: an uploaded user skill that has re-entered the sync
    // cycle. This is the exact failure mode the new gist text calls out.
    const pair = makeStuckShapedPair(tmp, { creatorType: "user", syncManaged: true });
    const snaps = snapshotSkillsPluginPair({ pair, skillsPluginRootPath: tmp });
    expect(snaps).toHaveLength(1);
    expect((snaps[0]?.data as { stuckFailureSignature: boolean }).stuckFailureSignature).toBe(true);
    expect(pair.skills[0]?.isUserCreated).toBeUndefined();
  });

  it("syncManaged: false ALONE does NOT exempt (defensive — unknown shape)", () => {
    // The gist documents `syncManaged: false` only in conjunction with
    // `creatorType: "user"`. A skill with `syncManaged: false` but no
    // `creatorType` is an unknown manifest shape; don't infer immunity.
    const pair = makeStuckShapedPair(tmp, { syncManaged: false });
    const snaps = snapshotSkillsPluginPair({ pair, skillsPluginRootPath: tmp });
    expect(snaps).toHaveLength(1);
    expect((snaps[0]?.data as { stuckFailureSignature: boolean }).stuckFailureSignature).toBe(true);
    expect(pair.skills[0]?.isUserCreated).toBeUndefined();
  });

  it("ABSENT syncManaged does NOT exempt the skill (legacy Desktop)", () => {
    // Critical regression: pre-1.6259.1 Desktop versions don't write
    // `syncManaged`. Treating absent as false would over-exempt every
    // legacy API-downloaded skill and silence the trap entirely.
    const pair = makeStuckShapedPair(tmp, {});
    const snaps = snapshotSkillsPluginPair({ pair, skillsPluginRootPath: tmp });
    expect(snaps).toHaveLength(1);
    expect((snaps[0]?.data as { stuckFailureSignature: boolean }).stuckFailureSignature).toBe(true);
    expect(pair.skills[0]?.isUserCreated).toBeUndefined();
  });

  it("syncManaged: true does NOT exempt the skill", () => {
    const pair = makeStuckShapedPair(tmp, { syncManaged: true });
    const snaps = snapshotSkillsPluginPair({ pair, skillsPluginRootPath: tmp });
    expect(snaps).toHaveLength(1);
    expect((snaps[0]?.data as { stuckFailureSignature: boolean }).stuckFailureSignature).toBe(true);
    expect(pair.skills[0]?.isUserCreated).toBeUndefined();
  });
});

// ── 5.3: skills-plugin-stuck recommendation text update ──────────────────────

describe("5.3 skills-plugin-stuck recommendation text", () => {
  it("description mentions quit+relaunch, not focus", () => {
    const mockDrift = {
      kind: "skills-plugin-stuck" as const,
      subject: {
        kind: "root" as const,
        ref: {
          kind: "skills-plugin-pair" as const,
          orgId: "org1",
          accountId: "acc1",
        },
      },
      skill: "pdf",
    };
    const action = actionForDrift(mockDrift, 1);
    expect(action).not.toBeNull();
    expect(action?.description).not.toContain("focus Desktop");
    expect(action?.description).toMatch(/quit.*relaunch|relaunch.*quit/i);
    // Description must reference the effective sync interval. Validation
    // 2026-05-06 surfaced that Desktop reads `skillsSyncIntervalMs` from
    // GrowthBook so the interval is no longer a hard-coded 10 min — match
    // either the legacy ">10 min" wording or the new GrowthBook-aware
    // wording, with a strong preference for the latter going forward.
    expect(action?.description).toMatch(
      /skillsSyncIntervalMs|effective sync interval|>10 min|10 min ago/i,
    );
  });
});

// ── 5.5: bump-needed string-source regression ─────────────────────────────────

describe("5.5 bump-needed step count regression", () => {
  const ctx = {
    pluginName: "myplugin",
    marketplaceName: "mymp",
    sourceType: "github",
    sourceDetail: "owner/repo",
    pluginEntrySourceKind: "string", // string-source
  };

  it("string-source bump-needed still renders 4 steps (regression)", () => {
    const out = formatManualSteps(
      { cmd: "some cmd", action: "bump" },
      { versionTrapKind: "bump-needed" },
      ctx,
      false,
    );
    expect(out).not.toBeNull();
    expect(out).toContain("Fix (manual, 4 steps — if you're the plugin maintainer):");
    // String source: step 2 is git push, not marketplace catalog repo
    expect(out).toContain("git commit -am 'bump version' && git push");
    // String source should NOT have dual-bump prose
    expect(out).not.toContain("marketplace catalog repo");
  });
});

// ── 4.3: JSON nameCollisions field shape ─────────────────────────────────────

describe("4.3 cpd list nameCollisions JSON field", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-rc4-collisions-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("cross-store collision: CCD-installed and RPM-installed with same plugin name → nameCollisions populated", async () => {
    // runV05Scan uses single-mode scanning; to detect cross-store collision in one
    // scan pass we set up the same plugin both in the cowork installed_plugins.json
    // (shows as a CCD-style entry, kind="ccd") AND in the RPM manifest (kind="rpm").
    // This mirrors the real scenario: user installed the plugin via `claude plugin add`
    // AND also via Cowork's Personal Plugins UI, producing a duplicate.
    const userData = path.join(tmp, "Library", "Application Support", "Claude");
    const acc = "acc1";
    const org = "org1";
    const coworkRoot = path.join(userData, "local-agent-mode-sessions", acc, org);
    const coworkPluginsDir = path.join(coworkRoot, "cowork_plugins");
    fs.mkdirSync(coworkPluginsDir, { recursive: true });

    // Marketplace registered in the cowork known_marketplaces.json
    writeJson(path.join(coworkPluginsDir, "known_marketplaces.json"), {
      "lool-founder-skills": { source: { source: "github", repo: "lool-ventures/founder-skills" } },
    });

    // CCD-style install recorded in cowork installed_plugins.json
    const installPath = path.join(
      coworkPluginsDir,
      "cache",
      "lool-founder-skills",
      "founder-skills",
      "0.3.1",
    );
    fs.mkdirSync(installPath, { recursive: true });
    writeJson(path.join(coworkPluginsDir, "installed_plugins.json"), {
      version: 2,
      plugins: {
        "founder-skills@lool-founder-skills": [{ version: "0.3.1", installPath, scope: "user" }],
      },
    });

    const mpClone = path.join(
      coworkPluginsDir,
      "marketplaces",
      "lool-founder-skills",
      ".claude-plugin",
    );
    fs.mkdirSync(mpClone, { recursive: true });
    writeJson(path.join(mpClone, "marketplace.json"), {
      plugins: [{ name: "founder-skills", version: "0.3.1", source: "plugins/founder-skills" }],
    });

    // RPM entry for the same plugin name (same plugin, installed via Cowork UI)
    const rpm = path.join(coworkRoot, "rpm");
    fs.mkdirSync(rpm, { recursive: true });
    writeJson(path.join(rpm, "manifest.json"), {
      plugins: [
        {
          id: "plugin_01CKP",
          name: "founder-skills",
          marketplaceName: "founder-skills",
          marketplaceId: "marketplace_01K1Tj",
          installedBy: "user",
        },
      ],
    });

    // Minimal CCD root so topology doesn't complain
    const ccdPlugins = path.join(tmp, ".claude", "plugins");
    fs.mkdirSync(ccdPlugins, { recursive: true });
    writeJson(path.join(ccdPlugins, "known_marketplaces.json"), {});
    writeJson(path.join(ccdPlugins, "installed_plugins.json"), { version: 2, plugins: {} });

    const result = await runList({
      home: tmp,
      platform: "darwin",
      env: { HOME: tmp },
      mode: "cowork",
      noNetwork: true,
      coworkAccount: acc,
      coworkOrg: org,
    });

    // Should have nameCollisions
    expect(result.nameCollisions).toBeDefined();
    expect(result.nameCollisions).not.toHaveLength(0);
    const group = result.nameCollisions?.find((g) => g.pluginName === "founder-skills");
    expect(group).toBeDefined();
    expect(group?.entries).toHaveLength(2);

    // One CCD entry (from installed_plugins.json), one RPM entry (from rpm/manifest.json)
    const ccdEntry = group?.entries.find((e) => e.kind === "ccd");
    const rpmEntry = group?.entries.find((e) => e.kind === "rpm");
    expect(ccdEntry).toBeDefined();
    expect(rpmEntry).toBeDefined();
    expect(ccdEntry?.id).toBe("founder-skills@lool-founder-skills");
    expect(rpmEntry?.id).toBe("founder-skills@founder-skills");
  });

  it("no collision: no nameCollisions field populated", async () => {
    const plugins = path.join(tmp, ".claude", "plugins");
    fs.mkdirSync(plugins, { recursive: true });
    writeJson(path.join(plugins, "known_marketplaces.json"), {});
    writeJson(path.join(plugins, "installed_plugins.json"), { version: 2, plugins: {} });

    const result = await runList({
      home: tmp,
      platform: "darwin",
      env: { HOME: tmp },
      mode: "ccd",
      noNetwork: true,
    });

    expect(result.nameCollisions).toBeUndefined();
  });
});

// ── 5.4: skills-plugin section in cpd list ───────────────────────────────────

describe("5.4 cpd list skills-plugin section", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-rc4-sp-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("(built-in) annotation appears for the 3 hard-coded built-in skills", () => {
    // Build a minimal ListReport with skillsPlugin data including built-ins.
    const listReport = {
      schemaVersion: "1.0" as const,
      marketplaces: [],
      plugins: [],
      rpmPlugins: [],
      coworkRoots: [],
      exitCode: 0 as const,
      runId: "test",
      startedAt: "2026-05-02T00:00:00.000Z",
      finishedAt: "2026-05-02T00:00:01.000Z",
      skillsPlugin: {
        rootPath: "/fake/skills-plugin",
        pairs: [
          {
            orgId: "org1",
            accountId: "acc1",
            rootPath: "/fake/skills-plugin/org1/acc1",
            skills: [
              {
                skillName: "schedule",
                dirPath: "/fake/skills-plugin/org1/acc1/schedule",
                hasSkillMd: true,
              },
              {
                skillName: "setup-cowork",
                dirPath: "/fake/skills-plugin/org1/acc1/setup-cowork",
                hasSkillMd: true,
              },
              {
                skillName: "consolidate-memory",
                dirPath: "/fake/skills-plugin/org1/acc1/consolidate-memory",
                hasSkillMd: true,
              },
              { skillName: "pdf", dirPath: "/fake/skills-plugin/org1/acc1/pdf", hasSkillMd: true },
            ],
          },
        ],
      },
    };

    const out = renderHumanList(listReport, { color: false });
    // Built-ins should have (built-in) annotation
    expect(out).toContain("schedule");
    expect(out).toContain("(built-in)");
    // Non-built-in should NOT have (built-in)
    // The pdf skill should appear but without (built-in)
    const lines = out.split("\n");
    const pdfLine = lines.find((l) => l.includes("pdf") && !l.includes("skills"));
    expect(pdfLine).toBeDefined();
    expect(pdfLine).not.toContain("(built-in)");
  });

  it("JSON: SkillsPluginSkill.isBuiltIn is true for built-in skills from snapshotSkillsPluginPair", () => {
    // Create a pair with built-in skills and snapshot it.
    const skillDir = path.join(tmp, "schedule");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# schedule");

    const pair: SkillsPluginPair = {
      orgId: "org1",
      accountId: "acc1",
      rootPath: tmp,
      skills: [{ skillName: "schedule", dirPath: skillDir, hasSkillMd: true }],
    };

    // After snapshotSkillsPluginPair, the skill.isBuiltIn should be set.
    snapshotSkillsPluginPair({ pair, skillsPluginRootPath: tmp });
    // The skill object is mutated in place.
    expect(pair.skills[0]?.isBuiltIn).toBe(true);
  });
});

// ── 2.1: alias-differs note rewrite ──────────────────────────────────────────

describe("2.1 alias-differs note rewrite", () => {
  it("new wording uses 'backend' framing, not 'per mode'", async () => {
    // Build a fixture where the same plugin exists via RPM with a different marketplace name.
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-rc4-alias-"));
    try {
      const plugins = path.join(tmp2, ".claude", "plugins");
      fs.mkdirSync(plugins, { recursive: true });
      writeJson(path.join(plugins, "known_marketplaces.json"), {
        "lool-founder-skills": {
          source: { source: "github", repo: "lool-ventures/founder-skills" },
        },
      });
      writeJson(path.join(plugins, "installed_plugins.json"), { version: 2, plugins: {} });

      const userData = path.join(tmp2, "Library", "Application Support", "Claude");
      const acc = "acc1";
      const org = "org1";
      const coworkRoot = path.join(userData, "local-agent-mode-sessions", acc, org);
      const coworkPlugins = path.join(coworkRoot, "cowork_plugins");
      fs.mkdirSync(coworkPlugins, { recursive: true });
      writeJson(path.join(coworkPlugins, "known_marketplaces.json"), {});
      writeJson(path.join(coworkPlugins, "installed_plugins.json"), { version: 2, plugins: {} });

      const rpm = path.join(coworkRoot, "rpm");
      fs.mkdirSync(rpm, { recursive: true });
      writeJson(path.join(rpm, "manifest.json"), {
        plugins: [
          {
            id: "plugin_01CKP",
            name: "founder-skills",
            marketplaceName: "founder-skills", // different from CCD alias
            marketplaceId: "marketplace_01K1Tj",
            installedBy: "user",
          },
        ],
      });

      const { runV05Check } = await import("../../src/commands/check.js");
      const report = await runV05Check({
        home: tmp2,
        platform: "darwin",
        env: { HOME: tmp2 },
        mode: "cowork",
        noNetwork: true,
        coworkAccount: acc,
        coworkOrg: org,
        pluginAtMarketplace: "founder-skills@lool-founder-skills",
      });

      expect(report.rpmMatch?.marketplaceAliasDiffers).toBeDefined();

      const { renderHumanCheck } = await import("../../src/output/human.js");
      const out = renderHumanCheck(report, { color: false });
      // De-jargon pass: new "Naming note" framing uses plain language.
      expect(out).toContain("Naming note");
      expect(out).toContain("different names in your two installs");
      expect(out).toContain("standalone Claude Code");
      expect(out).toContain("Claude Cowork registered it as");
      // Old framing should NOT appear
      expect(out).not.toContain("Same plugin, different marketplace alias per mode.");
    } finally {
      fs.rmSync(tmp2, { recursive: true, force: true });
    }
  });

  it("--verbose adds marketplaceId line when available", async () => {
    const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-rc4-alias-v-"));
    try {
      const plugins = path.join(tmp3, ".claude", "plugins");
      fs.mkdirSync(plugins, { recursive: true });
      writeJson(path.join(plugins, "known_marketplaces.json"), {
        "lool-founder-skills": {
          source: { source: "github", repo: "lool-ventures/founder-skills" },
        },
      });
      writeJson(path.join(plugins, "installed_plugins.json"), { version: 2, plugins: {} });

      const userData = path.join(tmp3, "Library", "Application Support", "Claude");
      const acc = "acc1";
      const org = "org1";
      const coworkRoot = path.join(userData, "local-agent-mode-sessions", acc, org);
      const coworkPlugins = path.join(coworkRoot, "cowork_plugins");
      fs.mkdirSync(coworkPlugins, { recursive: true });
      writeJson(path.join(coworkPlugins, "known_marketplaces.json"), {});
      writeJson(path.join(coworkPlugins, "installed_plugins.json"), { version: 2, plugins: {} });

      const rpm = path.join(coworkRoot, "rpm");
      fs.mkdirSync(rpm, { recursive: true });
      writeJson(path.join(rpm, "manifest.json"), {
        plugins: [
          {
            id: "plugin_01CKP",
            name: "founder-skills",
            marketplaceName: "founder-skills",
            marketplaceId: "marketplace_01K1Tjbcu3EZq1c1sCFGQq6F",
            installedBy: "user",
          },
        ],
      });

      const { runV05Check } = await import("../../src/commands/check.js");
      const report = await runV05Check({
        home: tmp3,
        platform: "darwin",
        env: { HOME: tmp3 },
        mode: "cowork",
        noNetwork: true,
        coworkAccount: acc,
        coworkOrg: org,
        pluginAtMarketplace: "founder-skills@lool-founder-skills",
      });

      const { renderHumanCheck } = await import("../../src/output/human.js");
      const out = renderHumanCheck(report, { color: false, verbose: true });
      expect(out).toContain("Cowork backend marketplace ID");
      expect(out).toContain("marketplace_01K1Tjbcu3EZq1c1sCFGQq6F");
    } finally {
      fs.rmSync(tmp3, { recursive: true, force: true });
    }
  });

  it("--verbose with undefined marketplaceId omits the marketplaceId line (no artifact)", async () => {
    const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-rc4-alias-noid-"));
    try {
      const plugins = path.join(tmp4, ".claude", "plugins");
      fs.mkdirSync(plugins, { recursive: true });
      writeJson(path.join(plugins, "known_marketplaces.json"), {
        "lool-founder-skills": {
          source: { source: "github", repo: "lool-ventures/founder-skills" },
        },
      });
      writeJson(path.join(plugins, "installed_plugins.json"), { version: 2, plugins: {} });

      const userData = path.join(tmp4, "Library", "Application Support", "Claude");
      const acc = "acc1";
      const org = "org1";
      const coworkRoot = path.join(userData, "local-agent-mode-sessions", acc, org);
      const coworkPlugins = path.join(coworkRoot, "cowork_plugins");
      fs.mkdirSync(coworkPlugins, { recursive: true });
      writeJson(path.join(coworkPlugins, "known_marketplaces.json"), {});
      writeJson(path.join(coworkPlugins, "installed_plugins.json"), { version: 2, plugins: {} });

      const rpm = path.join(coworkRoot, "rpm");
      fs.mkdirSync(rpm, { recursive: true });
      // Object-keyed form: no marketplaceId
      writeJson(path.join(rpm, "manifest.json"), {
        plugins: {
          plugin_01OBJ: { installedBy: "user" },
        },
      });
      // BUT we need the plugin to have a name to match — object-keyed doesn't carry name.
      // So we use array-form but without marketplaceId.
      fs.writeFileSync(
        path.join(rpm, "manifest.json"),
        JSON.stringify({
          plugins: [
            {
              id: "plugin_01OBJ",
              name: "founder-skills",
              marketplaceName: "founder-skills",
              // no marketplaceId
              installedBy: "user",
            },
          ],
        }),
      );

      const { runV05Check } = await import("../../src/commands/check.js");
      const report = await runV05Check({
        home: tmp4,
        platform: "darwin",
        env: { HOME: tmp4 },
        mode: "cowork",
        noNetwork: true,
        coworkAccount: acc,
        coworkOrg: org,
        pluginAtMarketplace: "founder-skills@lool-founder-skills",
      });

      const { renderHumanCheck } = await import("../../src/output/human.js");
      const out = renderHumanCheck(report, { color: false, verbose: true });
      // Should NOT print any marketplaceId artifact when undefined
      expect(out).not.toContain("marketplaceId:");
      expect(out).not.toContain("undefined");
    } finally {
      fs.rmSync(tmp4, { recursive: true, force: true });
    }
  });
});

// ── 4.2: source URL evidence line ────────────────────────────────────────────

describe("4.2 source URL evidence in alias-differs note", () => {
  it("CCD github source renders github.com/<repo> in the alias-differs note", async () => {
    const tmp5 = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-rc4-sourceurl-"));
    try {
      const plugins = path.join(tmp5, ".claude", "plugins");
      fs.mkdirSync(plugins, { recursive: true });
      writeJson(path.join(plugins, "known_marketplaces.json"), {
        "lool-founder-skills": {
          source: { source: "github", repo: "lool-ventures/founder-skills" },
        },
      });
      writeJson(path.join(plugins, "installed_plugins.json"), { version: 2, plugins: {} });

      const userData = path.join(tmp5, "Library", "Application Support", "Claude");
      const acc = "acc1";
      const org = "org1";
      const coworkRoot = path.join(userData, "local-agent-mode-sessions", acc, org);
      const coworkPlugins = path.join(coworkRoot, "cowork_plugins");
      fs.mkdirSync(coworkPlugins, { recursive: true });
      // The cowork known_marketplaces.json mirrors the CCD one (realistic: same
      // marketplace is available in cowork too, under the same CCD alias).
      writeJson(path.join(coworkPlugins, "known_marketplaces.json"), {
        "lool-founder-skills": {
          source: { source: "github", repo: "lool-ventures/founder-skills" },
        },
      });
      writeJson(path.join(coworkPlugins, "installed_plugins.json"), { version: 2, plugins: {} });

      const rpm = path.join(coworkRoot, "rpm");
      fs.mkdirSync(rpm, { recursive: true });
      writeJson(path.join(rpm, "manifest.json"), {
        plugins: [
          {
            id: "plugin_01CKP",
            name: "founder-skills",
            marketplaceName: "founder-skills",
            installedBy: "user",
          },
        ],
      });

      const { runV05Check } = await import("../../src/commands/check.js");
      const report = await runV05Check({
        home: tmp5,
        platform: "darwin",
        env: { HOME: tmp5 },
        mode: "cowork",
        noNetwork: true,
        coworkAccount: acc,
        coworkOrg: org,
        pluginAtMarketplace: "founder-skills@lool-founder-skills",
      });

      const { renderHumanCheck } = await import("../../src/output/human.js");
      const out = renderHumanCheck(report, { color: false });
      expect(out).toContain("github.com/lool-ventures/founder-skills");
      expect(out).toContain("source URL (from standalone Claude Code)");
    } finally {
      fs.rmSync(tmp5, { recursive: true, force: true });
    }
  });
});

// ── 4.1: multi-match disambiguation ──────────────────────────────────────────

describe("4.1 multi-match disambiguation in cpd check", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-rc4-multiMatch-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function setupFixtureWithTwoRpmMatches(home: string): { acc: string; org: string } {
    const plugins = path.join(home, ".claude", "plugins");
    fs.mkdirSync(plugins, { recursive: true });
    writeJson(path.join(plugins, "known_marketplaces.json"), {});
    writeJson(path.join(plugins, "installed_plugins.json"), { version: 2, plugins: {} });

    const userData = path.join(home, "Library", "Application Support", "Claude");
    const acc = "acc1";
    const org = "org1";
    const coworkRoot = path.join(userData, "local-agent-mode-sessions", acc, org);
    const coworkPlugins = path.join(coworkRoot, "cowork_plugins");
    fs.mkdirSync(coworkPlugins, { recursive: true });
    writeJson(path.join(coworkPlugins, "known_marketplaces.json"), {});
    writeJson(path.join(coworkPlugins, "installed_plugins.json"), { version: 2, plugins: {} });

    const rpm = path.join(coworkRoot, "rpm");
    fs.mkdirSync(rpm, { recursive: true });
    // Two RPM entries with the same plugin name but different backend marketplaces
    writeJson(path.join(rpm, "manifest.json"), {
      plugins: [
        {
          id: "plugin_01ABC",
          name: "widget",
          marketplaceName: "acme-backend",
          marketplaceId: "marketplace_01ABC",
          installedBy: "user",
        },
        {
          id: "plugin_01XYZ",
          name: "widget",
          marketplaceName: "upstream-fork",
          marketplaceId: "marketplace_01XYZ",
          installedBy: "user",
        },
      ],
    });
    return { acc, org };
  }

  it("primary mode ≥2 matches → rpmMatchAmbiguous set with all candidates, exitCode 64", async () => {
    const { acc, org } = setupFixtureWithTwoRpmMatches(tmp);
    const { runV05Check } = await import("../../src/commands/check.js");
    const report = await runV05Check({
      home: tmp,
      platform: "darwin",
      env: { HOME: tmp },
      mode: "cowork",
      noNetwork: true,
      coworkAccount: acc,
      coworkOrg: org,
      pluginAtMarketplace: "widget@some-alias",
    });

    expect(report.rpmMatchAmbiguous).toBeDefined();
    expect(report.rpmMatchAmbiguous?.candidates).toHaveLength(2);
    expect(report.exitCode).toBe(64);

    const candidateNames = report.rpmMatchAmbiguous?.candidates.map((c) => c.marketplaceName);
    expect(candidateNames).toContain("acme-backend");
    expect(candidateNames).toContain("upstream-fork");
  });

  it("single-match regression: 1 RPM match still works correctly (not ambiguous)", async () => {
    const plugins = path.join(tmp, ".claude", "plugins");
    fs.mkdirSync(plugins, { recursive: true });
    writeJson(path.join(plugins, "known_marketplaces.json"), {});
    writeJson(path.join(plugins, "installed_plugins.json"), { version: 2, plugins: {} });

    const userData = path.join(tmp, "Library", "Application Support", "Claude");
    const acc = "acc1";
    const org = "org1";
    const coworkRoot = path.join(userData, "local-agent-mode-sessions", acc, org);
    const coworkPlugins = path.join(coworkRoot, "cowork_plugins");
    fs.mkdirSync(coworkPlugins, { recursive: true });
    writeJson(path.join(coworkPlugins, "known_marketplaces.json"), {});
    writeJson(path.join(coworkPlugins, "installed_plugins.json"), { version: 2, plugins: {} });

    const rpm = path.join(coworkRoot, "rpm");
    fs.mkdirSync(rpm, { recursive: true });
    writeJson(path.join(rpm, "manifest.json"), {
      plugins: [
        {
          id: "plugin_01SINGLE",
          name: "widget",
          marketplaceName: "acme",
          installedBy: "user",
        },
      ],
    });

    const { runV05Check } = await import("../../src/commands/check.js");
    const report = await runV05Check({
      home: tmp,
      platform: "darwin",
      env: { HOME: tmp },
      mode: "cowork",
      noNetwork: true,
      coworkAccount: acc,
      coworkOrg: org,
      pluginAtMarketplace: "widget@acme",
    });

    // Single match: rpmMatchAmbiguous should NOT be set
    expect(report.rpmMatchAmbiguous).toBeUndefined();
    expect(report.rpmMatch).toBeDefined();
    expect(report.exitCode).not.toBe(64);
  });

  it("JSON shape: rpmMatchAmbiguous.candidates has pluginId, marketplaceName, suggestedDisambiguatedId", async () => {
    const { acc, org } = setupFixtureWithTwoRpmMatches(tmp);
    const { runV05Check } = await import("../../src/commands/check.js");
    const report = await runV05Check({
      home: tmp,
      platform: "darwin",
      env: { HOME: tmp },
      mode: "cowork",
      noNetwork: true,
      coworkAccount: acc,
      coworkOrg: org,
      pluginAtMarketplace: "widget@some-alias",
    });

    const candidates = report.rpmMatchAmbiguous?.candidates;
    expect(candidates).toBeDefined();
    for (const cand of candidates ?? []) {
      expect(cand.pluginId).toBeDefined();
      expect(cand.marketplaceName).toBeDefined();
      expect(cand.suggestedDisambiguatedId).toContain("@");
    }
  });

  it("human renderer: disambig block lists candidates with run commands", async () => {
    const { acc, org } = setupFixtureWithTwoRpmMatches(tmp);
    const { runV05Check } = await import("../../src/commands/check.js");
    const report = await runV05Check({
      home: tmp,
      platform: "darwin",
      env: { HOME: tmp },
      mode: "cowork",
      noNetwork: true,
      coworkAccount: acc,
      coworkOrg: org,
      pluginAtMarketplace: "widget@some-alias",
    });

    const { renderHumanCheck } = await import("../../src/output/human.js");
    const out = renderHumanCheck(report, { color: false });
    expect(out).toContain("installed under multiple marketplaces in Claude Cowork");
    expect(out).toContain("cpd check widget@acme-backend --mode cowork");
    expect(out).toContain("cpd check widget@upstream-fork --mode cowork");
    expect(out).toContain("Exit code: 64");
  });
});
