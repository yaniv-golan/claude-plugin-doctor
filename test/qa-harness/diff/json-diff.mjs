#!/usr/bin/env node
// Structured JSON diff for the QA harness.
//
// Usage: node json-diff.mjs <cpd.json> <oracle.json> [<command>]
//
// Tolerances:
//   - Volatile fields stripped from both sides: runId, startedAt,
//     finishedAt, logFile.
//   - Set-valued arrays diffed by canonical key (orphans by orphanPath,
//     strayDirs by strayPath) — order doesn't matter.
//   - Numeric size fields tolerated within ±5% (filesystem block size
//     accounting can drift).
//
// Exit code 0 = equivalent; non-zero with stderr message otherwise.

import * as fs from "node:fs";

const VOLATILE = new Set(["runId", "startedAt", "finishedAt", "logFile"]);
const SIZE_FIELDS = new Set([
  "approxSizeBytes",
  "totalOrphanBytes",
  "totalStrayBytes",
  "totalReclaimableBytes",
]);
const SIZE_TOLERANCE = 0.05; // ±5%

const SET_KEY_BY_FIELD = {
  orphans: "orphanPath",
  strayDirs: "strayPath",
};

function stripVolatile(obj) {
  if (Array.isArray(obj)) return obj.map(stripVolatile);
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (VOLATILE.has(k)) continue;
      out[k] = stripVolatile(v);
    }
    return out;
  }
  return obj;
}

function sizeWithinTolerance(a, b) {
  if (a === b) return true;
  const max = Math.max(Math.abs(a), Math.abs(b));
  if (max === 0) return true;
  return Math.abs(a - b) / max <= SIZE_TOLERANCE;
}

function diff(cpd, oracle, path = "") {
  if (typeof cpd !== typeof oracle) {
    return [{ path, cpd, oracle, reason: "type-mismatch" }];
  }

  if (Array.isArray(cpd) && Array.isArray(oracle)) {
    const fieldName =
      path
        .split(".")
        .pop()
        ?.replace(/\[.*\]$/, "") ?? "";
    const setKey = SET_KEY_BY_FIELD[fieldName];
    if (setKey) {
      const cpdMap = new Map(cpd.map((x) => [x[setKey], x]));
      const oracleMap = new Map(oracle.map((x) => [x[setKey], x]));
      const out = [];
      for (const k of cpdMap.keys()) {
        if (!oracleMap.has(k)) {
          out.push({
            path: `${path}[${setKey}=${k}]`,
            cpd: cpdMap.get(k),
            oracle: undefined,
            reason: "missing-in-oracle",
          });
        } else {
          out.push(...diff(cpdMap.get(k), oracleMap.get(k), `${path}[${setKey}=${k}]`));
        }
      }
      for (const k of oracleMap.keys()) {
        if (!cpdMap.has(k)) {
          out.push({
            path: `${path}[${setKey}=${k}]`,
            cpd: undefined,
            oracle: oracleMap.get(k),
            reason: "missing-in-cpd",
          });
        }
      }
      return out;
    }
    if (cpd.length !== oracle.length) {
      return [{ path, cpd: cpd.length, oracle: oracle.length, reason: "array-length-mismatch" }];
    }
    const out = [];
    for (let i = 0; i < cpd.length; i++) {
      out.push(...diff(cpd[i], oracle[i], `${path}[${i}]`));
    }
    return out;
  }

  if (cpd && typeof cpd === "object" && oracle && typeof oracle === "object") {
    const out = [];
    const keys = new Set([...Object.keys(cpd), ...Object.keys(oracle)]);
    for (const k of keys) {
      out.push(...diff(cpd[k], oracle[k], path ? `${path}.${k}` : k));
    }
    return out;
  }

  // Primitive comparison.
  if (cpd === oracle) return [];

  const fieldName =
    path
      .split(".")
      .pop()
      ?.replace(/\[.*\]$/, "") ?? "";
  if (SIZE_FIELDS.has(fieldName) && typeof cpd === "number" && typeof oracle === "number") {
    if (sizeWithinTolerance(cpd, oracle)) return [];
    const ratio = oracle === 0 ? Number.POSITIVE_INFINITY : cpd / oracle;
    return [{ path, cpd, oracle, ratio, reason: "size-out-of-tolerance" }];
  }

  return [{ path, cpd, oracle, reason: "value-mismatch" }];
}

const [, , cpdFile, oracleFile, command = ""] = process.argv;
if (!cpdFile || !oracleFile) {
  console.error("usage: json-diff.mjs <cpd.json> <oracle.json> [<command>]");
  process.exit(64);
}

const cpd = stripVolatile(JSON.parse(fs.readFileSync(cpdFile, "utf8")));
const oracle = stripVolatile(JSON.parse(fs.readFileSync(oracleFile, "utf8")));
const divergences = diff(cpd, oracle);

if (divergences.length === 0) {
  process.exit(0);
}

console.error(JSON.stringify({ command, divergences }, null, 2));
process.exit(1);
