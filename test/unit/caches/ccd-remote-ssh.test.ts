/**
 * Tests for the ccd-remote-ssh layer — both v0.5 and v1.0 snapshot exports.
 */

import { describe, expect, it } from "vitest";
import { checkCcdRemoteSsh, snapshotCcdRemoteSsh } from "../../../src/caches/ccd-remote-ssh.js";

describe("checkCcdRemoteSsh (v0.5)", () => {
  it("returns skipped with advisory detail", () => {
    const r = checkCcdRemoteSsh({ pluginId: "myplugin@mymp" });
    expect(r.status).toBe("skipped");
    expect(r.layer).toBe("ccd_remote_ssh");
    expect(r.detail).toMatch(/remote machine/i);
  });
});

describe("snapshotCcdRemoteSsh (v1.0)", () => {
  it("always returns presence:n/a-for-source", () => {
    const snap = snapshotCcdRemoteSsh({
      pluginId: "myplugin@mymp",
      rootRef: { kind: "ccd" },
    });
    expect(snap.layer).toBe("ccd_remote_ssh");
    expect(snap.presence).toBe("n/a-for-source");
    expect(snap.data.kind).toBe("ccd_remote_ssh");
    expect(snap.data.reason).toBe("out-of-band");
  });

  it("evidencePaths is empty (no local file to inspect)", () => {
    const snap = snapshotCcdRemoteSsh({
      pluginId: "myplugin@mymp",
      rootRef: { kind: "ccd" },
    });
    expect(snap.evidencePaths).toHaveLength(0);
  });

  it("parses pluginId into plugin/marketplace names", () => {
    const snap = snapshotCcdRemoteSsh({
      pluginId: "founder-skills@lool-founder-skills",
      rootRef: { kind: "ccd" },
    });
    if (snap.subject.kind === "plugin") {
      expect(snap.subject.ref.pluginName).toBe("founder-skills");
      expect(snap.subject.ref.marketplace).toBe("lool-founder-skills");
    } else {
      throw new Error("Expected subject.kind === 'plugin'");
    }
  });

  it("rootRef is preserved", () => {
    const rootRef = { kind: "cowork" as const, accountId: "acc1", orgId: "org1" };
    const snap = snapshotCcdRemoteSsh({ pluginId: "p@mp", rootRef });
    expect(snap.rootRef).toMatchObject(rootRef);
  });

  it("parsedAt is a valid ISO date string", () => {
    const snap = snapshotCcdRemoteSsh({
      pluginId: "p@mp",
      rootRef: { kind: "ccd" },
    });
    expect(() => new Date(snap.parsedAt)).not.toThrow();
    expect(new Date(snap.parsedAt).toISOString()).toBe(snap.parsedAt);
  });
});
