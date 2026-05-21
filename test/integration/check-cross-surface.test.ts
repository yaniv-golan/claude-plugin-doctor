/**
 * Phase 3 integration: `cpd check <plugin>@<mp>` must surface BOTH the
 * CCD plugin layers AND the RPM/Personal-plugins layer when the same
 * plugin name exists in both surfaces — previously, check short-circuited
 * on the first CCD match and dismissed the RPM surface as n/a, hiding
 * stale Personal-plugins installs.
 *
 * Repro modeled on the proof-engine case (CCD fresh at 1.42, RPM stale at
 * 1.41), but with a synthetic marketplace so the test is offline.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function writeJson(p: string, data: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
}

function buildFixture(tmp: string): { acc: string; org: string } {
  const acc = "acc1";
  const org = "org1";

  // ── CCD side ────────────────────────────────────────────────────────────────
  const ccdPlugins = path.join(tmp, ".claude", "plugins");
  fs.mkdirSync(ccdPlugins, { recursive: true });
  // User's CCD-side alias for the marketplace is "proof-engine-marketplace".
  writeJson(path.join(ccdPlugins, "known_marketplaces.json"), {
    "proof-engine-marketplace": {
      source: { source: "git", url: "https://example.invalid/proof-engine.git" },
    },
  });
  writeJson(path.join(ccdPlugins, "installed_plugins.json"), {
    version: 2,
    plugins: {
      "proof-engine@proof-engine-marketplace": [
        {
          version: "1.42.0",
          installPath: path.join(
            ccdPlugins,
            "cache",
            "proof-engine-marketplace",
            "proof-engine",
            "1.42.0",
          ),
        },
      ],
    },
  });
  // Materialize the marketplace clone with the source plugin at 1.42.0.
  const cloneDir = path.join(ccdPlugins, "marketplaces", "proof-engine-marketplace");
  writeJson(path.join(cloneDir, ".claude-plugin", "marketplace.json"), {
    name: "proof-engine-marketplace",
    plugins: [{ name: "proof-engine", source: "./proof-engine" }],
  });
  writeJson(path.join(cloneDir, "proof-engine", ".claude-plugin", "plugin.json"), {
    name: "proof-engine",
    version: "1.42.0",
  });
  // Installed copy at the resolved version path.
  writeJson(
    path.join(
      ccdPlugins,
      "cache",
      "proof-engine-marketplace",
      "proof-engine",
      "1.42.0",
      ".claude-plugin",
      "plugin.json",
    ),
    { name: "proof-engine", version: "1.42.0" },
  );

  // ── Cowork side ─────────────────────────────────────────────────────────────
  const userData = path.join(tmp, "Library", "Application Support", "Claude");
  const coworkRoot = path.join(userData, "local-agent-mode-sessions", acc, org);
  const coworkPlugins = path.join(coworkRoot, "cowork_plugins");
  fs.mkdirSync(coworkPlugins, { recursive: true });
  writeJson(path.join(coworkPlugins, "known_marketplaces.json"), {});
  writeJson(path.join(coworkPlugins, "installed_plugins.json"), { version: 2, plugins: {} });

  // RPM-installed copy at the OLD version (1.41.0). The marketplaceName here
  // is the Cowork-backend alias ("proof-engine"), which DIFFERS from CCD's
  // "proof-engine-marketplace" — exactly the cross-naming case the resolver
  // fixes in Phase 2.
  const rpm = path.join(coworkRoot, "rpm");
  fs.mkdirSync(rpm, { recursive: true });
  writeJson(path.join(rpm, "manifest.json"), {
    plugins: [
      {
        id: "plugin_01PROOFENGINE",
        name: "proof-engine",
        marketplaceName: "proof-engine",
        marketplaceId: "marketplace_xyz",
        installedBy: "user",
        updatedAt: "2026-05-21T07:56:34.415647Z",
      },
    ],
  });
  writeJson(path.join(rpm, "plugin_01PROOFENGINE", ".claude-plugin", "plugin.json"), {
    name: "proof-engine",
    version: "1.41.0",
  });

  // Pin mtimes so detectMode() picks "ccd" deterministically (matches the
  // user's real-world state when they've just run `claude plugin update`).
  // Without this, file-write order races decide mode and the test is flaky.
  const now = Date.now();
  fs.utimesSync(
    path.join(coworkPlugins, "installed_plugins.json"),
    new Date(now - 60000),
    new Date(now - 60000),
  );
  fs.utimesSync(path.join(rpm, "manifest.json"), new Date(now - 60000), new Date(now - 60000));
  fs.utimesSync(path.join(ccdPlugins, "installed_plugins.json"), new Date(now), new Date(now));

  return { acc, org };
}

describe("Phase 3: `cpd check` surfaces both CCD and RPM when both have the plugin", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-phase3-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("populates both `plugin` and `rpmMatch`; exit code reflects RPM staleness", async () => {
    const { acc, org } = buildFixture(tmp);
    const { runV05Check } = await import("../../src/commands/check.js");

    const report = await runV05Check({
      home: tmp,
      platform: "darwin",
      env: { HOME: tmp },
      mode: "all",
      noNetwork: true,
      coworkAccount: acc,
      coworkOrg: org,
      pluginAtMarketplace: "proof-engine@proof-engine-marketplace",
    });

    // CCD side resolves and shows fresh layers.
    expect(report.plugin).toBeDefined();
    expect(report.plugin?.id).toBe("proof-engine@proof-engine-marketplace");
    expect(report.plugin?.checks.install_snapshot.status).toBe("fresh");

    // RPM side ALSO resolves (used to be suppressed by the `if (!plugin)` guard).
    expect(report.rpmMatch).toBeDefined();
    expect(report.rpmMatch?.rpmPlugin.name).toBe("proof-engine");
    expect(report.rpmMatch?.rpmPlugin.layer5.status).toBe("stale");
    expect(report.rpmMatch?.rpmPlugin.layer5.evidence.rpmVersion).toBe("1.41.0");
    expect(report.rpmMatch?.rpmPlugin.layer5.evidence.cloneVersion).toBe("1.42.0");

    // Alias-differs note fires (typed "proof-engine-marketplace", RPM is "proof-engine").
    expect(report.rpmMatch?.marketplaceAliasDiffers).toEqual({
      typedAs: "proof-engine-marketplace",
      actual: "proof-engine",
    });

    // Exit code reflects worst-across-surfaces: 3 (manual RPM fix — no
    // machine-runnable cmd, action is "open Settings → Plugins").
    expect(report.exitCode).toBe(3);
  });

  it("human renderer emits the 'Also installed via Claude Cowork' section", async () => {
    const { acc, org } = buildFixture(tmp);
    const { runV05Check } = await import("../../src/commands/check.js");
    const { renderHumanCheck } = await import("../../src/output/human.js");

    const report = await runV05Check({
      home: tmp,
      platform: "darwin",
      env: { HOME: tmp },
      mode: "all",
      noNetwork: true,
      coworkAccount: acc,
      coworkOrg: org,
      pluginAtMarketplace: "proof-engine@proof-engine-marketplace",
    });

    const out = renderHumanCheck(report, { color: false });

    expect(out).toContain("Also installed via Claude Cowork (Personal plugins)");
    expect(out).toContain("1.41.0");
    expect(out).toContain("1.42.0");
    expect(out).toMatch(/Fix:.*Settings.*Plugins/);
    expect(out).toContain("Exit code: 3");
  });
});
