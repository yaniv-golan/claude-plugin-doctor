import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CoworkRootInfo } from "./types.js";

type SystemContext = {
  platform?: NodeJS.Platform;
  home?: string;
  env?: Record<string, string | undefined>;
};

const defaults = (ctx: SystemContext = {}) => ({
  platform: ctx.platform ?? process.platform,
  home: ctx.home ?? os.homedir(),
  env: ctx.env ?? process.env,
});

export class NotImplementedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "NotImplementedError";
  }
}

export function resolveUserDataDir(ctx: SystemContext = {}): string {
  const { platform, home } = defaults(ctx);
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Claude");
  }
  // Linux: ~/.config/Claude (XDG_CONFIG_HOME override) — planned.
  // Windows: %APPDATA%\Claude — planned.
  throw new NotImplementedError(
    `claude-plugin-doctor supports macOS only (got platform=${platform}). Linux and Windows support is planned.`,
  );
}

export function resolveCcdPluginsRoot(ctx: SystemContext = {}): string {
  const { platform, home, env } = defaults(ctx);
  if (platform !== "darwin") {
    throw new NotImplementedError(
      `claude-plugin-doctor v0.1 supports macOS only (got platform=${platform}).`,
    );
  }
  const claudeDir = env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude");
  return path.join(claudeDir, "plugins");
}

export function enumerateCoworkRoots(userDataDir: string): CoworkRootInfo[] {
  const sessionsDir = path.join(userDataDir, "local-agent-mode-sessions");
  if (!fs.existsSync(sessionsDir)) return [];

  const out: CoworkRootInfo[] = [];
  let accounts: string[];
  try {
    accounts = fs.readdirSync(sessionsDir);
  } catch {
    return [];
  }

  for (const accountId of accounts) {
    const accDir = path.join(sessionsDir, accountId);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(accDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    let orgs: string[];
    try {
      orgs = fs.readdirSync(accDir);
    } catch {
      continue;
    }

    for (const orgId of orgs) {
      const rootDir = path.join(accDir, orgId);
      let orgStat: fs.Stats;
      try {
        orgStat = fs.statSync(rootDir);
      } catch {
        continue;
      }
      if (!orgStat.isDirectory()) continue;

      const installedPath = path.join(rootDir, "cowork_plugins", "installed_plugins.json");
      let mtime: number | undefined;
      try {
        mtime = fs.statSync(installedPath).mtimeMs;
      } catch {
        mtime = undefined;
      }
      const rpmManifestFile = path.join(rootDir, "rpm", "manifest.json");
      let rpmMtime: number | undefined;
      try {
        rpmMtime = fs.statSync(rpmManifestFile).mtimeMs;
      } catch {
        rpmMtime = undefined;
      }
      out.push({
        path: rootDir,
        accountId,
        orgId,
        ...(mtime !== undefined ? { installedPluginsMtime: mtime } : {}),
        ...(rpmMtime !== undefined ? { rpmManifestMtime: rpmMtime } : {}),
      });
    }
  }
  return out;
}

export function coworkPluginsRootFor(coworkRoot: CoworkRootInfo): string {
  return path.join(coworkRoot.path, "cowork_plugins");
}

export function rpmRootFor(coworkRoot: CoworkRootInfo): string {
  return path.join(coworkRoot.path, "rpm");
}
