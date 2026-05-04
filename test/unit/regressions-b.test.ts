/**
 * Gap-fix / usability tests for v1.0.0-  — covers the 5 usability issues
 * closed in the   polish pass:
 *
 *  1. scan_done summary: versionTrapCount + staleCount fields
 *  2. Human renderer "Drift summary" completeness (version-drift, runtime-boundary,
 *     registration-drift, unsupported-source)
 *  3. Human renderer "next-steps" hint (per-plugin deep-dive + cpd explain)
 */

import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { renderHuman } from "../../src/output/human.js";
import { Progress } from "../../src/progress.js";
import type { Drift, PluginRef, ScanReport } from "../../src/types.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

class StringSink extends Writable {
  chunks: string[] = [];
  override _write(
    chunk: Buffer | string,
    _enc: BufferEncoding,
    cb: (e?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    cb();
  }
  text(): string {
    return this.chunks.join("");
  }
}

const ccdPluginRef: PluginRef = {
  pluginName: "my-plugin",
  marketplace: "my-mp",
  root: { kind: "ccd" },
};

const baseScanReport: ScanReport = {
  schemaVersion: "1.0",
  runId: "test-run-rc2",
  startedAt: "2026-05-02T00:00:00.000Z",
  finishedAt: "2026-05-02T00:00:01.000Z",
  topology: {
    cowork: [],
    sessionLocals: [],
    scannedAt: "2026-05-02T00:00:00.000Z",
    ccd: {
      pluginsRoot: "/r/ccd",
      knownMarketplacesPath: "/r/ccd/known_marketplaces.json",
      installedPluginsPath: "/r/ccd/installed_plugins.json",
      marketplacesDir: "/r/ccd/marketplaces",
      cacheDir: "/r/ccd/cache",
      marketplaces: [],
    },
  },
  upstreams: {},
  caches: {},
  marketplaceCaches: {},
  rpmCaches: {},
  resolvers: {},
  drifts: [],
  recommendations: [],
  exitCode: 0,
};

// ── Issue 1: scan_done summary fields ──────────────────────────────────────

describe("scan_done summary fields", () => {
  it("emits versionTrapCount and staleCount alongside layersStale", () => {
    const sink = new StringSink();
    const p = new Progress({ enabled: false, isTty: false, ndjsonStream: sink });

    p.emitDone(500, 2, {
      marketplaces: 2,
      plugins: 10,
      layersStale: 3,
      versionTrapCount: 3,
      staleCount: 7,
      topologyRoots: 1,
      driftCount: 10,
      recommendationCount: 4,
    });

    const ev = JSON.parse(sink.text().trim());
    expect(ev).toMatchObject({
      type: "scan_done",
      exitCode: 2,
      summary: {
        layersStale: 3,
        versionTrapCount: 3,
        staleCount: 7,
        marketplaces: 2,
        plugins: 10,
      },
    });
  });

  it("emits versionTrapCount equal to layersStale (same count, honest name)", () => {
    const sink = new StringSink();
    const p = new Progress({ enabled: false, isTty: false, ndjsonStream: sink });

    p.emitDone(100, 0, {
      marketplaces: 1,
      plugins: 0,
      layersStale: 0,
      versionTrapCount: 0,
      staleCount: 0,
    });

    const ev = JSON.parse(sink.text().trim());
    // When clean, both counts are 0.
    expect(ev.summary?.layersStale).toBe(0);
    expect(ev.summary?.versionTrapCount).toBe(0);
    expect(ev.summary?.staleCount).toBe(0);
  });

  it("staleCount exceeds layersStale when broader drift kinds are present", () => {
    // Simulate a scan_done where staleCount > layersStale:
    // layersStale/versionTrapCount = 2 (refresh-needed + bump-needed)
    // staleCount = 5 (also includes marketplace-update-broken, version-drift upstream, skills-stuck)
    const sink = new StringSink();
    const p = new Progress({ enabled: false, isTty: false, ndjsonStream: sink });

    p.emitDone(300, 3, {
      marketplaces: 3,
      plugins: 15,
      layersStale: 2,
      versionTrapCount: 2,
      staleCount: 5,
    });

    const ev = JSON.parse(sink.text().trim());
    expect(ev.summary?.versionTrapCount).toBe(2);
    expect(ev.summary?.staleCount).toBe(5);
    expect(ev.summary?.staleCount).toBeGreaterThan(ev.summary?.versionTrapCount ?? 0);
  });
});

// ── Issue 2: Human renderer drift-summary completeness ─────────────────────

describe("renderHuman drift summary completeness", () => {
  function makeReport(drifts: Drift[], exitCode: 0 | 2 | 3 = 2): ScanReport {
    return { ...baseScanReport, drifts, exitCode };
  }

  it("renders version-drift lines in Plugins row", () => {
    const drifts: Drift[] = [
      {
        kind: "version-drift",
        subject: { kind: "plugin", ref: ccdPluginRef },
        ahead: "upstream",
        upstreamVersion: "2.0.0",
        installedVersion: "1.0.0",
      },
      {
        kind: "version-drift",
        subject: { kind: "plugin", ref: { ...ccdPluginRef, pluginName: "other-plugin" } },
        ahead: "upstream",
        upstreamVersion: "3.0.0",
        installedVersion: "2.0.0",
      },
    ];
    const out = renderHuman(makeReport(drifts), { color: false });
    expect(out).toContain("Drift summary:");
    expect(out).toContain("Plugins");
    //   copy: "version drift" → "stale".
    expect(out).toContain("stale");
    expect(out).toContain("2 stale");
  });

  it("renders runtime-boundary advisories in Surfaces row", () => {
    const drifts: Drift[] = [
      {
        kind: "runtime-boundary",
        subject: { kind: "plugin", ref: ccdPluginRef },
        changedSurfaces: ["skill", "command"],
        changedSurfacesSource: "diff-installed-vs-resolved",
        refreshBy: "new-task",
      },
      {
        kind: "runtime-boundary",
        subject: { kind: "plugin", ref: { ...ccdPluginRef, pluginName: "b" } },
        changedSurfaces: ["hook"],
        changedSurfacesSource: "conservative-all-surfaces",
        refreshBy: "ui-restart",
      },
    ];
    const out = renderHuman(makeReport(drifts), { color: false });
    expect(out).toContain("Drift summary:");
    expect(out).toContain("Surfaces");
    //   copy: "runtime-boundary advisories" → "changes need a fresh task or app restart".
    expect(out).toMatch(/fresh task or app restart/);
    expect(out).toContain("2 changes need");
  });

  it("renders registration-drift count in Plugins row", () => {
    const drifts: Drift[] = [
      {
        kind: "registration-drift",
        scope: "plugin",
        name: "my-plugin",
        marketplace: "my-mp",
        presentIn: [{ kind: "ccd" }],
        absentIn: [{ kind: "cowork", accountId: "acc1", orgId: "org1" }],
      },
    ];
    const out = renderHuman(makeReport(drifts), { color: false });
    expect(out).toContain("Drift summary:");
    expect(out).toContain("Plugins");
    //   copy: "registration drift" → "registration mismatch".
    expect(out).toContain("registration mismatch");
    expect(out).toContain("1 registration mismatch");
  });

  it("renders unsupported-source count in Sources row", () => {
    const drifts: Drift[] = [
      {
        kind: "unsupported-source",
        subject: { kind: "plugin", ref: ccdPluginRef },
      },
      {
        kind: "unsupported-source",
        subject: { kind: "plugin", ref: { ...ccdPluginRef, pluginName: "b" } },
      },
      {
        kind: "unsupported-source",
        subject: { kind: "plugin", ref: { ...ccdPluginRef, pluginName: "c" } },
      },
      {
        kind: "unsupported-source",
        subject: { kind: "plugin", ref: { ...ccdPluginRef, pluginName: "d" } },
      },
    ];
    const out = renderHuman(makeReport(drifts), { color: false });
    expect(out).toContain("Drift summary:");
    expect(out).toContain("Sources");
    //   copy: "N unsupported source(s)" → "N plugin(s) with a source type ...".
    expect(out).toContain("4 plugin(s) with a source type");
  });

  it("suppresses zero-count rows — no 'Surfaces' line when no runtime-boundary drifts", () => {
    const drifts: Drift[] = [
      {
        kind: "unsupported-source",
        subject: { kind: "plugin", ref: ccdPluginRef },
      },
    ];
    const out = renderHuman(makeReport(drifts), { color: false });
    expect(out).toContain("Sources");
    // Surfaces row should be absent when no runtime-boundary drift.
    expect(out).not.toContain("Surfaces ");
    expect(out).not.toContain("fresh task or app restart");
  });

  it("renders all four new drift kinds together in one summary", () => {
    const drifts: Drift[] = [
      {
        kind: "version-drift",
        subject: { kind: "plugin", ref: ccdPluginRef },
        ahead: "upstream",
        upstreamVersion: "2.0.0",
        installedVersion: "1.0.0",
      },
      {
        kind: "runtime-boundary",
        subject: { kind: "plugin", ref: ccdPluginRef },
        changedSurfaces: ["skill"],
        changedSurfacesSource: "diff-installed-vs-resolved",
        refreshBy: "new-task",
      },
      {
        kind: "registration-drift",
        scope: "plugin",
        name: "my-plugin",
        marketplace: "my-mp",
        presentIn: [{ kind: "ccd" }],
        absentIn: [],
      },
      {
        kind: "unsupported-source",
        subject: { kind: "plugin", ref: { ...ccdPluginRef, pluginName: "b" } },
      },
    ];
    const out = renderHuman(makeReport(drifts), { color: false });
    expect(out).toContain("Drift summary:");
    // All four categories present.
    expect(out).toContain("stale");
    expect(out).toMatch(/fresh task or app restart/);
    expect(out).toContain("registration mismatch");
    expect(out).toMatch(/source type this Claude Code can't install/);
  });
});

// ── Issue 3: Next-steps hint ────────────────────────────────────────────────

describe("renderHuman next-steps hint", () => {
  it("shows next-steps hint when exitCode !== 0", () => {
    const report: ScanReport = {
      ...baseScanReport,
      drifts: [
        {
          kind: "refresh-needed",
          subject: { kind: "plugin", ref: ccdPluginRef },
        } as Drift,
      ],
      exitCode: 2,
    };
    const out = renderHuman(report, { color: false });
    expect(out).toContain("For a per-plugin deep-dive");
    expect(out).toContain("cpd check <plugin>@<marketplace>");
    expect(out).toContain("cpd explain");
  });

  it("shows next-steps hint when exitCode is 3 (manual action required)", () => {
    const report: ScanReport = {
      ...baseScanReport,
      drifts: [
        {
          kind: "marketplace-update-broken",
          subject: {
            kind: "marketplace",
            ref: { marketplace: "my-mp", root: { kind: "ccd" } },
          },
          lastUpdatedAtMs: Date.now() - 1000,
          headLocal: "abc123",
          headRemote: "def456",
        } as Drift,
      ],
      exitCode: 3,
    };
    const out = renderHuman(report, { color: false });
    expect(out).toContain("For a per-plugin deep-dive");
  });

  it("does NOT show next-steps hint when exitCode is 0 (clean run)", () => {
    const report: ScanReport = { ...baseScanReport, exitCode: 0 };
    const out = renderHuman(report, { color: false });
    expect(out).not.toContain("For a per-plugin deep-dive");
    expect(out).not.toContain("cpd check <plugin>@<marketplace>");
  });

  it("does NOT show next-steps hint when --quiet is set", () => {
    const report: ScanReport = {
      ...baseScanReport,
      drifts: [
        {
          kind: "refresh-needed",
          subject: { kind: "plugin", ref: ccdPluginRef },
        } as Drift,
      ],
      exitCode: 2,
    };
    const out = renderHuman(report, { color: false, quiet: true });
    expect(out).not.toContain("For a per-plugin deep-dive");
  });

  it("hint is absent on clean exit even with quiet: false", () => {
    const out = renderHuman(baseScanReport, { color: false, quiet: false });
    expect(out).not.toContain("For a per-plugin deep-dive");
  });
});
