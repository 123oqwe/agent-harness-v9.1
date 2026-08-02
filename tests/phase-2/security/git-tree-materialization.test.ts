import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

// @ts-expect-error The production materializer intentionally ships as plain Node ESM.
import { parseGitTreeEntries } from "../../../scripts/gates/materialize-git-tree.mjs";

const sha = "a".repeat(40);
const entry = (mode: string, type: string, path: string) =>
  Buffer.from(`${mode} ${type} ${sha}\t${path}\0`);

describe("exact Git tree materialization admission", () => {
  it("accepts only regular portable blob entries", () => {
    expect(
      parseGitTreeEntries(
        Buffer.concat([
          entry("100644", "blob", "docs/readme.md"),
          entry("100755", "blob", "scripts/run"),
        ]),
      ),
    ).toEqual([
      {
        mode: "100644",
        blobSha: sha,
        path: "docs/readme.md",
        segments: ["docs", "readme.md"],
      },
      {
        mode: "100755",
        blobSha: sha,
        path: "scripts/run",
        segments: ["scripts", "run"],
      },
    ]);
  });

  it.each([
    ["symlink", entry("120000", "blob", "link")],
    ["gitlink", entry("160000", "commit", "submodule")],
    ["dot Git", entry("100644", "blob", ".GIT/config")],
    ["parent traversal", entry("100644", "blob", "../outside")],
  ])("rejects %s entries before reading any blob", (_label, listing) => {
    expect(() => parseGitTreeEntries(listing)).toThrow(/unsupported|unsafe/u);
  });

  it("rejects invalid UTF-8 paths", () => {
    const header = Buffer.from(`100644 blob ${sha}\t`);
    expect(() =>
      parseGitTreeEntries(Buffer.concat([header, Buffer.from([0xff, 0])])),
    ).toThrow();
  });

  it("rejects case and Unicode-normalization path collisions", () => {
    expect(() =>
      parseGitTreeEntries(
        Buffer.concat([
          entry("100644", "blob", "Docs/Readme"),
          entry("100644", "blob", "docs/readme"),
        ]),
      ),
    ).toThrow(/collision/u);
    expect(() =>
      parseGitTreeEntries(
        Buffer.concat([
          entry("100644", "blob", "caf\u00e9"),
          entry("100644", "blob", "cafe\u0301"),
        ]),
      ),
    ).toThrow(/collision/u);
  });
});
