/**
 * Tests for scripts/check-tier-purity.mjs
 *
 * Verifies that:
 *  1. The script exits 0 against the current clean src/.
 *  2. A forbidden import in src/resolvers/ causes exit 1.
 *  3. A fetch() call in src/drift/ causes exit 1.
 *  4. Allowed imports (node:path, node:url, node:crypto) are not flagged.
 */

import { execFileSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// test/unit/scripts/ → test/unit/ → test/ → repo root (3 levels)
const repoRoot = resolve(new URL("../../..", import.meta.url).pathname);
const scriptPath = join(repoRoot, "scripts", "check-tier-purity.mjs");

// Temp files created by tests — cleaned up in afterEach.
const tmpFiles: string[] = [];

function writeTmp(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
  tmpFiles.push(path);
}

afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try {
      unlinkSync(f);
    } catch {
      // already removed or never created
    }
  }
});

function runScript(): { exitCode: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [scriptPath], { encoding: "utf8" });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

describe("check-tier-purity.mjs", () => {
  it("exits 0 against clean src/", () => {
    const { exitCode } = runScript();
    expect(exitCode).toBe(0);
  });

  it("exits 1 when node:fs is imported in src/resolvers/", () => {
    const fixture = join(repoRoot, "src", "resolvers", "_test-forbidden-fs.ts");
    writeTmp(fixture, 'import * as fs from "node:fs";\nexport const x = 1;\n');
    const { exitCode, stderr } = runScript();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("node:fs");
  });

  it("exits 1 when node:child_process is imported in src/drift/", () => {
    const fixture = join(repoRoot, "src", "drift", "_test-forbidden-cp.ts");
    writeTmp(fixture, 'import { execSync } from "node:child_process";\nexport const x = 1;\n');
    const { exitCode, stderr } = runScript();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("node:child_process");
  });

  it("exits 1 when fetch() is called in src/recommendations/", () => {
    const fixture = join(repoRoot, "src", "recommendations", "_test-forbidden-fetch.ts");
    writeTmp(fixture, 'async function bad() { return await fetch("https://example.com"); }\n');
    const { exitCode, stderr } = runScript();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("fetch()");
  });

  it("does not flag node:path, node:url, or node:crypto in pure tiers", () => {
    const fixture = join(repoRoot, "src", "resolvers", "_test-allowed-imports.ts");
    writeTmp(
      fixture,
      `${[
        'import { join } from "node:path";',
        'import { fileURLToPath } from "node:url";',
        'import { randomUUID } from "node:crypto";',
        "export const x = 1;",
      ].join("\n")}\n`,
    );
    const { exitCode } = runScript();
    expect(exitCode).toBe(0);
  });

  it("exits 1 when node:https is imported in src/drift/", () => {
    const fixture = join(repoRoot, "src", "drift", "_test-forbidden-https.ts");
    writeTmp(fixture, 'import * as https from "node:https";\nexport const x = 1;\n');
    const { exitCode, stderr } = runScript();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("node:https");
  });
});
