#!/usr/bin/env node
// Recursive size oracle. Replaces `du -sb` (GNU-only on macOS BSD).
// Same primitive cpd uses (fs.statSync(file).size) but in an isolated
// process — a bug in cpd's WALKER (the original recursive-size bug we
// caught) is not inherited by this oracle.
//
// Usage: node _size.mjs <dir>
//
// Symlinks are skipped, matching cpd. Unreadable entries are skipped.

import * as fs from "node:fs";
import * as path from "node:path";

function sizeOf(p) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(p, e.name);
    try {
      if (e.isSymbolicLink()) continue;
      if (e.isFile()) total += fs.statSync(full).size;
      else if (e.isDirectory()) total += sizeOf(full);
    } catch {
      // skip unreadable
    }
  }
  return total;
}

const target = process.argv[2];
if (!target) {
  console.error("usage: node _size.mjs <dir>");
  process.exit(64);
}
process.stdout.write(String(sizeOf(target)));
