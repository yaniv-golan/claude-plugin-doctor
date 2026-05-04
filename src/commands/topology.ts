/**
 * `cpd topology` command — tier A debug subcommand.
 *
 * Builds a TopologyReport and returns it. The CLI wrapper handles formatting
 * and exit-code handling. No `process.exit` here.
 */

import { discoverTopology, runId } from "../discovery/topology.js";
import type { Logger } from "../logger.js";
import type { Progress } from "../progress.js";
import type { TopologyReport } from "../types.js";

type SystemContext = {
  platform?: NodeJS.Platform;
  home?: string;
  env?: Record<string, string | undefined>;
};

export type TopologyOpts = {
  ctx?: SystemContext;
  /** Absolute path of the active log file, if one is open. */
  logFile?: string | undefined;
  logger?: Logger;
  progress?: Progress;
};

/**
 * Runs the topology discovery and returns a TopologyReport.
 * Progress events: phase_start("discover_topology") → phase_end.
 */
export function runTopology(opts: TopologyOpts = {}): TopologyReport {
  const id = runId();
  const { logger, progress, logFile } = opts;

  const phaseStartMs = Date.now();
  progress?.start("discover_topology");

  let topology: ReturnType<typeof discoverTopology>;
  try {
    topology = discoverTopology(opts.ctx);
  } finally {
    const durationMs = Date.now() - phaseStartMs;
    progress?.end("discover_topology", durationMs);
  }

  logger?.info("topology_summary", {
    runId: id,
    ccd: topology.ccd?.pluginsRoot,
    coworkRoots: topology.cowork.length,
    skillsPluginPairs: topology.skillsPlugin?.pairs.length ?? 0,
    sessionLocals: topology.sessionLocals.length,
  });

  // Emit topology_render phase around the render step (spec §10.4.3).
  const renderStartMs = Date.now();
  progress?.start("topology_render");
  const result: TopologyReport = {
    schemaVersion: "1.0",
    runId: id,
    topology,
    exitCode: 0,
    ...(logFile !== undefined ? { logFile } : {}),
  };
  progress?.end("topology_render", Date.now() - renderStartMs);

  const totalMs = Date.now() - phaseStartMs;
  progress?.emitDone(totalMs, 0);

  return result;
}
