/**
 * Unit tests for detectBackendUiDrift (phase 8).
 */

import { describe, expect, it } from "vitest";
import { detectBackendUiDrift } from "../../../src/drift/backend-ui.js";
import type { BackendUiDriftInput } from "../../../src/drift/backend-ui.js";
import type { UiObservation } from "../../../src/state/verify-in-ui-state.js";
import type { CliUpdateSim, PluginRef } from "../../../src/types.js";

const pluginRef: PluginRef = {
  pluginName: "my-plugin",
  marketplace: "my-mp",
  root: { kind: "ccd" },
};

const freshCli: CliUpdateSim = {
  resolvedVersion: "1.0.0",
  resolvedFrom: "plugin.json-in-clone",
  evidence: {
    pluginEntrySourceKind: "string",
  },
};

function makeObs(override: Partial<UiObservation> & { capturedAt: string }): UiObservation {
  return {
    pluginListed: true,
    versionShown: "1.0.0",
    capturedAt: override.capturedAt,
    ...override,
  };
}

describe("detectBackendUiDrift", () => {
  it("fresh observation matching CLI — no disagreement, fresh age", () => {
    const obs = makeObs({ capturedAt: new Date().toISOString() });
    const input: BackendUiDriftInput = {
      pluginRef,
      observation: obs,
      cliResolved: freshCli,
      maxAgeDays: 7,
    };
    const result = detectBackendUiDrift(input);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("backend-ui-drift");
    expect(result?.disagrees).toBe(false);
    expect(result?.uiObservedAge).toBe("fresh");
    expect(result?.cliResolverSays.version).toBe("1.0.0");
    expect(result?.cliResolverSays.resolvedFrom).toBe("plugin.json-in-clone");
  });

  it("fresh observation differing from CLI — disagrees is true", () => {
    const obs = makeObs({
      versionShown: "2.0.0",
      capturedAt: new Date().toISOString(),
    });
    const input: BackendUiDriftInput = {
      pluginRef,
      observation: obs,
      cliResolved: freshCli,
      maxAgeDays: 7,
    };
    const result = detectBackendUiDrift(input);
    expect(result).not.toBeNull();
    expect(result?.disagrees).toBe(true);
    expect(result?.uiObserved.version).toBe("2.0.0");
  });

  it("stale observation — uiObservedAge is stale", () => {
    // 30 days ago
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const obs = makeObs({ capturedAt: oldDate });
    const input: BackendUiDriftInput = {
      pluginRef,
      observation: obs,
      cliResolved: freshCli,
      maxAgeDays: 7,
    };
    const result = detectBackendUiDrift(input);
    expect(result).not.toBeNull();
    expect(result?.uiObservedAge).toBe("stale");
  });

  it("observation with versionShown undefined — no disagreement even if CLI has version", () => {
    const obs: UiObservation = {
      pluginListed: true,
      capturedAt: new Date().toISOString(),
      // no versionShown
    };
    const input: BackendUiDriftInput = {
      pluginRef,
      observation: obs,
      cliResolved: freshCli,
      maxAgeDays: 7,
    };
    const result = detectBackendUiDrift(input);
    expect(result).not.toBeNull();
    expect(result?.disagrees).toBe(false);
    expect(result?.uiObserved.version).toBeUndefined();
  });

  it("CLI with no resolvedVersion — no disagreement even if UI shows a version", () => {
    const obs = makeObs({ versionShown: "1.0.0", capturedAt: new Date().toISOString() });
    const noVersionCli: CliUpdateSim = {
      resolvedFrom: "unknown",
      evidence: { pluginEntrySourceKind: "unrecognized-source-kind" },
      unknowable: { reason: "unsupported source" },
    };
    const input: BackendUiDriftInput = {
      pluginRef,
      observation: obs,
      cliResolved: noVersionCli,
      maxAgeDays: 7,
    };
    const result = detectBackendUiDrift(input);
    expect(result).not.toBeNull();
    expect(result?.disagrees).toBe(false);
  });

  it("invalid capturedAt — returns null", () => {
    const obs: UiObservation = {
      pluginListed: true,
      capturedAt: "not-a-date",
    };
    const input: BackendUiDriftInput = {
      pluginRef,
      observation: obs,
      cliResolved: freshCli,
    };
    const result = detectBackendUiDrift(input);
    expect(result).toBeNull();
  });

  it("uses default maxAgeDays of 7 when not specified", () => {
    // 6 days ago — should be fresh
    const recentDate = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
    const obs = makeObs({ capturedAt: recentDate });
    const input: BackendUiDriftInput = {
      pluginRef,
      observation: obs,
      cliResolved: freshCli,
    };
    const result = detectBackendUiDrift(input);
    expect(result?.uiObservedAge).toBe("fresh");
  });

  it("emits uiObserved fields from observation", () => {
    const obs: UiObservation = {
      pluginListed: true,
      versionShown: "1.5.0",
      updateAvailable: true,
      statusShown: "Installed",
      capturedAt: new Date().toISOString(),
    };
    const input: BackendUiDriftInput = {
      pluginRef,
      observation: obs,
      cliResolved: freshCli,
    };
    const result = detectBackendUiDrift(input);
    expect(result).not.toBeNull();
    expect(result?.uiObserved.version).toBe("1.5.0");
    expect(result?.uiObserved.updateAvailable).toBe(true);
    expect(result?.uiObserved.status).toBe("Installed");
  });

  it("subject is a plugin ref with the correct pluginRef", () => {
    const obs = makeObs({ capturedAt: new Date().toISOString() });
    const result = detectBackendUiDrift({ pluginRef, observation: obs, cliResolved: freshCli });
    expect(result?.subject.kind).toBe("plugin");
    expect(result?.subject.ref).toBe(pluginRef);
  });
});

describe("detectBackendUiDrift — extended disagreement classes (audit issue #7)", () => {
  it("UI says plugin not listed, CLI resolved a version → disagrees=true", () => {
    const obs: UiObservation = {
      pluginListed: false,
      capturedAt: new Date().toISOString(),
    };
    const result = detectBackendUiDrift({ pluginRef, observation: obs, cliResolved: freshCli });
    expect(result?.disagrees).toBe(true);
  });

  it("UI shows version, CLI knows there is no version → disagrees=true", () => {
    const obs: UiObservation = {
      pluginListed: true,
      versionShown: "1.0.0",
      capturedAt: new Date().toISOString(),
    };
    const cliEmpty: CliUpdateSim = {
      // No `unknowable`, no `resolvedVersion`: the resolver concluded there
      // is no version (e.g. catalog had no version field). That contradicts
      // the UI showing 1.0.0.
      resolvedFrom: "marketplace.json",
      evidence: { pluginEntrySourceKind: "string" },
    };
    const result = detectBackendUiDrift({ pluginRef, observation: obs, cliResolved: cliEmpty });
    expect(result?.disagrees).toBe(true);
  });

  // ── Unknowable / no-network false-positive guards ──────────────────────────
  // Without these guards, every --no-network or backend-probe-failure scan
  // would emit a false-positive disagreement for any UI observation on file.

  it("UI says plugin not listed but CLI is unknowable → disagrees=false (guard)", () => {
    const obs: UiObservation = {
      pluginListed: false,
      capturedAt: new Date().toISOString(),
    };
    const cliUnknown: CliUpdateSim = {
      resolvedFrom: "n/a",
      unknowable: { reason: "no-network" },
      evidence: { pluginEntrySourceKind: "string" },
    };
    const result = detectBackendUiDrift({
      pluginRef,
      observation: obs,
      cliResolved: cliUnknown,
    });
    expect(result?.disagrees).toBe(false);
  });

  it("UI shows version but CLI unknowable → disagrees=false (guard)", () => {
    const obs: UiObservation = {
      pluginListed: true,
      versionShown: "1.0.0",
      capturedAt: new Date().toISOString(),
    };
    const cliUnknown: CliUpdateSim = {
      resolvedFrom: "n/a",
      unknowable: { reason: "github 404" },
      evidence: { pluginEntrySourceKind: "string" },
    };
    const result = detectBackendUiDrift({
      pluginRef,
      observation: obs,
      cliResolved: cliUnknown,
    });
    expect(result?.disagrees).toBe(false);
  });

  it("UI says plugin not listed and CLI also has no version → disagrees=false (agreement)", () => {
    // No `unknowable`, no `resolvedVersion`: the resolver agrees there is no
    // version. UI says not listed. They agree, so no disagreement.
    const obs: UiObservation = {
      pluginListed: false,
      capturedAt: new Date().toISOString(),
    };
    const cliNone: CliUpdateSim = {
      resolvedFrom: "n/a",
      evidence: { pluginEntrySourceKind: "string" },
    };
    const result = detectBackendUiDrift({
      pluginRef,
      observation: obs,
      cliResolved: cliNone,
    });
    expect(result?.disagrees).toBe(false);
  });
});
