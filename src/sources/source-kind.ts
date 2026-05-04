/**
 * Canonical source-kind taxonomy parser for v1.0.
 *
 * Converts raw `marketplace.json#plugins[].source` field shapes into typed
 * `UpstreamSource` objects. This is the single place where the taxonomy
 * parsing logic lives; future phases use it. The existing v0.5 layer modules
 * are NOT modified to use this — they stay on their own parsing until phase 4.
 */

import type { UpstreamSource } from "../types.js";

/**
 * Parse a raw plugin entry source descriptor into a typed `UpstreamSource`.
 *
 * Handles:
 * - String form: `"./plugin-name"` → `{ kind: "string", path: "./plugin-name" }`
 * - Object form with `source` discriminator:
 *   - `"github"` → `{ kind: "github", repo, ref? }`
 *   - `"git"` → `{ kind: "git", url, ref? }`
 *   - `"url"` → `{ kind: "url", url, ref? }`
 *   - `"git-subdir"` → `{ kind: "git-subdir", url, path, ref? }`
 *   - `"npm"` → `{ kind: "npm", package, version?, registry? }`
 *   - `"directory"` → `{ kind: "directory", path }`
 *   - `"backend"` → `{ kind: "backend" }`
 * - Anything unrecognized → `{ kind: "unrecognized", raw }`
 */
export function parsePluginEntrySource(raw: unknown): UpstreamSource {
  if (typeof raw === "string") {
    return { kind: "string", path: raw };
  }

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { kind: "unrecognized", raw };
  }

  const obj = raw as Record<string, unknown>;
  const sourceKind = obj.source;

  switch (sourceKind) {
    case "github": {
      const repo = obj.repo;
      if (typeof repo !== "string" || !repo) {
        return { kind: "unrecognized", raw };
      }
      const ref = typeof obj.ref === "string" ? obj.ref : undefined;
      return { kind: "github", repo, ...(ref !== undefined ? { ref } : {}) };
    }

    case "git": {
      const url = obj.url;
      if (typeof url !== "string" || !url) {
        return { kind: "unrecognized", raw };
      }
      const ref = typeof obj.ref === "string" ? obj.ref : undefined;
      return { kind: "git", url, ...(ref !== undefined ? { ref } : {}) };
    }

    case "url": {
      const url = obj.url;
      if (typeof url !== "string" || !url) {
        return { kind: "unrecognized", raw };
      }
      const ref = typeof obj.ref === "string" ? obj.ref : undefined;
      return { kind: "url", url, ...(ref !== undefined ? { ref } : {}) };
    }

    case "git-subdir": {
      const url = obj.url;
      const subPath = obj.path;
      if (typeof url !== "string" || !url || typeof subPath !== "string" || !subPath) {
        return { kind: "unrecognized", raw };
      }
      const ref = typeof obj.ref === "string" ? obj.ref : undefined;
      return {
        kind: "git-subdir",
        url,
        path: subPath,
        ...(ref !== undefined ? { ref } : {}),
      };
    }

    case "npm": {
      const pkg = obj.package;
      if (typeof pkg !== "string" || !pkg) {
        return { kind: "unrecognized", raw };
      }
      const version = typeof obj.version === "string" ? obj.version : undefined;
      const registry = typeof obj.registry === "string" ? obj.registry : undefined;
      return {
        kind: "npm",
        package: pkg,
        ...(version !== undefined ? { version } : {}),
        ...(registry !== undefined ? { registry } : {}),
      };
    }

    case "directory": {
      const dirPath = obj.path;
      if (typeof dirPath !== "string" || !dirPath) {
        return { kind: "unrecognized", raw };
      }
      return { kind: "directory", path: dirPath };
    }

    case "backend": {
      return { kind: "backend" };
    }

    default:
      return { kind: "unrecognized", raw };
  }
}
