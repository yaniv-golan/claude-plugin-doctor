import type {
  CoworkRootInfo,
  MarketplaceReport,
  PluginReport,
  RpmReport,
  SkillsPluginRoot,
} from "../types.js";
import { type RunScanOpts, runV05Scan } from "./scan.js";

/** Slim shape for a single name-collision occurrence across or within stores.
 *  Canonical field — clients should prefer this over computing collisions
 *  themselves. Name-equality rule: case-sensitive exact match on plugin `name`
 *  after whitespace trim. */
export type NameCollisionEntry = {
  kind: "ccd" | "rpm";
  /** Display id for this occurrence: "<plugin>@<marketplaceName>" form. */
  id: string;
  /** The marketplace name associated with this occurrence — for `ccd` kind,
   *  this is the user's CCD alias; for `rpm` kind, the backend's name. */
  marketplaceName: string;
  /** When kind === "ccd": the alias from known_marketplaces.json (same value
   *  as marketplaceName for CCD). When kind === "rpm": undefined. */
  marketplaceAlias?: string;
  /** When kind === "rpm" AND array-form manifest. */
  marketplaceId?: string;
  /** When CCD's known_marketplaces.json[alias].source has a usable URL.
   *  Only populated for kind === "ccd". */
  sourceUrl?: string;
};

export type ListReport = {
  schemaVersion: "1.0";
  marketplaces: MarketplaceReport[];
  plugins: PluginReport[];
  rpmPlugins: RpmReport[];
  coworkRoots: CoworkRootInfo[];
  /** When topology has skills-plugin data, carries the full SkillsPluginRoot.
   *  Absent when topology has no skills-plugin data. Additive. */
  skillsPlugin?: SkillsPluginRoot;
  /** Plugin name collisions — same plugin name appearing in ≥2 places, either
   *  across stores (CCD ↔ RPM) or within the same store (intra-CCD or
   *  intra-RPM). Canonical: clients should use this field rather than
   *  computing collisions from `plugins[]` + `rpmPlugins[]`.
   *  Absent when no collisions exist. Additive. */
  nameCollisions?: Array<{
    pluginName: string;
    entries: NameCollisionEntry[];
  }>;
  exitCode: 0 | 2 | 3;
  runId: string;
  startedAt: string;
  finishedAt: string;
  logFile?: string;
};

/** Compute name-collision groups across both CCD plugins and RPM plugins.
 *  Returned as an array of groups where each group has ≥2 entries. */
function computeNameCollisions(
  plugins: PluginReport[],
  rpmPlugins: RpmReport[],
  marketplaces: MarketplaceReport[],
): Array<{ pluginName: string; entries: NameCollisionEntry[] }> {
  // Build a map from plugin name → all occurrences.
  const byName = new Map<string, NameCollisionEntry[]>();

  const add = (name: string, entry: NameCollisionEntry): void => {
    const existing = byName.get(name);
    if (existing) {
      existing.push(entry);
    } else {
      byName.set(name, [entry]);
    }
  };

  // CCD-installed plugins
  for (const p of plugins) {
    const marketplaceName = p.marketplace;
    const mp = marketplaces.find((m) => m.name === marketplaceName);
    // Build source URL from marketplace report data
    let sourceUrl: string | undefined;
    if (mp) {
      if (mp.sourceType === "github" && mp.sourceDetail) {
        sourceUrl = `github.com/${mp.sourceDetail}`;
      } else if (mp.sourceType === "git" && mp.sourceDetail) {
        sourceUrl = mp.sourceDetail;
      } else if (mp.sourceType === "directory" && mp.sourceDetail) {
        sourceUrl = mp.sourceDetail;
      }
    }
    add(p.pluginName, {
      kind: "ccd",
      id: p.id,
      marketplaceName,
      marketplaceAlias: marketplaceName,
      ...(sourceUrl !== undefined ? { sourceUrl } : {}),
    });
  }

  // RPM-installed plugins
  for (const r of rpmPlugins) {
    const name = r.name;
    if (!name) continue; // skip entries without a name (object-keyed form)
    const marketplaceName = r.marketplaceName ?? "(unknown)";
    add(name, {
      kind: "rpm",
      id: `${name}@${marketplaceName}`,
      marketplaceName,
      ...(r.marketplaceId !== undefined ? { marketplaceId: r.marketplaceId } : {}),
    });
  }

  // Return only groups with ≥2 occurrences.
  const result: Array<{ pluginName: string; entries: NameCollisionEntry[] }> = [];
  for (const [pluginName, entries] of byName) {
    if (entries.length >= 2) {
      result.push({ pluginName, entries });
    }
  }
  return result;
}

export async function runList(opts: RunScanOpts): Promise<ListReport> {
  const report = await runV05Scan(opts);

  // Compute name collisions across CCD plugins and RPM plugins.
  const rawCollisions = computeNameCollisions(
    report.plugins,
    report.rpmPlugins,
    report.marketplaces,
  );
  const nameCollisions = rawCollisions.length > 0 ? rawCollisions : undefined;

  // Extract skills-plugin data from topology (populated by runV05Scan).
  const skillsPlugin = report.topology?.skillsPlugin;

  return {
    schemaVersion: "1.0",
    marketplaces: report.marketplaces,
    plugins: report.plugins,
    rpmPlugins: report.rpmPlugins,
    coworkRoots: report.coworkRoots,
    ...(skillsPlugin !== undefined ? { skillsPlugin } : {}),
    ...(nameCollisions !== undefined ? { nameCollisions } : {}),
    exitCode: report.exitCode,
    runId: report.runId,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    ...(report.logFile ? { logFile: report.logFile } : {}),
  };
}
