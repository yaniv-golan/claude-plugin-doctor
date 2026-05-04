import type { CacheSnapshot, CcdRemoteSshData, CheckResult, RootRef } from "../types.js";

export type CheckArgs = {
  pluginId: string;
};

export function checkCcdRemoteSsh(args: CheckArgs): CheckResult {
  // Pure v1.0 stub — SSH-into-remote cache verification is reserved work.
  return {
    plugin: args.pluginId,
    layer: "ccd_remote_ssh",
    status: "skipped",
    detail:
      "Standalone Claude Code's remote-mode SSH-side cache is on the remote machine. " +
      "If you're SSHed somewhere, also check '<remote-host>:.claude/remote/plugins/'.",
    evidence: { kind: "stub" },
  };
}

// ── v1.0 Tier C typed snapshot ───────────────────────────────────────────────

export type CcdRemoteSshSnapshotArgs = {
  /** The plugin id (typically `<plugin>@<marketplace>`). */
  pluginId: string;
  /** Which root this snapshot belongs to. */
  rootRef: RootRef;
};

/**
 * Returns a typed `CacheSnapshot` for the ccd_remote_ssh layer.
 *
 * The CCD remote SSH cache is on a remote machine that cpd cannot access
 * locally. The snapshot is always `presence: "n/a-for-source"` and carries
 * `reason: "out-of-band"`. Tier E treats this as an advisory only.
 */
export function snapshotCcdRemoteSsh(args: CcdRemoteSshSnapshotArgs): CacheSnapshot {
  const { pluginId, rootRef } = args;

  const data: CcdRemoteSshData = {
    kind: "ccd_remote_ssh",
    reason: "out-of-band",
  };

  // Parse pluginId as `<plugin>@<marketplace>` for the plugin ref.
  const atIdx = pluginId.lastIndexOf("@");
  const pluginName = atIdx > 0 ? pluginId.slice(0, atIdx) : pluginId;
  const marketplace = atIdx > 0 ? pluginId.slice(atIdx + 1) : "";

  return {
    layer: "ccd_remote_ssh",
    rootRef,
    subject: {
      kind: "plugin",
      ref: { pluginName, marketplace, root: rootRef },
    },
    presence: "n/a-for-source",
    evidencePaths: [],
    parsedAt: new Date().toISOString(),
    data,
  };
}
