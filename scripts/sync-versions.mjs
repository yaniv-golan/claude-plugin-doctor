#!/usr/bin/env node
// Reads package.json#version and propagates it to the plugin/skill manifests
// so a single `npm version <bump>` keeps all four surfaces in sync.
//
// Surfaces synced:
//   1. package.json                                          (authoritative — read, not written)
//   2. .claude-plugin/plugin.json                            ("version")
//   3. .claude-plugin/marketplace.json                       ("metadata.version")
//   4. skills/claude-plugin-doctor/SKILL.md                  (frontmatter metadata.version)
//
// Wired into package.json#scripts.version so it runs automatically inside
// `npm version <bump>` between the bump and the commit.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
if (!version) {
  console.error("sync-versions: package.json#version is empty");
  process.exit(1);
}

const updates = [];

// .claude-plugin/plugin.json — top-level "version"
{
  const file = join(root, ".claude-plugin/plugin.json");
  const raw = readFileSync(file, "utf8");
  const obj = JSON.parse(raw);
  if (obj.version !== version) {
    obj.version = version;
    writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
    updates.push(file);
  }
}

// .claude-plugin/marketplace.json — "metadata.version"
{
  const file = join(root, ".claude-plugin/marketplace.json");
  const raw = readFileSync(file, "utf8");
  const obj = JSON.parse(raw);
  obj.metadata ??= {};
  if (obj.metadata.version !== version) {
    obj.metadata.version = version;
    writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
    updates.push(file);
  }
}

// skills/claude-plugin-doctor/SKILL.md — YAML frontmatter metadata.version.
// Regex-scoped to the frontmatter block (between the first two `---` fences)
// so we never touch the body. Matches `version:` indented under any key,
// which is fine here because the only occurrence is inside `metadata:`.
{
  const file = join(root, "skills/claude-plugin-doctor/SKILL.md");
  const raw = readFileSync(file, "utf8");
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    console.error(`sync-versions: ${file} has no YAML frontmatter`);
    process.exit(1);
  }
  const fm = fmMatch[1];
  const versionLine = /^(\s+version:\s*)(?:"[^"]*"|'[^']*'|[^\s#]+)(\s*)$/m;
  if (!versionLine.test(fm)) {
    console.error(`sync-versions: ${file} frontmatter has no metadata.version line`);
    process.exit(1);
  }
  const newFm = fm.replace(versionLine, `$1${version}$2`);
  if (newFm !== fm) {
    const newRaw = raw.replace(fmMatch[0], `---\n${newFm}\n---`);
    writeFileSync(file, newRaw);
    updates.push(file);
  }
}

if (updates.length === 0) {
  console.log(`sync-versions: all surfaces already at ${version}`);
} else {
  console.log(`sync-versions: bumped ${updates.length} file(s) to ${version}:`);
  for (const f of updates) console.log(`  - ${f}`);
}
