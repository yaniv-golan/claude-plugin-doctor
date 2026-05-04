import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Files/dirs ignored by `hashSourceDir`. Empirically calibrated against a real
 * Claude Desktop 1.5354.0 install — anything that legitimately diverges between
 * source and cache despite no source-code change goes here.
 *
 * - `.git`, `node_modules`, `.DS_Store`, `.vitest-cache`, `.npmrc.local`: noise.
 * - `.orphaned_at`: metadata file Claude writes into the cache when the
 *   marketplace clone goes missing. Cache-side only; would always false-positive.
 * - `.registry`: MCP-server runtime state. Some plugins mutate `.registry/*.json`
 *   at runtime, so source and cache diverge even with no source-code change.
 *
 * NOT excluded: `.claude-plugin/` directory — it's part of every plugin and IS
 * what we want to verify is identical between source and install.
 */
const IGNORE = new Set([
  ".git",
  "node_modules",
  ".DS_Store",
  ".vitest-cache",
  ".npmrc.local",
  ".orphaned_at",
  ".registry",
]);

/**
 * Walk `rootPath` recursively (skipping IGNORE), collect (relPath, sha256(file))
 * pairs, sort by relPath, and hash the joined string. Returns "" when rootPath
 * doesn't exist. Synchronous — directories are small and we want determinism.
 */
export function hashSourceDir(rootPath: string): string {
  if (!fs.existsSync(rootPath)) return "";
  const entries: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let names: string[];
    try {
      names = fs.readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (IGNORE.has(name)) continue;
      const abs = path.join(dir, name);
      const childRel = rel === "" ? name : `${rel}/${name}`;
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(abs, childRel);
      } else if (stat.isFile()) {
        const fileHash = crypto.createHash("sha256");
        const fd = fs.openSync(abs, "r");
        const buf = Buffer.allocUnsafe(64 * 1024);
        try {
          while (true) {
            const n = fs.readSync(fd, buf, 0, buf.length, null);
            if (n === 0) break;
            fileHash.update(buf.subarray(0, n));
          }
        } finally {
          fs.closeSync(fd);
        }
        entries.push(`${childRel}\0${fileHash.digest("hex")}`);
      }
    }
  };
  walk(rootPath, "");
  const aggregate = crypto.createHash("sha256");
  for (const e of entries) aggregate.update(`${e}\n`);
  return `sha256-${aggregate.digest("hex")}`;
}
