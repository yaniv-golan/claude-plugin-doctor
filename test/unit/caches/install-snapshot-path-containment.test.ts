import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type MarketplacePluginEntry,
  resolvePluginSourcePath,
} from "../../../src/caches/install-snapshot.js";

const root = "/Users/me/.claude/plugins/marketplaces/acme";

function entry(overrides: Partial<MarketplacePluginEntry>): MarketplacePluginEntry {
  return {
    name: "p",
    sourceKind: "string",
    ...overrides,
  };
}

describe("resolvePluginSourcePath path containment (audit issue #10)", () => {
  it("returns a path under the root for a relative subdirectory", () => {
    const r = resolvePluginSourcePath(root, entry({ source: "plugins/p" }));
    expect(r).toBe(path.join(root, "plugins/p"));
  });

  it('accepts source = "." (legitimate "plugin source IS the clone root" shape)', () => {
    // The equality clause in the guard is required, not dead — `path.resolve(root, ".")`
    // returns `root` exactly, and that's a documented marketplace.json shape
    // for whole-repo-is-the-plugin marketplaces. Without the equality
    // clause, the guard would reject it.
    expect(resolvePluginSourcePath(root, entry({ source: "." }))).toBe(root);
  });

  it('accepts source = "" (also resolves to root)', () => {
    expect(resolvePluginSourcePath(root, entry({ source: "" }))).toBe(root);
  });

  it("rejects ../ traversal", () => {
    expect(resolvePluginSourcePath(root, entry({ source: "../escape" }))).toBeUndefined();
    expect(resolvePluginSourcePath(root, entry({ source: "../../etc/passwd" }))).toBeUndefined();
  });

  it("rejects absolute paths outside the root", () => {
    expect(resolvePluginSourcePath(root, entry({ source: "/etc/passwd" }))).toBeUndefined();
  });

  it("accepts an absolute path that happens to start with the root prefix only when it actually sits beneath it", () => {
    // path.sep is required between root and the rest — preventing prefix-only
    // matches like `/.../acme-evil` from being accepted as `/.../acme`.
    const sneaky = `${root}-evil/x`;
    expect(resolvePluginSourcePath(root, entry({ source: sneaky }))).toBeUndefined();
    const legitimate = path.join(root, "subdir/p");
    expect(resolvePluginSourcePath(root, entry({ source: legitimate }))).toBe(legitimate);
  });

  it("returns undefined for object-source plugins regardless of containment", () => {
    expect(resolvePluginSourcePath(root, entry({ sourceKind: "github" }))).toBeUndefined();
  });
});
