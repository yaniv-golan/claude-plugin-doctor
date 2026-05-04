import { describe, expect, it } from "vitest";
import { parsePluginEntrySource } from "../../../src/sources/source-kind.js";

describe("parsePluginEntrySource", () => {
  // String form
  it("parses a string path as kind=string", () => {
    expect(parsePluginEntrySource("./my-plugin")).toEqual({ kind: "string", path: "./my-plugin" });
  });

  it("parses any string as kind=string", () => {
    expect(parsePluginEntrySource("bare-name")).toEqual({ kind: "string", path: "bare-name" });
  });

  // github object
  it("parses a github source object", () => {
    expect(parsePluginEntrySource({ source: "github", repo: "owner/repo" })).toEqual({
      kind: "github",
      repo: "owner/repo",
    });
  });

  it("parses a github source object with ref", () => {
    expect(parsePluginEntrySource({ source: "github", repo: "owner/repo", ref: "main" })).toEqual({
      kind: "github",
      repo: "owner/repo",
      ref: "main",
    });
  });

  it("returns unsupported for github without repo", () => {
    const result = parsePluginEntrySource({ source: "github" });
    expect(result.kind).toBe("unrecognized");
  });

  // git object
  it("parses a git source object", () => {
    expect(parsePluginEntrySource({ source: "git", url: "https://example.com/repo.git" })).toEqual({
      kind: "git",
      url: "https://example.com/repo.git",
    });
  });

  it("parses a git source object with ref", () => {
    expect(
      parsePluginEntrySource({ source: "git", url: "https://example.com/repo.git", ref: "v1" }),
    ).toEqual({ kind: "git", url: "https://example.com/repo.git", ref: "v1" });
  });

  it("returns unsupported for git without url", () => {
    expect(parsePluginEntrySource({ source: "git" }).kind).toBe("unrecognized");
  });

  // url object
  it("parses a url source object", () => {
    expect(parsePluginEntrySource({ source: "url", url: "https://example.com/mp.zip" })).toEqual({
      kind: "url",
      url: "https://example.com/mp.zip",
    });
  });

  it("parses a url source object with ref", () => {
    expect(
      parsePluginEntrySource({ source: "url", url: "https://github.com/a/b", ref: "sha123" }),
    ).toEqual({ kind: "url", url: "https://github.com/a/b", ref: "sha123" });
  });

  it("returns unsupported for url without url field", () => {
    expect(parsePluginEntrySource({ source: "url" }).kind).toBe("unrecognized");
  });

  // git-subdir object
  it("parses a git-subdir source object", () => {
    expect(
      parsePluginEntrySource({
        source: "git-subdir",
        url: "https://example.com/repo.git",
        path: "plugins/foo",
      }),
    ).toEqual({ kind: "git-subdir", url: "https://example.com/repo.git", path: "plugins/foo" });
  });

  it("parses a git-subdir source object with ref", () => {
    expect(
      parsePluginEntrySource({
        source: "git-subdir",
        url: "https://example.com/repo.git",
        path: "plugins/foo",
        ref: "dev",
      }),
    ).toEqual({
      kind: "git-subdir",
      url: "https://example.com/repo.git",
      path: "plugins/foo",
      ref: "dev",
    });
  });

  it("returns unsupported for git-subdir without url or path", () => {
    expect(parsePluginEntrySource({ source: "git-subdir", url: "https://x.com/r.git" }).kind).toBe(
      "unrecognized",
    );
    expect(parsePluginEntrySource({ source: "git-subdir", path: "foo" }).kind).toBe("unrecognized");
  });

  // npm object
  it("parses an npm source object", () => {
    expect(parsePluginEntrySource({ source: "npm", package: "@scope/pkg" })).toEqual({
      kind: "npm",
      package: "@scope/pkg",
    });
  });

  it("parses an npm source object with version and registry", () => {
    expect(
      parsePluginEntrySource({
        source: "npm",
        package: "pkg",
        version: "2.0.0",
        registry: "https://registry.npmjs.org",
      }),
    ).toEqual({
      kind: "npm",
      package: "pkg",
      version: "2.0.0",
      registry: "https://registry.npmjs.org",
    });
  });

  it("returns unsupported for npm without package", () => {
    expect(parsePluginEntrySource({ source: "npm" }).kind).toBe("unrecognized");
  });

  // directory object
  it("parses a directory source object", () => {
    expect(parsePluginEntrySource({ source: "directory", path: "/some/local/dir" })).toEqual({
      kind: "directory",
      path: "/some/local/dir",
    });
  });

  it("returns unsupported for directory without path", () => {
    expect(parsePluginEntrySource({ source: "directory" }).kind).toBe("unrecognized");
  });

  // backend object
  it("parses a backend source object", () => {
    expect(parsePluginEntrySource({ source: "backend" })).toEqual({ kind: "backend" });
  });

  // Unsupported / unknown fallbacks
  it("returns unsupported for null", () => {
    expect(parsePluginEntrySource(null).kind).toBe("unrecognized");
  });

  it("returns unsupported for a number", () => {
    expect(parsePluginEntrySource(42).kind).toBe("unrecognized");
  });

  it("returns unsupported for an array", () => {
    expect(parsePluginEntrySource([]).kind).toBe("unrecognized");
  });

  it("returns unsupported for an unknown source discriminator", () => {
    const result = parsePluginEntrySource({ source: "ftp", url: "ftp://example.com" });
    expect(result.kind).toBe("unrecognized");
    if (result.kind === "unrecognized") {
      expect(result.raw).toEqual({ source: "ftp", url: "ftp://example.com" });
    }
  });

  it("preserves the raw value in unsupported", () => {
    const raw = { source: "mystery", data: 123 };
    const result = parsePluginEntrySource(raw);
    expect(result.kind).toBe("unrecognized");
    if (result.kind === "unrecognized") {
      expect(result.raw).toBe(raw);
    }
  });
});
