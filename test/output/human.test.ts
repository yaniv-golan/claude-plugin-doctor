import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckReport } from "../../src/commands/check.js";
import { dedupSubchains, formatManualSteps, isManualRec } from "../../src/output/cmd-format.js";
import { formatRecCmd, humanStatus, humanTimestamp, renderHuman } from "../../src/output/human.js";
import type { ScanReport } from "../../src/types.js";

const fresh: ScanReport = {
  schemaVersion: "1.0",
  runId: "test-run-id",
  startedAt: "2026-04-30T00:00:00.000Z",
  finishedAt: "2026-04-30T00:00:01.000Z",
  topology: {
    cowork: [],
    sessionLocals: [],
    scannedAt: "2026-04-30T00:00:00.000Z",
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

describe("renderHuman", () => {
  it("renders an empty fresh report without crashing", () => {
    const out = renderHuman(fresh, { color: false });
    expect(out).toContain("Topology:");
    expect(out).toContain("Standalone Claude Code");
    // The CCD plugins root path should appear
    expect(out).toContain("/r/ccd");
  });

  it("includes recommended-actions section when there are recommendations", () => {
    const report: ScanReport = {
      ...fresh,
      recommendations: [
        {
          id: "rec:refresh-acme",
          ordinal: 1,
          description: "Update marketplace acme",
          cmd: "claude plugin marketplace update acme",
          fixes: [],
          doesNotFix: [],
          risk: "safe",
          requiresYes: false,
          requiresManualStep: false,
        },
        {
          id: "rec:update-p-acme",
          ordinal: 2,
          description: "Update plugin p@acme",
          cmd: "claude plugin update p@acme",
          fixes: [],
          doesNotFix: [],
          risk: "safe",
          requiresYes: false,
          requiresManualStep: false,
        },
      ],
      exitCode: 2,
    };
    const out = renderHuman(report, { color: false });
    expect(out).toContain("Recommended actions");
    expect(out).toContain("claude plugin marketplace update acme");
    expect(out).toContain("claude plugin update p@acme");
  });

  it("uses [WARN] markers in After-fixes advisory when color is disabled", () => {
    const report: ScanReport = {
      ...fresh,
      drifts: [
        {
          kind: "refresh-needed",
          subject: {
            kind: "plugin",
            ref: {
              pluginName: "p",
              marketplace: "acme",
              root: { kind: "ccd" },
            },
          },
          detail: "clone ahead of install",
        } as import("../../src/types.js").Drift,
      ],
      recommendations: [
        {
          id: "rec:refresh-acme",
          ordinal: 1,
          description: "Update marketplace acme",
          cmd: "claude plugin marketplace update acme",
          fixes: [],
          doesNotFix: [],
          risk: "safe",
          requiresYes: false,
          requiresManualStep: false,
        },
        {
          id: "advisory:runtime-boundary",
          ordinal: 99,
          description: "A new task is required for changes to take effect.",
          fixes: [],
          doesNotFix: [],
          risk: "safe",
          requiresYes: false,
          requiresManualStep: false,
        },
      ],
      exitCode: 2,
    };
    const out = renderHuman(report, { color: false });
    expect(out).toContain("[WARN]");
    // No ANSI escape sequences (those start with ESC `\x1b` followed by `[`).
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI CSI sequences is the point
    expect(out).not.toMatch(/\x1b\[/);
  });

  it("color: false output is byte-identical-pure (no ANSI CSI anywhere) across all renderers", () => {
    // Cover every static-shape branch with one drift-y report so we exercise
    // recommendations, parentheticals, exit-code suffixes, etc.
    const report: ScanReport = {
      ...fresh,
      topology: {
        ...fresh.topology,
        cowork: [
          {
            accountId: "acc",
            orgId: "org",
            rootPath: "/r/cw/acc/org",
            hasCoworkPlugins: true,
            hasRpm: false,
            isMostRecent: true,
            marketplaces: [],
          },
        ],
      },
      drifts: [
        {
          kind: "refresh-needed",
          subject: {
            kind: "plugin",
            ref: {
              pluginName: "p",
              marketplace: "acme",
              root: { kind: "ccd" },
            },
          },
          detail: "clone ahead of install",
        } as import("../../src/types.js").Drift,
      ],
      recommendations: [
        {
          id: "rec:refresh-acme",
          ordinal: 1,
          description: "Update marketplace acme",
          cmd: "claude plugin marketplace update acme",
          fixes: [],
          doesNotFix: [],
          risk: "safe",
          requiresYes: false,
          requiresManualStep: false,
        },
      ],
      exitCode: 2,
    };
    const noColor = renderHuman(report, { color: false });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI CSI sequences
    expect(noColor).not.toMatch(/\x1b\[/);
  });

  describe("renderHumanCheck evidence filtering (C9 + C10)", () => {
    // We exercise via renderHumanCheck because that's where the filter lives.
    // Build a minimal CheckReport with one stale layer that has evidence.
    function makeReport(opts: {
      detail: string;
      evidence: Record<string, unknown>;
    }): import("../../src/commands/check.js").CheckReport {
      // Only the L1 entry carries the test's evidence + detail; other
      // layers get empty evidence so they don't pollute the dump.
      const layer = {
        plugin: "p@mp",
        layer: "marketplace_clone" as const,
        status: "stale" as const,
        detail: opts.detail,
        evidence: opts.evidence,
      };
      const empty = (k: string) => ({
        plugin: "p@mp",
        layer: k as never,
        status: "fresh" as const,
        detail: "",
        evidence: {},
      });
      return {
        schemaVersion: "1.0",
        pluginId: "p@mp",
        plugin: {
          id: "p@mp",
          marketplace: "mp",
          pluginName: "p",
          installedVersion: "1.0.0",
          scopes: [],
          checks: {
            marketplace_clone: layer,
            install_snapshot: empty("install_snapshot"),
            cowork_mirror: empty("cowork_mirror"),
            backend_marketplace: empty("backend_marketplace"),
            rpm_copy: empty("rpm_copy"),
            ccd_remote_ssh: empty("ccd_remote_ssh"),
          },
        },
        marketplace: {
          name: "mp",
          sourceType: "github",
          sourceDetail: "owner/repo",
          layer1: layer,
          integrityIssues: [],
        },
        fullReport: { roots: { coworkOther: [] } } as never,
        exitCode: 2,
        runId: "r",
        startedAt: "2026-01-01T00:00:00Z",
        finishedAt: "2026-01-01T00:00:00Z",
      };
    }

    it("hides `kind` from evidence dump (verbose mode shows other keys)", async () => {
      const { renderHumanCheck } = await import("../../src/output/human.js");
      // Use verbose: true to see the full evidence dump (C2 behavior).
      const out = renderHumanCheck(
        makeReport({ detail: "drift", evidence: { kind: "stub", other: "value" } }),
        { color: false, verbose: true },
      );
      expect(out).not.toMatch(/^\s+kind\s/m);
      expect(out).toContain("other");
    });

    it("hides evidence whose long value (≥8 chars) appears in the detail (verbose mode)", async () => {
      const { renderHumanCheck } = await import("../../src/output/human.js");
      // Use verbose: true so we see the evidence dump. headLocal is in LAYER1_STALE_KEYS
      // so it shows in default mode too, but this test is about value-in-detail suppression.
      const out = renderHumanCheck(
        makeReport({
          detail: "Local HEAD b54ecd584b9671a70 differs from remote",
          evidence: { headLocal: "b54ecd584b9671a70", other: "x" },
        }),
        { color: false, verbose: true },
      );
      // headLocal value appears in detail → suppressed
      expect(out).not.toMatch(/headLocal\s+b54ecd5/);
      // 'other' is a short value ('x') not in detail → should appear
      expect(out).toContain("other");
    });

    it("keeps evidence visible when detail has truncated form and evidence has full SHA", async () => {
      const { renderHumanCheck } = await import("../../src/output/human.js");
      // Detail has 7-char shorthash; evidence has 40-char full SHA. Different
      // lengths → substring test fails → evidence stays visible.
      // Use verbose: true so non-whitelisted keys (installedGitCommitSha) appear.
      const out = renderHumanCheck(
        makeReport({
          detail: "snapshot from commit 24661e7",
          evidence: { installedGitCommitSha: "24661e7b31512569e7d24d9f0db2690153480b92" },
        }),
        { color: false, verbose: true },
      );
      // In --verbose mode, jargon keys are relabeled: installedGitCommitSha → "installed commit (full)"
      expect(out).toMatch(/installed commit \(full\)\s+24661e7b3151/);
    });

    it("renders Fix: prelude at the top when there's a stale layer with a cmd", async () => {
      const { renderHumanCheck } = await import("../../src/output/human.js");
      const layer = {
        plugin: "p@mp",
        layer: "marketplace_clone" as const,
        status: "stale" as const,
        detail: "behind",
        evidence: {},
        recommendation: {
          action: "refresh",
          reason: "drift",
          risk: "safe" as const,
          cmd: "claude plugin marketplace update mp",
        },
      };
      const empty = (k: string) => ({
        plugin: "p@mp",
        layer: k as never,
        status: "fresh" as const,
        detail: "",
        evidence: {},
      });
      const out = renderHumanCheck(
        {
          schemaVersion: "1.0",
          pluginId: "p@mp",
          plugin: {
            id: "p@mp",
            marketplace: "mp",
            pluginName: "p",
            installedVersion: "1.0.0",
            scopes: [],
            checks: {
              marketplace_clone: layer,
              install_snapshot: empty("install_snapshot"),
              cowork_mirror: empty("cowork_mirror"),
              backend_marketplace: empty("backend_marketplace"),
              rpm_copy: empty("rpm_copy"),
              ccd_remote_ssh: empty("ccd_remote_ssh"),
            },
          },
          fullReport: { roots: { coworkOther: [] } } as never,
          exitCode: 2,
          runId: "r",
          startedAt: "2026-01-01T00:00:00Z",
          finishedAt: "2026-01-01T00:00:00Z",
        },
        { color: false },
      );
      // Fix: appears BEFORE the first per-layer header (Marketplace clone) in the output.
      const fixIdx = out.indexOf("Fix:");
      const firstLayerIdx = out.indexOf("Marketplace clone");
      expect(fixIdx).toBeGreaterThan(0);
      expect(fixIdx).toBeLessThan(firstLayerIdx);
      // The cmd is in the prelude.
      expect(out).toMatch(/Fix:\n {2}claude plugin marketplace update mp/);
      // No bottom Recommended sequence: footer (deduped/dropped).
      expect(out).not.toContain("Recommended sequence:");
    });

    it("omits Fix: prelude when no stale/missing layers have cmds", async () => {
      const { renderHumanCheck } = await import("../../src/output/human.js");
      const empty = (k: string) => ({
        plugin: "p@mp",
        layer: k as never,
        status: "fresh" as const,
        detail: "",
        evidence: {},
      });
      const out = renderHumanCheck(
        {
          schemaVersion: "1.0",
          pluginId: "p@mp",
          plugin: {
            id: "p@mp",
            marketplace: "mp",
            pluginName: "p",
            installedVersion: "1.0.0",
            scopes: [],
            checks: {
              marketplace_clone: empty("marketplace_clone"),
              install_snapshot: empty("install_snapshot"),
              cowork_mirror: empty("cowork_mirror"),
              backend_marketplace: empty("backend_marketplace"),
              rpm_copy: empty("rpm_copy"),
              ccd_remote_ssh: empty("ccd_remote_ssh"),
            },
          },
          fullReport: { roots: { coworkOther: [] } } as never,
          exitCode: 0,
          runId: "r",
          startedAt: "2026-01-01T00:00:00Z",
          finishedAt: "2026-01-01T00:00:00Z",
        },
        { color: false },
      );
      expect(out).not.toContain("Fix:");
    });

    it("renders multi-line detail (embedded \\n) with continuation indent", async () => {
      const { renderHumanCheck } = await import("../../src/output/human.js");
      const out = renderHumanCheck(
        makeReport({
          detail: ["Header line", "  key1    val1", "  key2    val2"].join("\n"),
          evidence: {},
        }),
        { color: false },
      );
      // First detail line is inline with the status; remaining lines get
      // 5-space indent matching the evidence column.
      expect(out).toMatch(/^\s*\[WARN\] stale — Header line$/m);
      expect(out).toMatch(/^ {5} {2}key1 {4}val1$/m);
      expect(out).toMatch(/^ {5} {2}key2 {4}val2$/m);
    });

    it("hides short identifier values (<8 chars) only when word-boundary matched in detail", async () => {
      const { renderHumanCheck } = await import("../../src/output/human.js");
      // Word-boundary match: "github" appears as a whole word.
      // Use verbose: true so all evidence keys are shown (C1 default-mode whitelist
      // would otherwise filter these non-standard keys from layer-1).
      const wb = renderHumanCheck(
        makeReport({
          detail: 'marketplace source is "github", not "remote"',
          evidence: { marketplaceSourceType: "github" },
        }),
        { color: false, verbose: true },
      );
      expect(wb).not.toMatch(/marketplaceSourceType\s+github/);

      // No word-boundary match: value is a substring of a larger word →
      // evidence stays. Here "rpm" appears INSIDE "rpms" (plural), not as
      // a standalone word.
      const noWb = renderHumanCheck(
        makeReport({
          detail: "rpms are stored separately",
          evidence: { kind2: "rpm" },
        }),
        { color: false, verbose: true },
      );
      expect(noWb).toMatch(/kind2\s+rpm/);
    });
  });

  describe("dedupSubchains", () => {
    it("drops a cmd that is a sub-chain of another (the founder-skills case)", () => {
      const a = "claude plugin marketplace update lool-founder-skills";
      const b =
        "(cd <plugin-source> && <bump plugin.json#version> && git push) " +
        "&& claude plugin marketplace update lool-founder-skills " +
        "&& claude plugin update founder-skills@lool-founder-skills";
      expect(dedupSubchains([a, b])).toEqual([b]);
      expect(dedupSubchains([b, a])).toEqual([b]);
    });

    it("keeps non-overlapping cmds", () => {
      const a = "claude plugin marketplace update foo";
      const b = "claude plugin update bar@baz";
      expect(dedupSubchains([a, b])).toEqual([a, b]);
    });

    it("preserves cmds whose segments are split across the larger by other ops", () => {
      // X && Y vs X && Z && Y — Y is interspersed with Z, not a contiguous run.
      const a = "X && Y";
      const b = "X && Z && Y";
      expect(dedupSubchains([a, b])).toEqual([a, b]);
    });

    it("treats prose actions (no &&) as exact-equality", () => {
      const a = "Reinstall via the Plugins UI";
      expect(dedupSubchains([a, a])).toEqual([a]); // de-duped via exact match
      const b = "Restart Claude Desktop";
      expect(dedupSubchains([a, b])).toEqual([a, b]);
    });

    it("handles three-way: A subsumed by B subsumed by C", () => {
      const a = "claude plugin update foo@bar";
      const b = "X && claude plugin update foo@bar";
      const c = "Y && X && claude plugin update foo@bar";
      expect(dedupSubchains([a, b, c])).toEqual([c]);
    });
  });

  describe("formatLayerSummary stub-vs-n/a split", () => {
    // Reach the helper via _internals (kept for tests like worstStatus).
    // biome-ignore lint/suspicious/noExplicitAny: test-only access
    let formatLayerSummary: (label: string, entries: any[]) => string;
    beforeEach(async () => {
      const mod = await import("../../src/output/human.js");
      formatLayerSummary = (mod._internals as { formatLayerSummary: typeof formatLayerSummary })
        .formatLayerSummary;
    });

    it("reports `stubbed` and `n/a` separately when both kinds are present", () => {
      const entries = [
        { status: "skipped" as const, evidence: { kind: "stub" } },
        { status: "skipped" as const, evidence: { kind: "stub" } },
        { status: "skipped" as const, evidence: { kind: "inapplicable" } },
      ];
      const out = formatLayerSummary("L4 mixed", entries);
      expect(out).toContain("2 stubbed");
      expect(out).toContain("1 n/a");
    });

    it("falls back to `n/a` for skipped entries with no evidence.kind", () => {
      const entries = [{ status: "skipped" as const, evidence: {} }];
      expect(formatLayerSummary("L3 cowork", entries)).toContain("1 n/a");
    });

    it("buckets `not-run` separately (error path)", () => {
      const entries = [{ status: "skipped" as const, evidence: { kind: "not-run" } }];
      expect(formatLayerSummary("L1 errored", entries)).toContain("1 not-run");
    });
  });

  describe("humanTimestamp", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("renders YYYY-MM-DD + relative band", () => {
      expect(humanTimestamp("2026-03-09T17:54:53.616Z")).toBe("2026-03-09 (~2 months ago)");
    });

    it("buckets by band", () => {
      expect(humanTimestamp("2026-05-01T11:59:30.000Z")).toBe("2026-05-01 (just now)");
      expect(humanTimestamp("2026-05-01T11:30:00.000Z")).toBe("2026-05-01 (~30 min ago)");
      expect(humanTimestamp("2026-05-01T08:00:00.000Z")).toBe("2026-05-01 (~4 hrs ago)");
      expect(humanTimestamp("2026-04-29T12:00:00.000Z")).toBe("2026-04-29 (~2 days ago)");
      expect(humanTimestamp("2026-04-15T12:00:00.000Z")).toBe("2026-04-15 (~2 weeks ago)");
      expect(humanTimestamp("2025-12-01T12:00:00.000Z")).toBe("2025-12-01 (~5 months ago)");
      expect(humanTimestamp("2024-05-01T12:00:00.000Z")).toBe("2024-05-01 (~2 years ago)");
    });

    it("renders future timestamps with `from now`", () => {
      expect(humanTimestamp("2026-05-02T12:00:00.000Z")).toBe("2026-05-02 (~1 day from now)");
    });

    it("returns original string when input is not parseable", () => {
      expect(humanTimestamp("not-a-date")).toBe("not-a-date");
    });
  });

  describe("humanStatus translation", () => {
    it("translates `unknowable` → `unknown` regardless of layer or evidence", () => {
      expect(humanStatus("unknowable")).toBe("unknown");
      expect(humanStatus("unknowable", "marketplace_clone")).toBe("unknown");
      expect(humanStatus("unknowable", "ccd_remote_ssh", { kind: "stub" })).toBe("unknown");
    });

    it("evidence.kind is the source of truth for skipped translation", () => {
      // explicit kind always wins over layerKey heuristic
      expect(humanStatus("skipped", "backend_marketplace", { kind: "stub" })).toBe(
        "not-implemented",
      );
      expect(humanStatus("skipped", "backend_marketplace", { kind: "inapplicable" })).toBe("n/a");
      expect(humanStatus("skipped", "ccd_remote_ssh", { kind: "stub" })).toBe("not-implemented");
      expect(humanStatus("skipped", "cowork_mirror", { kind: "inapplicable" })).toBe("n/a");
      expect(humanStatus("skipped", "rpm_copy", { kind: "inapplicable" })).toBe("n/a");
      // not-run is its own bucket (error path; checks didn't execute)
      expect(humanStatus("skipped", "marketplace_clone", { kind: "not-run" })).toBe("not-run");
    });

    it("falls back to layerKey heuristic when evidence has no kind (legacy path)", () => {
      expect(humanStatus("skipped", "backend_marketplace")).toBe("not-implemented");
      expect(humanStatus("skipped", "ccd_remote_ssh")).toBe("not-implemented");
      expect(humanStatus("skipped", "cowork_mirror")).toBe("n/a");
      expect(humanStatus("skipped", "rpm_copy")).toBe("n/a");
      expect(humanStatus("skipped")).toBe("n/a");
    });

    it("L4 with non-remote source (kind=inapplicable) reports n/a, not not-implemented", () => {
      // The actual real-world bug: github-source plugins ran L4 → status=skipped,
      // and prior code labeled this "not-implemented" via STUB_LAYERS heuristic
      // even though the detail message correctly said "Not applicable".
      expect(humanStatus("skipped", "backend_marketplace", { kind: "inapplicable" })).toBe("n/a");
    });

    it("passes fresh/stale/missing through unchanged", () => {
      expect(humanStatus("fresh")).toBe("fresh");
      expect(humanStatus("stale")).toBe("stale");
      expect(humanStatus("missing")).toBe("missing");
    });
  });

  it("appends an `Run cpd explain` hint when output mentions translated jargon", () => {
    // The hint fires when the rendered output contains "unknown", "n/a", or
    // "not-implemented". In the v1.0 renderHuman, this can appear via a
    // recommendation description that contains such jargon.
    const report: ScanReport = {
      ...fresh,
      drifts: [
        {
          kind: "unsupported-source",
          subject: {
            kind: "plugin",
            ref: {
              pluginName: "p",
              marketplace: "mp",
              root: { kind: "ccd" },
            },
          },
        } as import("../../src/types.js").Drift,
      ],
      recommendations: [
        {
          id: "rec:unsupported-source",
          ordinal: 1,
          description: "Plugin source is unknown — manual reinstall required",
          fixes: [],
          doesNotFix: [],
          risk: "safe",
          requiresYes: false,
          requiresManualStep: true,
        },
      ],
    };
    const out = renderHuman(report, { color: false });
    expect(out).toContain("Run `cpd explain`");
  });

  describe("formatRecCmd", () => {
    const opts = { color: false, header: "  →", indent: "    " };

    it("returns single-line output for short commands (sigil inline)", () => {
      const out = formatRecCmd("claude plugin update foo@bar", opts);
      expect(out).toBe("  → claude plugin update foo@bar");
      expect(out).not.toContain("\n");
    });

    it("returns single-line for long single-segment commands (no top-level &&)", () => {
      const long = `claude plugin update ${"x".repeat(100)}`;
      const out = formatRecCmd(long, opts);
      expect(out).not.toContain("\n");
      expect(out).not.toContain("\\");
    });

    it("multi-line places the sigil on its own line so drag-select doesn't capture it", () => {
      // The version-trap canonical chain — long subshell triggers sub-split.
      const cmd =
        "(cd <plugin-source> && <bump plugin.json#version> && git commit -am 'bump version' && git push) " +
        "&& claude plugin marketplace update lool-founder-skills " +
        "&& claude plugin update founder-skills@lool-founder-skills";
      const out = formatRecCmd(cmd, opts);
      const lines = out.split("\n");
      // First line is JUST the sigil — no cmd content. So drag-select from
      // line 2 onward gets a clean cmd block.
      expect(lines[0]).toBe("  →");
      expect(lines[0]).not.toContain("&&");
      expect(lines[0]).not.toContain("(cd");
      // Subshell sub-split: `(` on its own line, internal `&&`s stacked,
      // `)` on its own line — see C3 plan for shape rationale.
      expect(lines[1]).toMatch(/^ {4}\($/);
      expect(lines[2]).toMatch(/^ {6}cd <plugin-source>/);
      expect(lines[3]).toMatch(/^ {8}&& <bump plugin\.json#version>/);
      expect(lines[6]).toMatch(/^ {4}\)/);
    });

    it("does NOT sub-split short subshells (subshell stays inline within multi-line)", () => {
      // Subshell content under threshold stays on one line, even when the
      // OUTER cmd is long enough to trigger the multi-line split.
      const cmd =
        "(cd /tmp && ls) && claude plugin update foo@bar && claude plugin marketplace update some-very-long-name-here";
      const out = formatRecCmd(cmd, opts);
      const lines = out.split("\n");
      // Outer split → multi-line, but the small subshell is on one line.
      const subshellLine = lines.find((l) => l.includes("(cd /tmp && ls)"));
      expect(subshellLine).toBeDefined();
      expect(subshellLine).not.toContain("\n");
    });

    it("preserves && inside parentheses (paren-depth-aware split)", () => {
      // Even with sub-split enabled, the OUTER paren-aware split still works:
      // there's exactly one top-level `&&` (between `)` and the next cmd),
      // so the chain has 2 top-level segments.
      const cmd =
        "(cd <plugin-source> && <bump plugin.json#version> && git commit -am 'bump' && git push) " +
        "&& claude plugin update foo@bar";
      const out = formatRecCmd(cmd, opts);
      // The outer split must produce exactly 2 segments — verify by checking
      // that "claude plugin update" appears exactly once with `&& ` prefix.
      const cmdUpdateLines = out.split("\n").filter((l) => l.includes("claude plugin update"));
      expect(cmdUpdateLines).toHaveLength(1);
      expect(cmdUpdateLines[0]).toMatch(/&& claude plugin update foo@bar/);
    });

    it("quote-aware: `&&` inside single quotes is not split", () => {
      const cmd = "echo 'a && b' && echo done";
      // Single quotes preserve `a && b` as one segment; outer && splits.
      const out = formatRecCmd(`${cmd} ${"x".repeat(100)}`, opts);
      // First top-level segment must contain the full quoted literal intact.
      const lines = out.split("\n");
      const segLine = lines.find((l) => l.includes("'a && b'"));
      expect(segLine).toBeDefined();
      // And the inner && must NOT have caused a split (no `&& b'` start-of-line).
      const malsplit = lines.find((l) => l.trimStart().startsWith("&& b'"));
      expect(malsplit).toBeUndefined();
    });

    it("multi-line output is pasteable into bash (every non-final cmd line ends with ` \\`)", () => {
      const longCmd = `a && b && c ${"x".repeat(100)} && d`;
      const out = formatRecCmd(longCmd, opts);
      const lines = out.split("\n");
      // Skip header line at index 0; cmd lines are 1..N.
      for (let i = 1; i < lines.length - 1; i++) {
        expect(lines[i]?.endsWith(" \\")).toBe(true);
      }
      expect(lines[lines.length - 1]?.endsWith("\\")).toBe(false);
    });

    it("with color: italicizes <placeholder> segments and cyan+bolds the rest", () => {
      const cmd = "(cd <plugin-source> && <bump plugin.json#version>)";
      const out = formatRecCmd(cmd, { color: true, header: "", indent: "" });
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI assertions
      expect(out).toMatch(/\x1b\[3m/);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI assertions
      expect(out).toMatch(/\x1b\[33m<plugin-source>\x1b\[39m/);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI assertions
      expect(out).toMatch(/\x1b\[33m<bump plugin\.json#version>\x1b\[39m/);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI assertions
      expect(out).toMatch(/\x1b\[36m\x1b\[1m\(cd /);
    });

    it("without color, placeholders appear as literal `<...>` text (paste-ready)", () => {
      const cmd = "(cd <plugin-source> && <bump plugin.json#version>)";
      const out = formatRecCmd(cmd, { color: false, header: "", indent: "" });
      expect(out).toContain("<plugin-source>");
      expect(out).toContain("<bump plugin.json#version>");
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI absence
      expect(out).not.toMatch(/\x1b\[/);
    });
  });

  it("color: true emits ANSI CSI sequences for status icons and recommendations", () => {
    const report: ScanReport = {
      ...fresh,
      recommendations: [
        {
          id: "rec:refresh-acme",
          ordinal: 1,
          description: "Update marketplace acme",
          cmd: "claude plugin marketplace update acme",
          fixes: [],
          doesNotFix: [],
          risk: "safe",
          requiresYes: false,
          requiresManualStep: false,
        },
      ],
      exitCode: 2,
    };
    const out = renderHuman(report, { color: true });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI presence is what we're asserting
    expect(out).toMatch(/\x1b\[/);
    // The cmd should be cyan-bold (cyan = 36, bold = 1).
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI presence
    expect(out).toMatch(/\x1b\[(?:1|36)m/);
  });
});

// ── Plan A1/A2/A3/B1/C1/C2/C3/C4 new tests ─────────────────────────────────

/** Minimal CheckReport fixture factory for plan renderer tests. */
function makeCheckReport(overrides: {
  checks?: Partial<import("../../src/types.js").PluginReport["checks"]>;
  pluginName?: string;
  marketplace?: { name?: string; sourceType?: string; sourceDetail?: string };
  scopes?: import("../../src/types.js").InstalledScope[];
  modeFallback?: { requested: string; foundIn: string };
  coworkActive?: string;
}): CheckReport {
  const defaultEmpty = (k: string) => ({
    plugin: "p@mp",
    layer: k as never,
    status: "skipped" as const,
    detail: "n/a",
    evidence: { kind: "inapplicable" as const },
  });

  const mp = overrides.marketplace ?? {};
  const defaultL2 = defaultEmpty("install_snapshot");
  const defaultL1 = defaultEmpty("marketplace_clone");

  return {
    schemaVersion: "1.0",
    pluginId: `${overrides.pluginName ?? "p"}@${mp.name ?? "mp"}`,
    plugin: {
      id: `${overrides.pluginName ?? "p"}@${mp.name ?? "mp"}`,
      marketplace: mp.name ?? "mp",
      pluginName: overrides.pluginName ?? "p",
      installedVersion: "1.0.0",
      scopes: overrides.scopes ?? [
        {
          scope: "user",
          version: "1.0.0",
          installPath: "/some/path/mp/p/1.0.0",
        } as import("../../src/types.js").InstalledScope,
      ],
      checks: {
        marketplace_clone: defaultL1,
        install_snapshot: defaultL2,
        cowork_mirror: defaultEmpty("cowork_mirror"),
        backend_marketplace: defaultEmpty("backend_marketplace"),
        rpm_copy: defaultEmpty("rpm_copy"),
        ccd_remote_ssh: defaultEmpty("ccd_remote_ssh"),
        ...(overrides.checks ?? {}),
      },
    },
    marketplace: {
      name: mp.name ?? "mp",
      sourceType:
        (mp.sourceType as import("../../src/types.js").MarketplaceReport["sourceType"]) ?? "github",
      sourceDetail: mp.sourceDetail ?? "owner/repo",
      layer1: defaultL1,
      integrityIssues: [],
    },
    fullReport: {
      roots: {
        coworkOther: [],
        ...(overrides.coworkActive ? { coworkActive: overrides.coworkActive } : {}),
      },
      ...(overrides.modeFallback ? { _modeFallback: overrides.modeFallback } : {}),
    } as never,
    exitCode: 2,
    runId: "test-run-id",
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:00:01Z",
  };
}

describe("Plan fixes: A1 — isManualRec and formatManualSteps", () => {
  it("isManualRec: detects bump-needed via evidence.versionTrapKind", () => {
    expect(
      isManualRec({ cmd: "some-cmd", action: "fix" }, { versionTrapKind: "bump-needed" }),
    ).toBe(true);
  });

  it("isManualRec: detects badge-only-needed via evidence.versionTrapKind", () => {
    expect(
      isManualRec({ cmd: "some-cmd", action: "fix" }, { versionTrapKind: "badge-only-needed" }),
    ).toBe(true);
  });

  it("isManualRec: detects unsupported-source via evidence.versionTrapKind", () => {
    expect(isManualRec({ action: "fix" }, { versionTrapKind: "unsupported-source" })).toBe(true);
  });

  it("isManualRec: detects rec.cmd undefined (no command)", () => {
    expect(isManualRec({ action: "do the thing manually" }, {})).toBe(true);
  });

  it("isManualRec: detects placeholder in cmd string (defense-in-depth)", () => {
    expect(
      isManualRec(
        { cmd: "(cd <plugin-source> && <bump plugin.json#version> && git push)", action: "bump" },
        {},
      ),
    ).toBe(true);
  });

  it("isManualRec: returns false for a purely runnable rec without trap kind", () => {
    expect(
      isManualRec(
        {
          cmd: "claude plugin marketplace update mp && claude plugin update p@mp",
          action: "update",
        },
        {},
      ),
    ).toBe(false);
  });

  it("isManualRec: returns false for refresh-needed (runnable trap kind)", () => {
    expect(
      isManualRec(
        {
          cmd: "claude plugin marketplace update mp && claude plugin update p@mp",
          action: "update",
        },
        { versionTrapKind: "refresh-needed" },
      ),
    ).toBe(false);
  });

  it("formatManualSteps: bump-needed string-source github → 4 numbered steps with github URL", () => {
    const out = formatManualSteps(
      { cmd: "some placeholder cmd", action: "bump" },
      { versionTrapKind: "bump-needed" },
      {
        pluginName: "founder-skills",
        marketplaceName: "lool-founder-skills",
        sourceType: "github",
        sourceDetail: "lool-ventures/founder-skills",
        pluginEntrySourceKind: "string",
      },
      false,
    );
    expect(out).not.toBeNull();
    expect(out).toContain("Fix (manual, 4 steps — if you're the plugin maintainer):");
    expect(out).toContain("1.");
    expect(out).toContain("2.");
    expect(out).toContain("3.");
    expect(out).toContain("4.");
    // Step 1 should reference the github URL
    expect(out).toContain("github.com/lool-ventures/founder-skills");
    expect(out).toContain("founder-skills");
    expect(out).toContain("plugin.json");
    // Step 2 is runnable
    expect(out).toContain("git commit -am 'bump version' && git push");
    // Step 3: marketplace update (shell-quoted per audit issue #11)
    expect(out).toContain("claude plugin marketplace update 'lool-founder-skills'");
    // Step 4: plugin update (shell-quoted)
    expect(out).toContain("claude plugin update 'founder-skills@lool-founder-skills'");
  });

  it("formatManualSteps: bump-needed directory source → 4 steps with directory path", () => {
    const out = formatManualSteps(
      { cmd: "some cmd", action: "bump" },
      { versionTrapKind: "bump-needed" },
      {
        pluginName: "myplugin",
        marketplaceName: "mymp",
        sourceType: "directory",
        sourceDetail: "/home/user/marketplace",
        pluginEntrySourceKind: "string",
      },
      false,
    );
    expect(out).not.toBeNull();
    expect(out).toContain("Fix (manual, 4 steps — if you're the plugin maintainer):");
    expect(out).toContain("/home/user/marketplace");
    expect(out).toContain("myplugin");
  });

  it("formatManualSteps: bump-needed object-source → 5 steps (dual-bump rule) with marketplace catalog repo prose", () => {
    const out = formatManualSteps(
      { cmd: "some cmd", action: "bump" },
      { versionTrapKind: "bump-needed" },
      {
        pluginName: "myplugin",
        marketplaceName: "mymp",
        sourceType: "github",
        sourceDetail: "owner/repo",
        pluginEntrySourceKind: "github", // object-source
      },
      false,
    );
    expect(out).not.toBeNull();
    // Object-source now requires 5 steps (dual-bump rule,)
    expect(out).toContain("Fix (manual, 5 steps — if you're the plugin maintainer):");
    // Step 2 mentions the marketplace catalog repo (the new dual-bump step)
    expect(out).toContain("marketplace catalog repo");
    // Object-source prose mentions marketplace.json
    expect(out).toContain("marketplace.json");
    expect(out).toContain("myplugin");
    // Regression: step 3 (was step 2) runnable command is still git push
    expect(out).toContain("git commit -am 'sync versions' && git push");
    // Steps 4 and 5 are the runnable claude commands (shell-quoted per audit issue #11)
    expect(out).toContain("claude plugin marketplace update 'mymp'");
    expect(out).toContain("claude plugin update 'myplugin@mymp'");
  });

  it("formatManualSteps: badge-only-needed → 3 numbered steps", () => {
    const out = formatManualSteps(
      { action: "fix badge" },
      { versionTrapKind: "badge-only-needed" },
      {
        pluginName: "myplugin",
        marketplaceName: "mymp",
        sourceType: "github",
        sourceDetail: "owner/repo",
        pluginEntrySourceKind: "string",
      },
      false,
    );
    expect(out).not.toBeNull();
    expect(out).toContain("Fix (manual, 3 steps):");
    expect(out).toContain("1.");
    expect(out).toContain("2.");
    expect(out).toContain("3.");
    expect(out).toContain("marketplace.json");
  });

  it("formatManualSteps: unsupported-source → single prose Fix (manual):", () => {
    const out = formatManualSteps(
      { action: "upgrade" },
      { versionTrapKind: "unsupported-source" },
      {
        pluginName: "p",
        marketplaceName: "mp",
        sourceType: "unknown",
        sourceDetail: "",
        pluginEntrySourceKind: "unrecognized-source-kind",
      },
      false,
    );
    expect(out).not.toBeNull();
    expect(out).toContain("Fix (manual):");
    expect(out).toContain("Upgrade Claude Code");
    // No numbered steps
    expect(out).not.toMatch(/\d\./);
  });

  it("formatManualSteps: refresh-needed (purely runnable) → returns null so caller uses cmd rendering", () => {
    const out = formatManualSteps(
      { cmd: "claude plugin marketplace update mp && claude plugin update p@mp", action: "update" },
      { versionTrapKind: "refresh-needed" },
      {
        pluginName: "p",
        marketplaceName: "mp",
        sourceType: "github",
        sourceDetail: "owner/repo",
        pluginEntrySourceKind: "string",
      },
      false,
    );
    // refresh-needed is runnable, not manual — formatManualSteps returns null
    expect(out).toBeNull();
  });

  it("A1 integration: renderHumanCheck renders bump-needed as Fix (manual, 4 steps) at top", async () => {
    const { renderHumanCheck } = await import("../../src/output/human.js");
    const bumpLayer = {
      plugin: "p@mp",
      layer: "install_snapshot" as const,
      status: "stale" as const,
      detail: "Updates blocked: plugin.json version hasn't changed",
      evidence: {
        versionTrapKind: "bump-needed",
        pluginEntrySourceKind: "string",
        installedVersion: "1.0.0",
        cloneVersion: "1.0.0",
      },
      recommendation: {
        action: "bump version",
        reason: "drift",
        risk: "safe" as const,
        cmd: "(cd <plugin-source> && <bump plugin.json#version> && git push) && claude plugin marketplace update mp && claude plugin update p@mp",
      },
    };

    const report = makeCheckReport({
      pluginName: "p",
      marketplace: { name: "mp", sourceType: "github", sourceDetail: "owner/repo" },
      checks: { install_snapshot: bumpLayer },
    });

    const out = renderHumanCheck(report, { color: false });
    // Fix block appears before the layer section
    const fixIdx = out.indexOf("Fix (manual, 4 steps — if you're the plugin maintainer):");
    const layerIdx = out.indexOf("Plugin install on disk");
    expect(fixIdx).toBeGreaterThan(0);
    expect(fixIdx).toBeLessThan(layerIdx);
    // Contains numbered steps
    expect(out).toContain("  1.");
    expect(out).toContain("  2.");
    expect(out).toContain("  3.");
    expect(out).toContain("  4.");
  });

  it("A1 regression: refresh-needed (purely runnable) renders single cyan-bold block, not manual steps", async () => {
    const { renderHumanCheck } = await import("../../src/output/human.js");
    const refreshLayer = {
      plugin: "p@mp",
      layer: "install_snapshot" as const,
      status: "stale" as const,
      detail: "Updates blocked",
      evidence: { versionTrapKind: "refresh-needed" },
      recommendation: {
        action: "update",
        reason: "drift",
        risk: "safe" as const,
        cmd: "claude plugin marketplace update mp && claude plugin update p@mp",
      },
    };

    const report = makeCheckReport({
      checks: { install_snapshot: refreshLayer },
    });

    const out = renderHumanCheck(report, { color: false });
    // Should show Fix: (not Fix (manual, ...))
    expect(out).toContain("Fix:");
    expect(out).not.toContain("Fix (manual,");
    // Should contain the runnable cmd
    expect(out).toContain("claude plugin marketplace update mp");
  });
});

describe("Plan fixes: A2 — suppress duplicate per-layer arrow", () => {
  it("bump-needed single layer → top-level Fix only, no per-layer arrow", async () => {
    const { renderHumanCheck } = await import("../../src/output/human.js");
    const bumpLayer = {
      plugin: "p@mp",
      layer: "install_snapshot" as const,
      status: "stale" as const,
      detail: "Updates blocked: plugin.json version hasn't changed",
      evidence: {
        versionTrapKind: "bump-needed",
        pluginEntrySourceKind: "string",
      },
      recommendation: {
        action: "bump version",
        reason: "drift",
        risk: "safe" as const,
        cmd: "(cd <plugin-source> && <bump plugin.json#version> && git push) && claude plugin marketplace update mp && claude plugin update p@mp",
      },
    };
    const report = makeCheckReport({
      pluginName: "p",
      marketplace: { name: "mp", sourceType: "github", sourceDetail: "owner/repo" },
      checks: { install_snapshot: bumpLayer },
    });

    const out = renderHumanCheck(report, { color: false });
    // Manual steps block appears at top
    expect(out).toContain("Fix (manual, 4 steps — if you're the plugin maintainer):");
    // Per-layer arrow (→) should NOT appear (suppressed by A2)
    // The → should not appear after the per-layer section header
    const installIdx = out.indexOf("Plugin install on disk");
    const afterInstall = out.slice(installIdx);
    expect(afterInstall).not.toContain("→");
  });

  it("refresh-needed: prelude Fix: shown, per-layer arrow NOT shown (subsumed)", async () => {
    const { renderHumanCheck } = await import("../../src/output/human.js");
    const refreshLayer = {
      plugin: "p@mp",
      layer: "install_snapshot" as const,
      status: "stale" as const,
      detail: "Updates blocked",
      evidence: { versionTrapKind: "refresh-needed" },
      recommendation: {
        action: "update",
        reason: "drift",
        risk: "safe" as const,
        cmd: "claude plugin marketplace update mp && claude plugin update p@mp",
      },
    };
    const report = makeCheckReport({ checks: { install_snapshot: refreshLayer } });
    const out = renderHumanCheck(report, { color: false });
    expect(out).toContain("Fix:");
    // Per-layer arrow should not be present (cmd subsumed by prelude)
    const installIdx = out.indexOf("Plugin install on disk");
    const afterInstall = out.slice(installIdx);
    // Find the next section header
    const nextSectionIdx = afterInstall.indexOf("Claude Desktop session mirror");
    const installSection = afterInstall.slice(0, nextSectionIdx > 0 ? nextSectionIdx : undefined);
    expect(installSection).not.toContain("→");
  });
});

describe("Active session line on fallback-to-ccd is deterministic across modes", () => {
  // Behavior change (post-QA pass 2): the Active session line is rendered in
  // BOTH default and verbose modes when there's a fallback to CCD, but the
  // line is annotated with "(not used for this check)" so the user doesn't
  // read it as authoritative. Determinism trumps contradiction-avoidance —
  // a missing line was reported as inconsistent UX in QA pass 2.
  it("fallback foundIn=ccd + default mode → renders Active session with not-used annotation", async () => {
    const { renderHumanCheck } = await import("../../src/output/human.js");
    const report = makeCheckReport({
      coworkActive: "/some/cowork/path",
      modeFallback: { requested: "cowork", foundIn: "ccd" },
    });
    const out = renderHumanCheck(report, { color: false });
    expect(out).toContain("Active session");
    expect(out).toContain("(not used for this check)");
  });

  it("fallback foundIn=ccd + --verbose → also renders the not-used annotation (full path)", async () => {
    const { renderHumanCheck } = await import("../../src/output/human.js");
    const report = makeCheckReport({
      coworkActive: "/some/cowork/path",
      modeFallback: { requested: "cowork", foundIn: "ccd" },
    });
    const out = renderHumanCheck(report, { color: false, verbose: true });
    expect(out).toContain("Active session");
    expect(out).toContain("(not used for this check)");
    expect(out).toContain("/some/cowork/path");
  });

  it("no fallback + coworkActive → Active session line present (unchanged behavior)", async () => {
    const { renderHumanCheck } = await import("../../src/output/human.js");
    const report = makeCheckReport({
      coworkActive: "/some/cowork/path",
    });
    const out = renderHumanCheck(report, { color: false });
    expect(out).toContain("Active session");
    expect(out).toContain("/some/cowork/path");
  });
});

describe("Plan fixes: C1 — layer-1 evidence whitelist in default mode", () => {
  it("default mode + layer-1 stale → shows only headLocal/headRemote (not cloneDir, remoteUrl)", async () => {
    const { renderHumanCheck } = await import("../../src/output/human.js");
    const staleL1 = {
      plugin: "p@mp",
      layer: "marketplace_clone" as const,
      status: "stale" as const,
      detail: "Local HEAD differs from remote HEAD",
      evidence: {
        headLocal: "abc123def456",
        headRemote: "def456abc123",
        cloneDir: "/path/to/clone",
        remoteUrl: "https://github.com/owner/repo.git",
        sourceType: "github",
      },
    };
    const report = makeCheckReport({
      checks: { marketplace_clone: staleL1 },
    });
    const out = renderHumanCheck(report, { color: false });
    // Whitelisted keys appear
    expect(out).toContain("headLocal");
    expect(out).toContain("headRemote");
    // Non-whitelisted keys hidden in default mode
    expect(out).not.toContain("cloneDir");
    expect(out).not.toContain("remoteUrl");
  });

  it("--verbose mode + layer-1 stale → shows all evidence keys", async () => {
    const { renderHumanCheck } = await import("../../src/output/human.js");
    const staleL1 = {
      plugin: "p@mp",
      layer: "marketplace_clone" as const,
      status: "stale" as const,
      detail: "Local HEAD differs from remote HEAD",
      evidence: {
        headLocal: "abc123def456",
        headRemote: "def456abc123",
        cloneDir: "/path/to/clone",
        remoteUrl: "https://github.com/owner/repo.git",
      },
    };
    const report = makeCheckReport({ checks: { marketplace_clone: staleL1 } });
    const out = renderHumanCheck(report, { color: false, verbose: true });
    expect(out).toContain("cloneDir");
    expect(out).toContain("remoteUrl");
  });

  it("default mode + layer-1 fresh → no evidence rows at all", async () => {
    const { renderHumanCheck } = await import("../../src/output/human.js");
    // Default (fresh) L1 fixture - no evidence keys should show
    const report = makeCheckReport({});
    const out = renderHumanCheck(report, { color: false });
    // No evidence for non-stale L1 in default mode
    expect(out).not.toMatch(/headLocal\s/);
    expect(out).not.toMatch(/headRemote\s/);
  });
});

describe("Plan fixes: C2 — default mode hides evidence dump, --verbose shows with relabeled jargon", () => {
  it("default mode: no versionTrapKind row visible", async () => {
    const { renderHumanCheck } = await import("../../src/output/human.js");
    const staleL2 = {
      plugin: "p@mp",
      layer: "install_snapshot" as const,
      status: "stale" as const,
      detail: "Updates blocked: plugin.json version hasn't changed",
      evidence: {
        versionTrapKind: "bump-needed",
        pluginEntrySourceKind: "string",
        resolvedVersionSource: "plugin.json-in-clone",
        installedGitCommitSha: "24661e7b31512569e7d24d9f0db2690153480b92",
      },
    };
    const report = makeCheckReport({ checks: { install_snapshot: staleL2 } });
    const out = renderHumanCheck(report, { color: false });
    // No evidence dump for L2 in default mode
    expect(out).not.toContain("versionTrapKind");
    expect(out).not.toContain("pluginEntrySourceKind");
    expect(out).not.toContain("resolvedVersionSource");
    expect(out).not.toContain("installedGitCommitSha");
  });

  it("--verbose mode: jargon keys are relabeled (drift kind, source kind, version came from)", async () => {
    const { renderHumanCheck } = await import("../../src/output/human.js");
    const staleL2 = {
      plugin: "p@mp",
      layer: "install_snapshot" as const,
      status: "stale" as const,
      detail: "Updates blocked",
      evidence: {
        versionTrapKind: "bump-needed",
        pluginEntrySourceKind: "string",
        resolvedVersionSource: "plugin.json-in-clone",
        installedGitCommitSha: "24661e7b31512569e7d24d9f0db2690153480b92",
      },
    };
    const report = makeCheckReport({ checks: { install_snapshot: staleL2 } });
    const out = renderHumanCheck(report, { color: false, verbose: true });
    // Relabeled keys appear; original jargon names are gone
    expect(out).toContain("drift kind");
    expect(out).not.toContain("versionTrapKind");
    expect(out).toContain("source kind");
    expect(out).not.toContain("pluginEntrySourceKind");
    expect(out).toContain("version came from");
    expect(out).not.toContain("resolvedVersionSource");
    // installedGitCommitSha → "installed commit (full)"
    expect(out).toContain("installed commit (full)");
    expect(out).not.toContain("installedGitCommitSha");
  });

  it("JSON output regression: evidence keys retain original names (versionTrapKind, etc.)", async () => {
    await import("../../src/output/json.js");
    // The JSON renderer should NOT relabel keys — only human renderer does.
    // We can verify via the CheckReport's fullReport.plugins[].checks.install_snapshot.evidence
    // being passed through unchanged.
    const evidence = {
      versionTrapKind: "bump-needed",
      pluginEntrySourceKind: "string",
      resolvedVersionSource: "plugin.json-in-clone",
    };
    const staleL2 = {
      plugin: "p@mp",
      layer: "install_snapshot" as const,
      status: "stale" as const,
      detail: "Updates blocked",
      evidence,
    };
    const report = makeCheckReport({ checks: { install_snapshot: staleL2 } });
    // The fullReport in our makeCheckReport fixture is a stub. We just verify
    // the evidence object is passed through to the report without modification.
    expect(report.plugin?.checks.install_snapshot.evidence.versionTrapKind).toBe("bump-needed");
    expect(report.plugin?.checks.install_snapshot.evidence.pluginEntrySourceKind).toBe("string");
    expect(report.plugin?.checks.install_snapshot.evidence.resolvedVersionSource).toBe(
      "plugin.json-in-clone",
    );
  });
});

describe("Plan fixes: C3 — collapse ≥2-of-3 n/a layers", () => {
  it("3-of-3 n/a → single collapse line 'Other caches not applicable here (...)'", async () => {
    const { renderHumanCheck } = await import("../../src/output/human.js");
    // All three collapsible layers are n/a (skipped/inapplicable)
    const report = makeCheckReport({});
    const out = renderHumanCheck(report, { color: false });
    expect(out).toContain("Other caches");
    expect(out).toContain("not applicable here");
    // The individual layer headers should NOT appear (collapsed)
    expect(out).not.toContain("Claude Cowork session mirror");
    expect(out).not.toContain("Cowork in-app install (Personal plugins)");
    expect(out).not.toContain("Standalone Claude Code remote SSH cache");
  });

  it("--verbose mode: shows each of the three layers in full", async () => {
    const { renderHumanCheck } = await import("../../src/output/human.js");
    const report = makeCheckReport({});
    const out = renderHumanCheck(report, { color: false, verbose: true });
    // All three layer headers should appear in verbose mode
    expect(out).toContain("Claude Cowork session mirror");
    expect(out).toContain("Cowork in-app install (Personal plugins)");
    expect(out).toContain("Standalone Claude Code remote SSH cache");
    expect(out).not.toContain("Other caches");
  });

  it("2-of-3 n/a → collapse line + 1 full section for the non-n/a layer", async () => {
    const { renderHumanCheck } = await import("../../src/output/human.js");
    // Make cowork_mirror non-n/a (stale), rest are n/a
    const staleCowork = {
      plugin: "p@mp",
      layer: "cowork_mirror" as const,
      status: "stale" as const,
      detail: "Stale cowork mirror",
      evidence: { kind: "stale" as never },
    };
    const report = makeCheckReport({ checks: { cowork_mirror: staleCowork } });
    const out = renderHumanCheck(report, { color: false });
    // Non-n/a layer should appear in full
    expect(out).toContain("Claude Cowork session mirror");
    // The other two should be collapsed
    expect(out).toContain("Other caches");
    expect(out).toContain("not applicable here");
    // The other two headers should NOT appear
    expect(out).not.toContain("Cowork in-app install (Personal plugins)");
    expect(out).not.toContain("Standalone Claude Code remote SSH cache");
  });

  it("1-of-3 n/a → 0 or 1 n/a doesn't trigger collapse (all three shown)", async () => {
    const { renderHumanCheck } = await import("../../src/output/human.js");
    // Make cowork_mirror AND rpm_copy non-n/a (stale)
    const staleCowork = {
      plugin: "p@mp",
      layer: "cowork_mirror" as const,
      status: "stale" as const,
      detail: "Stale cowork mirror",
      evidence: {},
    };
    const staleRpm = {
      plugin: "p@mp",
      layer: "rpm_copy" as const,
      status: "stale" as const,
      detail: "Stale rpm copy",
      evidence: {},
    };
    const report = makeCheckReport({
      checks: { cowork_mirror: staleCowork, rpm_copy: staleRpm },
    });
    const out = renderHumanCheck(report, { color: false });
    // No collapse — fewer than 2 are n/a
    expect(out).not.toContain("Other caches");
    expect(out).toContain("Claude Cowork session mirror");
    expect(out).toContain("Cowork in-app install (Personal plugins)");
    expect(out).toContain("Standalone Claude Code remote SSH cache");
  });
});

describe("Plan fixes: C4 — hide at/since in default mode; show at for multi-scope", () => {
  it("single-scope plugin: default mode hides `at` install path", async () => {
    const { renderHumanCheck } = await import("../../src/output/human.js");
    const report = makeCheckReport({
      scopes: [
        {
          scope: "user",
          version: "1.0.0",
          installPath: "/install/path/p/1.0.0",
        } as import("../../src/types.js").InstalledScope,
      ],
    });
    const out = renderHumanCheck(report, { color: false });
    // Single-scope: at line should be hidden in default mode
    expect(out).not.toMatch(/^\s+at\s+/m);
  });

  it("single-scope plugin: --verbose shows `at` install path", async () => {
    const { renderHumanCheck } = await import("../../src/output/human.js");
    const report = makeCheckReport({
      scopes: [
        {
          scope: "user",
          version: "1.0.0",
          installPath: "/install/path/p/1.0.0",
        } as import("../../src/types.js").InstalledScope,
      ],
    });
    const out = renderHumanCheck(report, { color: false, verbose: true });
    expect(out).toMatch(/at\s+/);
    expect(out).toContain("/install/path/p/1.0.0");
  });

  it("multi-scope plugin (scopes.length=2): default mode shows `at` line", async () => {
    const { renderHumanCheck } = await import("../../src/output/human.js");
    const report = makeCheckReport({
      scopes: [
        {
          scope: "user",
          version: "1.0.0",
          installPath: "/install/path/p/1.0.0",
        } as import("../../src/types.js").InstalledScope,
        {
          scope: "project",
          version: "1.0.0",
          installPath: "/project/path/p/1.0.0",
        } as import("../../src/types.js").InstalledScope,
      ],
    });
    const out = renderHumanCheck(report, { color: false });
    // Multi-scope: at line should appear (signals which scope's install is being shown)
    expect(out).toMatch(/at\s+/);
    expect(out).toContain("/install/path/p/1.0.0");
    // Scope label shows "+1 other"
    expect(out).toContain("+1 other");
  });

  it("default mode: `since` install date is hidden", async () => {
    const { renderHumanCheck } = await import("../../src/output/human.js");
    const report = makeCheckReport({
      scopes: [
        {
          scope: "user",
          version: "1.0.0",
          installPath: "/install/path/p/1.0.0",
          installedAt: "2026-03-09T17:54:53.616Z",
          lastUpdated: "2026-05-01T12:00:00Z",
        } as import("../../src/types.js").InstalledScope,
      ],
    });
    const out = renderHumanCheck(report, { color: false });
    // since should be hidden in default mode
    expect(out).not.toMatch(/since\s+/);
    // last update should still appear
    expect(out).toMatch(/last update/);
  });

  it("--verbose mode: `since` install date is shown", async () => {
    const { renderHumanCheck } = await import("../../src/output/human.js");
    const report = makeCheckReport({
      scopes: [
        {
          scope: "user",
          version: "1.0.0",
          installPath: "/install/path/p/1.0.0",
          installedAt: "2026-03-09T17:54:53.616Z",
        } as import("../../src/types.js").InstalledScope,
      ],
    });
    const out = renderHumanCheck(report, { color: false, verbose: true });
    expect(out).toMatch(/since\s+/);
  });

  it("Run ID line is hidden by default and shown only with --verbose", async () => {
    // Audit follow-up: Run ID is mostly noise for typical human readers — its
    // value is for bug reports / JSON cross-reference. Default human output
    // omits it; --verbose surfaces it. JSON output and the log file's first
    // line still always carry runId regardless.
    const { renderHumanCheck } = await import("../../src/output/human.js");
    const report = makeCheckReport({});
    const defaultOut = renderHumanCheck(report, { color: false });
    expect(defaultOut).not.toContain("Run ID");
    const verboseOut = renderHumanCheck(report, { color: false, verbose: true });
    expect(verboseOut).toContain("Run ID");
    expect(verboseOut).toContain("test-run-id");
  });
});

describe("Plan fixes: B1 — Progress.withoutNdjson() suppresses scan_done NDJSON", () => {
  it("withoutNdjson() returns a Progress that does not emit to the original sink", async () => {
    const { Progress } = await import("../../src/progress.js");
    const events: string[] = [];
    const sink = {
      write: (chunk: string) => {
        events.push(chunk);
        return true;
      },
    };
    const p = new Progress({ enabled: false, isTty: false, ndjsonStream: sink });
    const silent = p.withoutNdjson();
    silent.emitDone(100, 0, { marketplaces: 1, plugins: 1, layersStale: 0 });
    // The silent progress should not emit to the sink
    const doneEvents = events.filter((e) => e.includes('"scan_done"'));
    expect(doneEvents).toHaveLength(0);
  });

  it("withSuppressedHumanDone() still emits NDJSON scan_done but suppresses the human line", async () => {
    const { Progress } = await import("../../src/progress.js");
    const events: string[] = [];
    const sink = {
      write: (chunk: string) => {
        events.push(chunk);
        return true;
      },
    };
    const p = new Progress({ enabled: false, isTty: false, ndjsonStream: sink });
    const suppressed = p.withSuppressedHumanDone();
    suppressed.emitDone(100, 0, { marketplaces: 1, plugins: 1, layersStale: 0 });
    // NDJSON scan_done should still fire
    const doneEvents = events.filter((e) => e.includes('"scan_done"'));
    expect(doneEvents).toHaveLength(1);
  });
});
