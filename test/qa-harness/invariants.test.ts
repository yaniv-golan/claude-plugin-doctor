// QA-harness cross-command invariants.
//
// Each test is parameterized over every fixture under
// `test/qa-harness/fixtures/`. Per-fixture: build a synthetic HOME via
// `setup.sh`, run cpd commands against it, assert structural cross-
// command properties.
//
// IT-1..IT-10:  cross-command invariants (counts/identities) that work
//               against the basic wire shape.
// IT-11..IT-17: prior-art baselines from PLAN-prior-art-integration.md
//               (conditionId, instance id, recipes, summary, runId
//               UUIDv4, ISO-8601-Z timestamps). Hard-fail since v0.1.0
//               shipped these.
// IT-18..IT-20: prior-art coverage gaps closed post Step-8 meta-review:
//               IT-18 — Drift.kind union frozen (locks against renames)
//               IT-19 — ErrorEnvelope shape (.ok / .code / .message /
//                       .runId well-formed when emitted)
//               IT-20 — --no-network suppression assertion
//                       (upstreams[*].status == "no-network")

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HARNESS_DIR = path.join(__dirname);
const FIXTURES_DIR = path.join(HARNESS_DIR, "fixtures");
const ORACLES_DIR = path.join(HARNESS_DIR, "oracles");
const CPD_BIN = path.join(__dirname, "..", "..", "dist", "cli.js");

type RunResult = { stdout: string; stderr: string; exit: number };

function runCpd(home: string, args: string[]): RunResult {
  const r = spawnSync(
    CPD_BIN,
    [...args, "--json", "--no-progress", "--no-log-file", "--no-network"],
    {
      env: { HOME: home, PATH: process.env.PATH ?? "" },
      encoding: "utf8",
      // Default is 1 MB. The `truly-massive` perf fixture (1000
      // plugins) emits ~2 MB scan reports; bump to a comfortable margin.
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return { stdout: r.stdout, stderr: r.stderr, exit: r.status ?? 0 };
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function isErrorEnvelope(j: unknown): boolean {
  return (
    typeof j === "object" &&
    j !== null &&
    (j as Record<string, unknown>).ok === false &&
    typeof (j as Record<string, unknown>).code === "string"
  );
}

const CONDITION_ID_RE = /^[a-z_][a-z_0-9]*:[a-z_][a-z_0-9]*$/;
const ISO_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
// Instance-id contract that v0.1.0 actually shipped (per
// src/recommendations/{catalog,plan}.ts):
//   - `action:<drift-kind>:<refKey>`   (catalog-emitted, per-plugin)
//   - `advisory:<topic>`               (plan.ts-emitted advisories)
// The kebab-case parts can include any chars except colon. The
// pre-prior-art prediction of `<conditionId>#<refKey-or-agg-N>` did NOT
// ship — implementation evolved to the simpler scheme.
const INSTANCE_ID_RE = /^(action|advisory):[a-z][a-z0-9-]*(:[^:]+)*$/;
// runId: UUIDv4 per CONVENTIONS pack (src/refs.ts:53). NOT ULID — that
// was explicitly rejected to avoid invalidating captured fixtures.
const RUNID_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Fixtures excluded from the fast tier (the default `npm test` run).
// `truly-massive` builds 1000 plugins / 50 marketplaces — too slow for
// per-PR feedback. Set CPD_QA_HARNESS_FULL=1 (set automatically by
// `npm run qa-harness:full`) to include them.
const FAST_TIER_EXCLUSIONS = new Set(["truly-massive"]);
const FULL_MODE = process.env.CPD_QA_HARNESS_FULL === "1";

const fixtures = fs
  .readdirSync(FIXTURES_DIR)
  .filter((f) => fs.existsSync(path.join(FIXTURES_DIR, f, "setup.sh")))
  .filter((f) => FULL_MODE || !FAST_TIER_EXCLUSIONS.has(f));

// Sanity: harness binary built.
if (!fs.existsSync(CPD_BIN)) {
  throw new Error(`${CPD_BIN} not found. Run \`npm run build\` first.`);
}

for (const fixture of fixtures) {
  describe(`fixture: ${fixture}`, () => {
    let home: string;

    // Resolve the active expected block (handles current/desired/active).
    const expectedFile = path.join(FIXTURES_DIR, fixture, "expected.json");
    const expectedRoot = JSON.parse(fs.readFileSync(expectedFile, "utf8")) as Record<
      string,
      unknown
    >;
    const active = typeof expectedRoot.active === "string" ? (expectedRoot.active as string) : "";
    const expected =
      (active ? (expectedRoot[active] as Record<string, unknown>) : expectedRoot) ?? {};

    beforeAll(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), `qa-harness-${fixture}-`));
      const setup = spawnSync("bash", [path.join(FIXTURES_DIR, fixture, "setup.sh"), home], {
        encoding: "utf8",
      });
      if (setup.status !== 0) {
        throw new Error(`setup.sh failed for ${fixture}: ${setup.stderr || setup.stdout}`);
      }
    });

    afterAll(() => {
      if (home) fs.rmSync(home, { recursive: true, force: true });
    });

    // ─── Helpers that lazy-run cpd commands and parse JSON ─────────────
    let _scan: unknown | undefined;
    let _list: unknown | undefined;
    let _topology: unknown | undefined;
    const scan = (): { json: unknown; result: RunResult } => {
      const result = runCpd(home, ["scan"]);
      _scan ??= tryParse(result.stdout);
      return { json: _scan, result };
    };
    const list = (): { json: unknown; result: RunResult } => {
      const result = runCpd(home, ["list"]);
      _list ??= tryParse(result.stdout);
      return { json: _list, result };
    };
    const topology = (): { json: unknown; result: RunResult } => {
      const result = runCpd(home, ["topology"]);
      _topology ??= tryParse(result.stdout);
      return { json: _topology, result };
    };

    // ─── IT-1: list plugin count == scan caches plugin count ────────────
    // Scan keys are `<plugin>@<mp>#<rootKey>`; collapse to `<plugin>@<mp>` for
    // comparison since list reports one row per id (deduped across roots).
    it("IT-1: list plugin count == scan distinct plugin count", () => {
      const { json: l } = list();
      const { json: s } = scan();
      if (isErrorEnvelope(l) || isErrorEnvelope(s)) return; // not applicable
      const lp = (l as { plugins?: unknown[] }).plugins;
      const sc = (s as { caches?: Record<string, unknown> }).caches;
      if (!Array.isArray(lp) || !sc) return;
      const distinctScanKeys = new Set(Object.keys(sc).map((k) => k.split("#")[0]));
      expect(lp.length).toBe(distinctScanKeys.size);
    });

    // ─── IT-2: topology cowork count consistent across topology and scan ──
    it("IT-2: topology cowork count is consistent across commands", () => {
      const { json: t } = topology();
      const { json: s } = scan();
      if (isErrorEnvelope(t) || isErrorEnvelope(s)) return;
      const tc = (t as { topology?: { cowork?: unknown[] } }).topology?.cowork;
      const sc = (s as { topology?: { cowork?: unknown[] } }).topology?.cowork;
      if (!Array.isArray(tc) || !Array.isArray(sc)) return;
      expect(tc.length).toBe(sc.length);
    });

    // ─── IT-3: For every plugin in list, check reports same installed version ─
    it("IT-3: list installedVersion == check.plugin.installedVersion", () => {
      const { json: l } = list();
      if (isErrorEnvelope(l)) return;
      const plugins = (l as { plugins?: Array<{ id: string; installedVersion?: string }> }).plugins;
      if (!Array.isArray(plugins) || plugins.length === 0) return;
      for (const p of plugins) {
        const checkRes = runCpd(home, ["check", p.id]);
        const cj = tryParse(checkRes.stdout) as
          | { plugin?: { installedVersion?: string } }
          | undefined;
        if (!cj || isErrorEnvelope(cj as unknown)) continue;
        if (cj.plugin?.installedVersion !== undefined) {
          expect(cj.plugin.installedVersion).toBe(p.installedVersion);
        }
      }
    });

    // ─── IT-4 + IT-5: orphan oracle agreement (count + total bytes) ──────
    it("IT-4: cache --orphans count matches independent oracle", () => {
      const cacheRes = runCpd(home, ["cache", "--orphans"]);
      const cj = tryParse(cacheRes.stdout) as
        | { orphans?: unknown[]; totalOrphanBytes?: number }
        | undefined;
      if (!cj) return;
      const oracle = spawnSync("bash", [path.join(ORACLES_DIR, "orphans.sh"), home], {
        encoding: "utf8",
      });
      const oj = tryParse(oracle.stdout) as
        | { orphans?: unknown[]; totalOrphanBytes?: number }
        | undefined;
      if (!oj) return;
      expect(cj.orphans?.length ?? 0).toBe(oj.orphans?.length ?? 0);
    });

    it("IT-5: cache --orphans total bytes within 5% of oracle", () => {
      const cacheRes = runCpd(home, ["cache", "--orphans"]);
      const cj = tryParse(cacheRes.stdout) as { totalOrphanBytes?: number } | undefined;
      if (!cj) return;
      const oracle = spawnSync("bash", [path.join(ORACLES_DIR, "orphans.sh"), home], {
        encoding: "utf8",
      });
      const oj = tryParse(oracle.stdout) as { totalOrphanBytes?: number } | undefined;
      if (!oj) return;
      const cpd = cj.totalOrphanBytes ?? 0;
      const expectedBytes = oj.totalOrphanBytes ?? 0;
      if (cpd === 0 && expectedBytes === 0) return;
      const denom = Math.max(Math.abs(cpd), Math.abs(expectedBytes));
      expect(Math.abs(cpd - expectedBytes) / denom).toBeLessThanOrEqual(0.05);
    });

    // ─── IT-6: scan idempotency ───────────────────────────────────────────
    it("IT-6: scan output is stable modulo volatile fields", () => {
      const r1 = runCpd(home, ["scan"]);
      const r2 = runCpd(home, ["scan"]);
      const a = tryParse(r1.stdout);
      const b = tryParse(r2.stdout);
      if (!a || !b || isErrorEnvelope(a) || isErrorEnvelope(b)) return;
      const strip = (j: unknown): unknown => {
        if (Array.isArray(j)) return j.map(strip);
        if (j && typeof j === "object") {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(j)) {
            if (
              k === "runId" ||
              k === "startedAt" ||
              k === "finishedAt" ||
              k === "scannedAt" ||
              k === "parsedAt" ||
              k === "logFile" ||
              k === "installedPluginsMtime"
            ) {
              continue;
            }
            out[k] = strip(v);
          }
          return out;
        }
        return j;
      };
      expect(strip(a)).toEqual(strip(b));
    });

    // ─── IT-7: schemaVersion is "1.0" on every report (excluding cache) ───
    it("IT-7: schemaVersion is '1.0' on every report that carries one", () => {
      // cache --orphans intentionally has no schemaVersion today
      // (CacheOrphansReport — src/commands/cache.ts:79). Excluded.
      for (const cmd of [["scan"] as string[], ["list"] as string[], ["topology"] as string[]]) {
        const r = runCpd(home, cmd);
        const j = tryParse(r.stdout);
        if (!j || isErrorEnvelope(j)) continue;
        if (typeof (j as { schemaVersion?: unknown }).schemaVersion === "string") {
          expect((j as { schemaVersion: string }).schemaVersion).toBe("1.0");
        }
      }
    });

    // ─── IT-8: every "present"-presence evidence path exists on disk ────
    it("IT-8: scan caches' present evidence paths exist on disk", () => {
      const { json: s } = scan();
      if (isErrorEnvelope(s)) return;
      const allSnaps = [
        ...Object.values((s as { caches?: Record<string, unknown[]> }).caches ?? {}).flat(),
        ...Object.values(
          (s as { marketplaceCaches?: Record<string, unknown[]> }).marketplaceCaches ?? {},
        ).flat(),
        ...Object.values((s as { rpmCaches?: Record<string, unknown[]> }).rpmCaches ?? {}).flat(),
      ] as Array<{ presence?: string; evidencePaths?: string[] }>;
      for (const snap of allSnaps) {
        if (snap.presence !== "present") continue;
        for (const p of snap.evidencePaths ?? []) {
          expect(fs.existsSync(p), `evidence path missing: ${p}`).toBe(true);
        }
      }
    });

    // ─── IT-9: every drift's plugin subject resolves to known PluginRefKey ──
    it("IT-9: drift subjects resolve to known plugin/marketplace/root", () => {
      const { json: s } = scan();
      if (isErrorEnvelope(s)) return;
      const drifts = (s as { drifts?: unknown[] }).drifts;
      if (!Array.isArray(drifts)) return;
      const caches = (s as { caches?: Record<string, unknown> }).caches ?? {};
      const knownPluginKeys = new Set(Object.keys(caches).map((k) => k.split("#")[0]));
      for (const d of drifts as Array<Record<string, unknown>>) {
        // RegistrationDrift is the one variant with no `subject`.
        if (d.kind === "registration-drift") continue;
        const subj = d.subject as
          | { kind?: string; ref?: { pluginName?: string; marketplace?: string } }
          | undefined;
        if (!subj || subj.kind !== "plugin") continue;
        const refKey = `${subj.ref?.pluginName}@${subj.ref?.marketplace}`;
        expect(knownPluginKeys.has(refKey), `drift refKey '${refKey}' not in caches`).toBe(true);
      }
    });

    // ─── IT-10: every recommendation fix references a real drift ─────────
    // Today's `fixes` field shape: sometimes a DriftRef[], sometimes drift
    // objects. Verify each fix corresponds to SOMETHING in drifts[] by
    // matching the discriminator `kind` (the fix has it, the drift has it).
    it("IT-10: every recommendation fix.kind is the kind of some drift", () => {
      const { json: s } = scan();
      if (isErrorEnvelope(s)) return;
      const recs = (s as { recommendations?: Array<{ fixes?: Array<{ kind?: string }> }> })
        .recommendations;
      const drifts = (s as { drifts?: Array<{ kind?: string }> }).drifts;
      if (!Array.isArray(recs) || !Array.isArray(drifts)) return;
      const driftKinds = new Set(drifts.map((d) => d.kind));
      for (const rec of recs) {
        for (const fix of rec.fixes ?? []) {
          if (typeof fix.kind === "string") {
            expect(driftKinds.has(fix.kind), `fix.kind='${fix.kind}' has no matching drift`).toBe(
              true,
            );
          }
        }
      }
    });

    // ─── IT-11: conditionId required on every RecommendedAction ──────────
    // Locked by prior-art A1 (shipped in v0.1.0).
    it("IT-11: every recommendation.conditionId matches catalog regex", () => {
      const { json: s } = scan();
      if (isErrorEnvelope(s)) return;
      const recs = (s as { recommendations?: Array<{ conditionId?: string }> }).recommendations;
      if (!Array.isArray(recs)) return;
      for (const r of recs) {
        expect(typeof r.conditionId, "missing conditionId on action").toBe("string");
        expect(r.conditionId).toMatch(CONDITION_ID_RE);
      }
    });

    // ─── IT-12: instance id is well-formed and unique within run ─────────
    // Locked by prior-art A1. v0.1.0 ships two ID schemes:
    //   `action:<drift-kind>:<refKey>` and `advisory:<topic>`.
    it("IT-12: every recommendation.id is well-formed and unique within run", () => {
      const { json: s } = scan();
      if (isErrorEnvelope(s)) return;
      const recs = (s as { recommendations?: Array<{ id?: string }> }).recommendations;
      if (!Array.isArray(recs) || recs.length === 0) return;
      const ids: string[] = [];
      for (const r of recs) {
        expect(typeof r.id, "missing id on action").toBe("string");
        expect(r.id, `instance id '${r.id}' doesn't match action:/advisory: schemes`).toMatch(
          INSTANCE_ID_RE,
        );
        ids.push(r.id as string);
      }
      expect(new Set(ids).size, "duplicate recommendation ids in scan run").toBe(ids.length);
    });

    // ─── IT-13: every recommendation has non-empty recipes ───────────────
    // Locked by prior-art §3a (shipped in v0.1.0).
    it("IT-13: every recommendation.recipes is a non-empty array", () => {
      const { json: s } = scan();
      if (isErrorEnvelope(s)) return;
      const recs = (s as { recommendations?: Array<{ recipes?: Array<{ kind?: string }> }> })
        .recommendations;
      if (!Array.isArray(recs)) return;
      for (const r of recs) {
        expect(Array.isArray(r.recipes), "recipes must be an array").toBe(true);
        expect(r.recipes?.length, "recipes must be non-empty").toBeGreaterThan(0);
        for (const recipe of r.recipes ?? []) {
          expect(typeof recipe.kind, "recipe.kind must be a string").toBe("string");
        }
      }
    });

    // ─── IT-14: summary.perLayer internal consistency ────────────────────
    // Locked by prior-art A2 (shipped in v0.1.0).
    it("IT-14: summary.perLayer.count == fresh + stale + missing + skipped + unknowable", () => {
      const { json: s } = scan();
      if (isErrorEnvelope(s)) return;
      const summary = (
        s as {
          summary?: {
            perLayer: Record<
              string,
              {
                count: number;
                fresh: number;
                stale: number;
                missing: number;
                skipped: number;
                unknowable?: number;
              }
            >;
          };
        }
      ).summary;
      // summary is required by prior-art A2 — fail loudly when missing.
      expect(summary, "ScanReport.summary missing — prior-art A2 not landed").toBeDefined();
      if (!summary) return;
      for (const [layer, c] of Object.entries(summary.perLayer)) {
        const sum = c.fresh + c.stale + c.missing + c.skipped + (c.unknowable ?? 0);
        expect(c.count, `summary.${layer}.count != sum of buckets`).toBe(sum);
      }
    });

    // ─── IT-15: summary layer set covers caches' layers ───────────────────
    it("IT-15: summary.perLayer keys cover every layer that produced a snapshot", () => {
      const { json: s } = scan();
      if (isErrorEnvelope(s)) return;
      const summary = (s as { summary?: { perLayer?: Record<string, unknown> } }).summary;
      if (!summary?.perLayer) return;
      const allSnaps = [
        ...Object.values(
          (s as { caches?: Record<string, Array<{ layer: string }>> }).caches ?? {},
        ).flat(),
        ...Object.values(
          (s as { marketplaceCaches?: Record<string, Array<{ layer: string }>> })
            .marketplaceCaches ?? {},
        ).flat(),
        ...Object.values(
          (s as { rpmCaches?: Record<string, Array<{ layer: string }>> }).rpmCaches ?? {},
        ).flat(),
      ];
      const layersWithSnapshots = new Set(allSnaps.map((sn) => sn.layer));
      for (const layer of layersWithSnapshots) {
        expect(
          summary.perLayer[layer],
          `summary.perLayer missing entry for layer '${layer}' even though caches contains snapshots`,
        ).toBeDefined();
      }
    });

    // ─── IT-16: runId is a UUIDv4 ────────────────────────────────────────
    // Locked by CONVENTIONS pack header (src/refs.ts:53). The pack
    // explicitly chose UUID over ULID for v0.1.0.
    it("IT-16: runId on scan/list/topology is a UUIDv4", () => {
      for (const cmd of [["scan"], ["list"], ["topology"]] as const) {
        const r = runCpd(home, [...cmd]);
        const j = tryParse(r.stdout) as { runId?: string } | undefined;
        if (!j || isErrorEnvelope(j as unknown)) continue;
        expect(j.runId, `${cmd[0]} missing runId`).toBeDefined();
        expect(j.runId, `${cmd[0]}.runId is not a UUIDv4: '${j.runId}'`).toMatch(RUNID_UUID_RE);
      }
    });

    // ─── IT-18: Drift.kind union is closed ────────────────────────────────
    // CONVENTIONS pack: `Drift.kind` is frozen append-only — existing
    // kebab-case values are public contract, never renamed (`docs/CLI-DESIGN.md`).
    // A rename in src/types.ts:922 would compile but silently change the
    // wire shape. This invariant locks the kind set: any kind in scan
    // output that isn't on the known list fails the test, surfacing
    // either a rename or a new addition (which should be deliberate).
    const KNOWN_DRIFT_KINDS = new Set([
      // Top-level Drift union members:
      "registration-drift",
      "version-drift",
      "resolver-disagreement",
      "runtime-boundary",
      "backend-ui-drift",
      // KnownTrap sub-union:
      "marketplace-update-broken",
      "refresh-needed",
      "bump-needed",
      "badge-only-needed",
      "skills-plugin-stuck",
      "session-bloat-cleanup-eligible",
      "unsupported-source",
      "npm-source-not-supported",
    ]);
    it("IT-18: every drift.kind belongs to the frozen public union", () => {
      const { json: s } = scan();
      if (isErrorEnvelope(s)) return;
      const drifts = (s as { drifts?: Array<{ kind?: string }> }).drifts;
      if (!Array.isArray(drifts)) return;
      for (const d of drifts) {
        expect(
          KNOWN_DRIFT_KINDS.has(d.kind ?? ""),
          `unknown drift.kind '${d.kind}' — frozen union violated; if this is a deliberate addition, append to KNOWN_DRIFT_KINDS in invariants.test.ts`,
        ).toBe(true);
      }
    });

    // ─── IT-19: ErrorEnvelope shape on exit 1/64 ─────────────────────────
    // Locked by `src/types.ts:746` ErrorEnvelope. When cpd surfaces an
    // error envelope, the wire shape is `{ ok: false, code, message,
    // hint?, runId?, logFile? }` and is a public contract. The driver
    // (`scripts/qa-harness.sh`) checks `.ok` and `.code`; this invariant
    // adds the rest: `.message` is a non-empty string, `.runId` (when
    // present) is a UUIDv4, `.code` is a known CpdErrorCode.
    const KNOWN_CPD_ERROR_CODES = new Set([
      "E_PLATFORM_UNSUPPORTED",
      "E_PARSE_KNOWN_MARKETPLACES",
      "E_PARSE_INSTALLED_PLUGINS",
      "E_PARSE_RPM_MANIFEST",
      "E_PARSE_MARKETPLACE_JSON",
      "E_GIT_TIMEOUT",
      "E_USAGE",
      "E_FETCH_TIMEOUT",
      "E_FETCH_NETWORK",
      "E_PARSE_PLUGIN_JSON",
      "E_PARSE_SKILLS_PLUGIN_MANIFEST",
      "E_VERIFY_IN_UI_INPUT",
      "E_UI_EVIDENCE_SCHEMA",
      "E_FORCE_FETCH_ABORTED",
    ]);
    it("IT-19: when cpd emits an ErrorEnvelope, the shape is well-formed", () => {
      // Force an error envelope: invalid command flag.
      const r = runCpd(home, ["scan", "--definitely-not-a-flag-xxx"]);
      // Some cpd implementations emit the envelope on stderr; some on
      // stdout. Try both.
      const envFromStdout = tryParse(r.stdout);
      const envFromStderr = tryParse(r.stderr);
      const env = isErrorEnvelope(envFromStdout)
        ? (envFromStdout as Record<string, unknown>)
        : isErrorEnvelope(envFromStderr)
          ? (envFromStderr as Record<string, unknown>)
          : undefined;
      // If commander rejects the flag without emitting JSON (it does on
      // some flag-validation paths), skip — this invariant only fires
      // when an envelope is emitted. The driver covers the per-fixture
      // cases that DO emit one (corrupt-installed-plugins).
      if (!env) return;
      expect(env.ok, "ErrorEnvelope.ok must be false").toBe(false);
      expect(typeof env.code, "ErrorEnvelope.code must be a string").toBe("string");
      expect(
        KNOWN_CPD_ERROR_CODES.has(env.code as string),
        `unknown error code '${env.code}'`,
      ).toBe(true);
      expect(typeof env.message, "ErrorEnvelope.message must be a string").toBe("string");
      expect(
        (env.message as string).length,
        "ErrorEnvelope.message must be non-empty",
      ).toBeGreaterThan(0);
      if (typeof env.runId === "string") {
        expect(env.runId, `ErrorEnvelope.runId not a UUIDv4: '${env.runId}'`).toMatch(
          RUNID_UUID_RE,
        );
      }
    });

    // ─── IT-20: --no-network suppresses upstream probes ──────────────────
    // Prior-art A10 boundary audit: every git/claude/ssh/ps call gated.
    // The harness already passes `--no-network` to every cpd
    // invocation. This invariant ASSERTS that the suppression is real:
    // ScanReport.upstreams[*].status must be `"no-network"` for every
    // entry that has a status (per src/types.ts:582). A regression that
    // calls git ls-remote despite --no-network would surface as a
    // `"fresh"`/`"stale"` upstream status.
    it("IT-20: under --no-network, every upstream status is 'no-network'", () => {
      const { json: s } = scan();
      if (isErrorEnvelope(s)) return;
      const upstreams = (s as { upstreams?: Record<string, { status?: string }> }).upstreams;
      if (!upstreams) return;
      for (const [key, probe] of Object.entries(upstreams)) {
        if (probe.status !== undefined) {
          expect(
            probe.status,
            `upstreams['${key}'].status='${probe.status}' under --no-network (network-suppression regression?)`,
          ).toBe("no-network");
        }
      }
    });

    // ─── IT-17: timestamps are ISO-8601-Z and ordered ────────────────────
    it("IT-17: startedAt/finishedAt are ISO-8601-Z and finishedAt >= startedAt", () => {
      for (const cmd of [["scan"] as string[], ["list"] as string[]]) {
        const r = runCpd(home, cmd);
        const j = tryParse(r.stdout) as { startedAt?: string; finishedAt?: string } | undefined;
        if (!j || isErrorEnvelope(j as unknown)) continue;
        if (j.startedAt && j.finishedAt) {
          expect(j.startedAt).toMatch(ISO_Z_RE);
          expect(j.finishedAt).toMatch(ISO_Z_RE);
          expect(Date.parse(j.finishedAt)).toBeGreaterThanOrEqual(Date.parse(j.startedAt));
        }
      }
    });

    // The `expected` block is read by every test that consults a
    // fixture-declared expectation (e.g., the corrupt-installed-plugins
    // current/desired selector). Reference it once so unused-var lint
    // doesn't fire on fixtures that don't end up consulting it.
    void expected;
  });
}
