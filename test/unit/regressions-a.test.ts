/**
 * Gap-fix tests for v1.0.0-  — covers Gaps 1-6, 10.
 *
 * Tests for:
 *  - Gap 1+2: BackendUiDrift in actionForDrift + planRecommendations verify-in-ui advisory
 *  - Gap 3: VersionDrift emission from composeDrift
 *  - Gap 4: parsePluginJson helper
 *  - Gap 5: E_FORCE_FETCH_ABORTED in CpdErrorCode
 *  - Gap 6: E_UI_EVIDENCE_SCHEMA thrown by writeObservation
 *  - Gap 10: RunScanOpts.includeSkillsPlugin / showRuntimeBoundary flags
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ComposerInput } from "../../src/drift/compose.js";
import { composeDrift } from "../../src/drift/compose.js";
import { CpdError } from "../../src/errors.js";
import { parsePluginJson } from "../../src/plugin-json.js";
import { actionForDrift } from "../../src/recommendations/catalog.js";
import { planRecommendations } from "../../src/recommendations/plan.js";
import { writeObservation } from "../../src/state/verify-in-ui-state.js";
import type {
  BackendUiDrift,
  CacheSnapshot,
  CliUpdateSim,
  DesktopBadgeSim,
  InstallSnapshotData,
  PluginRef,
  SessionStartSim,
  Topology,
} from "../../src/types.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const ccdPluginRef: PluginRef = {
  pluginName: "my-plugin",
  marketplace: "my-mp",
  root: { kind: "ccd" },
};

function emptyTopology(): Topology {
  return {
    cowork: [],
    sessionLocals: [],
    scannedAt: new Date().toISOString(),
  };
}

function makeInstallSnapshot(version = "1.0.0"): CacheSnapshot {
  const data: InstallSnapshotData = {
    kind: "install_snapshot",
    pluginRef: ccdPluginRef,
    installPath: "/home/.claude/plugins/cache/my-mp/my-plugin/1.0.0",
    installPathExists: true,
    scopes: [
      {
        scope: "user",
        version,
        installPath: "/home/.claude/plugins/cache/my-mp/my-plugin/1.0.0",
        raw: {},
      },
    ],
    pluginEntrySourceKind: "string",
    pluginEntryRaw: "plugins/my-plugin",
  };
  return {
    layer: "install_snapshot",
    rootRef: { kind: "ccd" },
    subject: { kind: "plugin", ref: ccdPluginRef },
    presence: "present",
    evidencePaths: [],
    parsedAt: new Date().toISOString(),
    data,
  };
}

function makeCli(resolvedVersion: string): CliUpdateSim {
  return {
    resolvedVersion,
    resolvedFrom: "plugin.json-in-clone",
    evidence: { pluginEntrySourceKind: "string" },
  };
}

function makeBadge(resolvedVersion: string): DesktopBadgeSim {
  return {
    resolvedVersion,
    resolvedFrom: "plugin.json-in-clone",
    evidence: { pluginEntrySourceKind: "string" },
  };
}

function makeSession(resolvedVersion: string): SessionStartSim {
  return { resolvedVersion };
}

function makeResolvers(resolvedVersion: string) {
  return {
    "my-plugin@my-mp#ccd": {
      cli: makeCli(resolvedVersion),
      badge: makeBadge(resolvedVersion),
      session: makeSession(resolvedVersion),
    },
  };
}

// ── Gap 1: BackendUiDrift in actionForDrift ──────────────────────────────────

describe("Gap 1 — actionForDrift handles backend-ui-drift", () => {
  it("returns undefined for backend-ui-drift (advisory-only)", () => {
    const drift: BackendUiDrift = {
      kind: "backend-ui-drift",
      subject: { kind: "plugin", ref: ccdPluginRef },
      uiObserved: { version: "2.0.0", updateAvailable: true },
      uiObservedAt: new Date().toISOString(),
      uiObservedAge: "fresh",
      cliResolverSays: { version: "1.0.0", resolvedFrom: "plugin.json-in-clone" },
      disagrees: true,
    };
    expect(actionForDrift(drift, 1)).toBeUndefined();
  });
});

// ── Gap 2: verify-in-ui advisory in planRecommendations ─────────────────────

describe("Gap 2 — planRecommendations emits verify-in-ui advisory", () => {
  it("appends advisory:verify-in-ui when backend-ui-drift with disagrees:true is present", () => {
    const drift: BackendUiDrift = {
      kind: "backend-ui-drift",
      subject: { kind: "plugin", ref: ccdPluginRef },
      uiObserved: { version: "2.0.0" },
      uiObservedAt: new Date().toISOString(),
      uiObservedAge: "fresh",
      cliResolverSays: { version: "1.0.0", resolvedFrom: "plugin.json-in-clone" },
      disagrees: true,
    };
    const actions = planRecommendations([drift]);
    const advisoryAction = actions.find((a) => a.id === "advisory:verify-in-ui");
    expect(advisoryAction).toBeDefined();
    expect(advisoryAction?.postActionAdvisory).toBe("verify-in-ui");
    expect(advisoryAction?.risk).toBe("safe");
    expect(advisoryAction?.cmd).toBeUndefined();
  });

  it("does NOT emit advisory:verify-in-ui when backend-ui-drift has disagrees:false", () => {
    const drift: BackendUiDrift = {
      kind: "backend-ui-drift",
      subject: { kind: "plugin", ref: ccdPluginRef },
      uiObserved: { version: "1.0.0" },
      uiObservedAt: new Date().toISOString(),
      uiObservedAge: "fresh",
      cliResolverSays: { version: "1.0.0", resolvedFrom: "plugin.json-in-clone" },
      disagrees: false,
    };
    const actions = planRecommendations([drift]);
    expect(actions.find((a) => a.id === "advisory:verify-in-ui")).toBeUndefined();
  });

  it("emits advisory:verify-in-ui when resolvers have backend-unknowable cli", () => {
    const actions = planRecommendations([], {
      resolvers: {
        "my-plugin@my-mp#ccd": {
          cli: { unknowable: { reason: "backend" } },
        },
      },
    });
    const advisoryAction = actions.find((a) => a.id === "advisory:verify-in-ui");
    expect(advisoryAction).toBeDefined();
    expect(advisoryAction?.postActionAdvisory).toBe("verify-in-ui");
  });

  it("does NOT emit advisory:verify-in-ui when resolvers are empty", () => {
    const actions = planRecommendations([], { resolvers: {} });
    expect(actions.find((a) => a.id === "advisory:verify-in-ui")).toBeUndefined();
  });

  it("verify-in-ui advisory comes after runtime-boundary advisory", () => {
    const drift: BackendUiDrift = {
      kind: "backend-ui-drift",
      subject: { kind: "plugin", ref: ccdPluginRef },
      uiObserved: {},
      uiObservedAt: new Date().toISOString(),
      uiObservedAge: "fresh",
      cliResolverSays: { resolvedFrom: "unknown" },
      disagrees: true,
    };
    const actions = planRecommendations([drift]);
    const verifyIdx = actions.findIndex((a) => a.id === "advisory:verify-in-ui");
    const runtimeIdx = actions.findIndex((a) => a.id === "advisory:runtime-boundary");
    // runtime-boundary is not emitted here (no runtime-boundary drift), but
    // verify-in-ui should be last.
    expect(verifyIdx).toBeGreaterThan(-1);
    if (runtimeIdx !== -1) {
      expect(verifyIdx).toBeGreaterThan(runtimeIdx);
    }
  });
});

// ── Gap 3: VersionDrift from composeDrift ───────────────────────────────────

describe("Gap 3 — VersionDrift emission from composeDrift", () => {
  function makeInput(installedVersion: string, resolvedVersion: string): ComposerInput {
    return {
      topology: emptyTopology(),
      cacheSnapshots: [makeInstallSnapshot(installedVersion)],
      upstreams: {},
      resolvers: makeResolvers(resolvedVersion),
    };
  }

  it("emits version-drift with ahead:'upstream' when upstream is newer", () => {
    const result = composeDrift(makeInput("1.0.0", "2.0.0"));
    const vd = result.find((d) => d.kind === "version-drift");
    expect(vd).toBeDefined();
    if (vd?.kind === "version-drift") {
      expect(vd.ahead).toBe("upstream");
      expect(vd.upstreamVersion).toBe("2.0.0");
      expect(vd.installedVersion).toBe("1.0.0");
    }
  });

  it("emits version-drift with ahead:'installed' when installed is newer", () => {
    const result = composeDrift(makeInput("2.0.0", "1.0.0"));
    const vd = result.find((d) => d.kind === "version-drift");
    expect(vd).toBeDefined();
    if (vd?.kind === "version-drift") {
      expect(vd.ahead).toBe("installed");
    }
  });

  it("does NOT emit version-drift when versions are equal", () => {
    const result = composeDrift(makeInput("1.0.0", "1.0.0"));
    const vd = result.find((d) => d.kind === "version-drift");
    expect(vd).toBeUndefined();
  });

  it("handles numeric semver ordering (1.10 > 1.9) correctly", () => {
    const result = composeDrift(makeInput("1.9", "1.10"));
    const vd = result.find((d) => d.kind === "version-drift");
    expect(vd).toBeDefined();
    if (vd?.kind === "version-drift") {
      expect(vd.ahead).toBe("upstream");
    }
  });

  it("emits version-drift with ahead:'incomparable' when cli version is missing", () => {
    const input: ComposerInput = {
      topology: emptyTopology(),
      cacheSnapshots: [makeInstallSnapshot("1.0.0")],
      upstreams: {},
      resolvers: {
        "my-plugin@my-mp#ccd": {
          cli: {
            resolvedFrom: "unknown",
            evidence: { pluginEntrySourceKind: "string" },
            // no resolvedVersion
          },
          badge: makeBadge("1.0.0"),
          session: makeSession("1.0.0"),
        },
      },
    };
    const result = composeDrift(input);
    const vd = result.find((d) => d.kind === "version-drift");
    expect(vd).toBeDefined();
    if (vd?.kind === "version-drift") {
      expect(vd.ahead).toBe("incomparable");
    }
  });
});

// ── Gap 4: parsePluginJson helper ────────────────────────────────────────────

describe("Gap 4 — parsePluginJson", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-plugin-json-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns undefined for non-existent file", () => {
    expect(parsePluginJson(path.join(tmpDir, "nonexistent.json"))).toBeUndefined();
  });

  it("returns undefined for malformed JSON", () => {
    const p = path.join(tmpDir, "plugin.json");
    fs.writeFileSync(p, "not-json", "utf8");
    expect(parsePluginJson(p)).toBeUndefined();
  });

  it("returns undefined for non-object JSON", () => {
    const p = path.join(tmpDir, "plugin.json");
    fs.writeFileSync(p, JSON.stringify([1, 2, 3]), "utf8");
    expect(parsePluginJson(p)).toBeUndefined();
  });

  it("parses a well-formed plugin.json and returns all fields", () => {
    const p = path.join(tmpDir, "plugin.json");
    const data = {
      version: "1.2.3",
      commands: [{ name: "foo" }],
      agents: { bar: {} },
      skills: ["baz"],
      hooks: [],
      mcpServers: { myServer: {} },
      extraField: "hello",
    };
    fs.writeFileSync(p, JSON.stringify(data), "utf8");
    const result = parsePluginJson(p);
    expect(result).not.toBeUndefined();
    expect(result?.version).toBe("1.2.3");
    expect(result?.commands).toEqual([{ name: "foo" }]);
    expect(result?.agents).toEqual({ bar: {} });
    expect(result?.skills).toEqual(["baz"]);
    expect(result?.hooks).toEqual([]);
    expect(result?.mcpServers).toEqual({ myServer: {} });
    expect(result?.raw.extraField).toBe("hello");
  });

  it("handles partial plugin.json (only version)", () => {
    const p = path.join(tmpDir, "plugin.json");
    fs.writeFileSync(p, JSON.stringify({ version: "0.1.0" }), "utf8");
    const result = parsePluginJson(p);
    expect(result?.version).toBe("0.1.0");
    expect(result?.commands).toBeUndefined();
  });
});

// ── Gap 5: E_FORCE_FETCH_ABORTED in CpdErrorCode ────────────────────────────

describe("Gap 5 — E_FORCE_FETCH_ABORTED is a valid CpdErrorCode", () => {
  it("can construct a CpdError with E_FORCE_FETCH_ABORTED code", () => {
    const err = new CpdError("E_FORCE_FETCH_ABORTED", "Force-fetch aborted: user did not confirm");
    expect(err.code).toBe("E_FORCE_FETCH_ABORTED");
    expect(err instanceof CpdError).toBe(true);
  });

  it("toEnvelope includes the code", () => {
    const err = new CpdError("E_FORCE_FETCH_ABORTED", "aborted", "Pass --yes to proceed");
    const env = err.toEnvelope();
    expect(env.code).toBe("E_FORCE_FETCH_ABORTED");
    expect(env.hint).toBe("Pass --yes to proceed");
  });
});

// ── Gap 6: E_UI_EVIDENCE_SCHEMA thrown by writeObservation ──────────────────

describe("Gap 6 — writeObservation throws E_UI_EVIDENCE_SCHEMA on invalid input", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-ui-evidence-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws E_UI_EVIDENCE_SCHEMA when pluginListed is not boolean", () => {
    expect(() =>
      writeObservation({
        pluginRefKeyOrIdString: "p@mp",
        // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid for test
        observation: { pluginListed: "yes" as any, capturedAt: new Date().toISOString() },
        rootDir: tmpDir,
      }),
    ).toThrow(CpdError);

    try {
      writeObservation({
        pluginRefKeyOrIdString: "p@mp",
        // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid for test
        observation: { pluginListed: "yes" as any, capturedAt: new Date().toISOString() },
        rootDir: tmpDir,
      });
    } catch (e) {
      expect((e as CpdError).code).toBe("E_UI_EVIDENCE_SCHEMA");
    }
  });

  it("throws E_UI_EVIDENCE_SCHEMA when capturedAt is missing", () => {
    try {
      writeObservation({
        pluginRefKeyOrIdString: "p@mp",
        // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid for test
        observation: { pluginListed: true } as any,
        rootDir: tmpDir,
      });
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as CpdError).code).toBe("E_UI_EVIDENCE_SCHEMA");
    }
  });

  it("succeeds with a valid observation", () => {
    const result = writeObservation({
      pluginRefKeyOrIdString: "p@mp",
      observation: { pluginListed: true, capturedAt: new Date().toISOString() },
      rootDir: tmpDir,
    });
    expect(result.persistedTo).toContain("ui-evidence.json");
  });
});

// ── Gap 10: RunScanOpts flags (type-level check) ─────────────────────────────

describe("Gap 10 — RunScanOpts new flags are defined", () => {
  it("RunScanOpts accepts includeSkillsPlugin and showRuntimeBoundary", () => {
    // This is a compile-time check only — if RunScanOpts doesn't have these
    // fields, TypeScript would error during `npm run typecheck`.
    const opts: import("../../src/commands/scan.js").RunScanOpts = {
      home: "/home/user",
      platform: "darwin",
      env: {},
      mode: "all",
      noNetwork: true,
      includeSkillsPlugin: false,
      showRuntimeBoundary: true,
    };
    expect(opts.includeSkillsPlugin).toBe(false);
    expect(opts.showRuntimeBoundary).toBe(true);
  });
});
