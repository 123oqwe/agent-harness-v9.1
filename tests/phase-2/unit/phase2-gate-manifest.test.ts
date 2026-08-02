import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  computePhase2CanonicalSha256,
  DEFAULT_MANIFEST_PATH,
  parseTrackedGitIndex,
  validatePhase2Manifest,
  validatePhase2ManifestFile,
  validatePhase2ManifestSnapshotFile,
  verifySourceAuthorities,
  // @ts-expect-error The production checker intentionally ships as plain Node ESM.
} from "../../../scripts/gates/check-phase2-manifest.mjs";
// @ts-expect-error The production checker intentionally ships as plain Node ESM.
import * as phase2ManifestChecker from "../../../scripts/gates/check-phase2-manifest.mjs";

type Manifest = {
  schema_version: string;
  phase: number;
  baseline: { repository: string; sha: string };
  evidence_root: string;
  mutation_thresholds: { critical: number; core: number };
  source_authorities: Array<{
    id: string;
    migration_requirement: string | null;
    root: {
      state: "active" | "retired";
      paths: string[];
      exports: string[];
      tests: string[];
    };
    workspace: {
      state: "scaffold" | "active";
      owner: string;
      paths: string[];
      exports: string[];
      tests: string[];
    };
  }>;
  phase1_prerequisites: string[];
  requirements: Array<{
    id: string;
    priority: string;
    dependencies: string[];
    owner: string;
    test_suites: string[];
    eval_suites: string[];
    evidence_path: string;
    mutation_class: string;
    source_files?: string[];
    test_files?: string[];
  }>;
};

const fixturePath = (kind: "valid" | "invalid", name: string) =>
  resolve(process.cwd(), "fixtures", "phase-2", kind, name);

const checkerPath = resolve(
  process.cwd(),
  "scripts/gates/check-phase2-manifest.mjs",
);

const runCheckerCli = (args: string[] = []) =>
  spawnSync(process.execPath, [checkerPath, ...args], {
    encoding: "utf8",
    shell: false,
    timeout: 30_000,
  });

const loadFixture = (kind: "valid" | "invalid", name: string): Manifest =>
  JSON.parse(readFileSync(fixturePath(kind, name), "utf8")) as Manifest;

const clone = (manifest: Manifest): Manifest => structuredClone(manifest);

const createSourceAuthorityFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "phase2-source-authority-"));
  const manifest = loadFixture("valid", "phase2-gate.json");
  const paths = new Set(["index.ts", "verification/gates/phase2-gate.json"]);
  for (const authority of manifest.source_authorities) {
    for (const path of [...authority.root.paths, ...authority.root.tests]) {
      paths.add(path);
    }
  }
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(resolve(process.cwd(), path), join(root, path));
  }
  const git = (...args: string[]) => {
    const result = spawnSync("/usr/bin/git", args, {
      cwd: root,
      encoding: "utf8",
      shell: false,
    });
    expect(result.status, result.stderr).toBe(0);
  };
  git("init", "--quiet");
  git("add", ".");
  return { root, manifest, git };
};

const requirement = (manifest: Manifest, id: string) => {
  const result = manifest.requirements.find((entry) => entry.id === id);
  if (!result) throw new Error(`test fixture is missing ${id}`);
  return result;
};

const expectCanonicalHashMismatch = (errors: string[]) => {
  expect(
    errors.some((error) =>
      error.startsWith(
        "manifest canonical SHA-256 does not match frozen authority; expected ",
      ),
    ),
  ).toBe(true);
};

describe("Phase 2 release-gate manifest", () => {
  it("parses exact NUL-delimited index records and fails closed", () => {
    const blob = "a".repeat(40);
    expect(
      parseTrackedGitIndex(
        `100644 ${blob} 0\tindex.ts\u0000100755 ${blob} 0\tscripts/gate.mjs\u0000`,
      ),
    ).toEqual(
      new Map([
        ["index.ts", { mode: "100644", blob, status: "0" }],
        ["scripts/gate.mjs", { mode: "100755", blob, status: "0" }],
      ]),
    );
    for (const malformed of [
      `100644 ${blob} 0\tindex.ts`,
      `100644 ${"a".repeat(39)} 0\tindex.ts\u0000`,
      `100644 ${blob}\tindex.ts\u0000`,
      `100644 ${blob} 1\tindex.ts\u0000`,
      `100644 ${blob} 0\tindex.ts\u0000100644 ${blob} 0\tindex.ts\u0000`,
      `100644 ${blob} 0\t../index.ts\u0000`,
      `100644 ${blob} 0\t/absolute.ts\u0000`,
      "",
    ]) {
      expect(parseTrackedGitIndex(malformed)).toBeNull();
    }
  });

  it("freezes one active implementation for every Phase 1 source authority", () => {
    const manifest = loadFixture("valid", "phase2-gate.json");
    expect(manifest.source_authorities.map((entry) => entry.id)).toEqual([
      "Harness",
      "Gateway",
      "Router",
      "Runtime",
      "Strategies",
      "Tools",
      "Skills",
      "Policy",
      "PEP",
      "Capability",
      "Auth",
      "Secrets",
      "VFS",
      "Sandbox",
      "Session",
      "Verification",
    ]);
    for (const authority of manifest.source_authorities) {
      expect(
        [authority.root.state, authority.workspace.state].filter(
          (state) => state === "active",
        ),
        authority.id,
      ).toHaveLength(1);
      expect(authority.root.state, authority.id).toBe("active");
      expect(authority.workspace.state, authority.id).toBe("scaffold");
      expect(authority.migration_requirement, authority.id).toBeNull();
    }
  });

  it("rejects double-active, zero-active, and unsynchronized authority migrations", () => {
    const valid = loadFixture("valid", "phase2-gate.json");

    const doubleActive = clone(valid);
    doubleActive.source_authorities[0]!.workspace.state = "active";
    expect(validatePhase2Manifest(doubleActive).join("\n")).toMatch(
      /Harness.*exactly one active implementation/u,
    );

    const zeroActive = clone(valid);
    zeroActive.source_authorities[0]!.root.state = "retired";
    expect(validatePhase2Manifest(zeroActive).join("\n")).toMatch(
      /Harness.*exactly one active implementation/u,
    );

    const incompleteMigration = clone(valid);
    incompleteMigration.source_authorities[0]!.root.state = "retired";
    incompleteMigration.source_authorities[0]!.workspace.state = "active";
    expect(validatePhase2Manifest(incompleteMigration).join("\n")).toMatch(
      /Harness.*migration_requirement/u,
    );
  });

  it("freezes each authority's canonical owner and runtime value exports", () => {
    const wrongOwner = loadFixture("valid", "phase2-gate.json");
    const runtime = wrongOwner.source_authorities.find(
      (authority) => authority.id === "Runtime",
    );
    if (!runtime) throw new Error("missing Runtime authority");
    runtime.workspace.owner = "packages/tools";
    expect(validatePhase2Manifest(wrongOwner).join("\n")).toMatch(
      /Runtime workspace.owner must remain packages\/runtime-core/u,
    );

    const wrongExport = loadFixture("valid", "phase2-gate.json");
    const router = wrongExport.source_authorities.find(
      (authority) => authority.id === "Router",
    );
    if (!router) throw new Error("missing Router authority");
    router.root.exports = ["chooseExecutionRoute"];
    expect(validatePhase2Manifest(wrongExport).join("\n")).toMatch(
      /Router root.exports must remain.*StaticRouter/u,
    );
  });

  it("requires authority state, requirement, source, test, and root export to migrate in one commit", () => {
    const verifyAtomicAuthorityMigrations = (
      phase2ManifestChecker as Record<string, unknown>
    ).verifyAtomicAuthorityMigrations;
    expect(typeof verifyAtomicAuthorityMigrations).toBe("function");
    if (typeof verifyAtomicAuthorityMigrations !== "function") return;
    const createRepository = (split: boolean) => {
      const root = mkdtempSync(join(tmpdir(), "phase2-atomic-migration-"));
      const git = (...args: string[]) => {
        const result = spawnSync("/usr/bin/git", args, {
          cwd: root,
          encoding: "utf8",
          shell: false,
        });
        expect(result.status, result.stderr).toBe(0);
      };
      const manifestPath = join(root, "verification/gates/phase2-gate.json");
      mkdirSync(dirname(manifestPath), { recursive: true });
      writeFileSync(
        join(root, "index.ts"),
        'export * from "./runtime/loop.js";\n',
      );
      const base = {
        source_authorities: [
          {
            id: "Runtime",
            migration_requirement: null as string | null,
            root: {
              state: "active",
              paths: ["runtime/loop.ts"],
              exports: ["LoopEngine"],
              tests: ["tests/runtime/loop.test.ts"],
            },
            workspace: {
              state: "scaffold",
              owner: "packages/runtime-core",
              paths: ["packages/runtime-core/src/index.ts"],
              exports: ["workspaceIdentity"],
              tests: [] as string[],
            },
          },
        ],
        requirements: [
          {
            id: "AH-RUNTIME-SESSIONTREE-001",
            owner: "packages/runtime-core",
            test_suites: ["tests/phase-2/unit/session-tree.test.ts"],
          },
        ],
      };
      writeFileSync(manifestPath, `${JSON.stringify(base, null, 2)}\n`);
      mkdirSync(join(root, "runtime"), { recursive: true });
      writeFileSync(
        join(root, "runtime/loop.ts"),
        "export class LoopEngine {}\n",
      );
      mkdirSync(join(root, "tests/runtime"), { recursive: true });
      writeFileSync(join(root, "tests/runtime/loop.test.ts"), "export {};\n");
      git("init", "--quiet");
      git("add", ".");
      git(
        "-c",
        "user.name=Phase2",
        "-c",
        "user.email=p2@example.invalid",
        "commit",
        "-m",
        "base",
        "--quiet",
      );

      const migrated = structuredClone(base);
      const authority = migrated.source_authorities[0]!;
      const requirement = migrated.requirements[0]!;
      authority.root.state = "retired";
      authority.workspace.state = "active";
      authority.workspace.paths = ["packages/runtime-core/src/loop-engine.ts"];
      authority.workspace.exports = ["LoopEngine"];
      authority.workspace.tests = ["tests/phase-2/unit/session-tree.test.ts"];
      authority.migration_requirement = requirement.id;
      Object.assign(requirement, {
        source_files: authority.workspace.paths,
        test_files: authority.workspace.tests,
      });
      mkdirSync(join(root, "packages/runtime-core/src"), { recursive: true });
      writeFileSync(
        join(root, "packages/runtime-core/src/loop-engine.ts"),
        "export class LoopEngine {}\n",
      );
      mkdirSync(join(root, "tests/phase-2/unit"), { recursive: true });
      writeFileSync(
        join(root, "tests/phase-2/unit/session-tree.test.ts"),
        "export {};\n",
      );
      writeFileSync(manifestPath, `${JSON.stringify(migrated, null, 2)}\n`);
      if (split) {
        git("add", ".");
        git(
          "-c",
          "user.name=Phase2",
          "-c",
          "user.email=p2@example.invalid",
          "commit",
          "-m",
          "prestage",
          "--quiet",
        );
      }
      writeFileSync(
        join(root, "index.ts"),
        'export * from "./packages/runtime-core/src/loop-engine.js";\n',
      );
      git("add", ".");
      git(
        "-c",
        "user.name=Phase2",
        "-c",
        "user.email=p2@example.invalid",
        "commit",
        "-m",
        "migrate",
        "--quiet",
      );
      return root;
    };

    const atomic = createRepository(false);
    const split = createRepository(true);
    try {
      expect(
        (
          verifyAtomicAuthorityMigrations as (options: {
            repositoryRoot: string;
          }) => string[]
        )({ repositoryRoot: atomic }),
      ).toEqual([]);
      expect(
        (
          verifyAtomicAuthorityMigrations as (options: {
            repositoryRoot: string;
          }) => string[]
        )({ repositoryRoot: split }).join("\n"),
      ).toMatch(/same commit|atomic/u);
    } finally {
      rmSync(atomic, { recursive: true, force: true });
      rmSync(split, { recursive: true, force: true });
    }
  });

  it("assigns server composition to apps/api while contracts remain in packages/api", () => {
    const manifest = loadFixture("valid", "phase2-gate.json");

    expect(requirement(manifest, "AH-UX-API-001").owner).toBe("apps/api");
    expect(requirement(manifest, "AH-UX-CONTRACT-001").owner).toBe(
      "packages/api",
    );
  });

  it("accepts the valid fixture and the source-release authority manifest", () => {
    expect(
      validatePhase2Manifest(loadFixture("valid", "phase2-gate.json")),
    ).toEqual([]);
    expect(validatePhase2ManifestFile(DEFAULT_MANIFEST_PATH)).toEqual([]);
  });

  it("keeps the valid fixture as a byte-frozen snapshot of the sole authority", () => {
    const validBytes = readFileSync(
      fixturePath("valid", "phase2-gate.json"),
      "utf8",
    );
    expect(readFileSync(DEFAULT_MANIFEST_PATH, "utf8")).toBe(validBytes);
    expect(
      validatePhase2ManifestSnapshotFile(
        fixturePath("valid", "phase2-gate.json"),
      ),
    ).toEqual([]);

    const valid = JSON.parse(validBytes) as Manifest;
    const invalid = loadFixture("invalid", "phase2-gate-cycle.json");
    expect(requirement(invalid, "AH-HOOK-001").dependencies.pop()).toBe(
      "AH-CONTEXT-COMPILER-001",
    );
    expect(invalid).toEqual(valid);
  });

  it("never throws when canonical JSON input contains a cycle", () => {
    const circular = loadFixture("valid", "phase2-gate.json") as Manifest & {
      self?: unknown;
    };
    circular.self = circular;
    let errors: string[] = [];
    expect(() => {
      errors = validatePhase2Manifest(circular);
    }).not.toThrow();
    expect(errors).toContain(
      "manifest canonicalization failed: circular reference at $.self",
    );
  });

  it.each([
    ["bigint", 2n, "unsupported bigint at $.phase"],
    ["undefined", undefined, "unsupported undefined at $.phase"],
    ["function", () => undefined, "unsupported function at $.phase"],
    ["symbol", Symbol("phase"), "unsupported symbol at $.phase"],
    ["NaN", Number.NaN, "non-finite number NaN at $.phase"],
    [
      "Infinity",
      Number.POSITIVE_INFINITY,
      "non-finite number Infinity at $.phase",
    ],
  ])(
    "returns a stable error instead of throwing for %s",
    (_label, value, message) => {
      const manifest = loadFixture("valid", "phase2-gate.json");
      (manifest as unknown as Record<string, unknown>).phase = value;
      let errors: string[] = [];
      expect(() => {
        errors = validatePhase2Manifest(manifest);
      }).not.toThrow();
      expect(errors).toContain(`manifest canonicalization failed: ${message}`);
    },
  );

  it("rejects non-plain objects without throwing", () => {
    const manifest = loadFixture("valid", "phase2-gate.json");
    (manifest as unknown as Record<string, unknown>).baseline = new Date(0);
    let errors: string[] = [];
    expect(() => {
      errors = validatePhase2Manifest(manifest);
    }).not.toThrow();
    expect(errors).toContain(
      "manifest canonicalization failed: non-plain object Date at $.baseline",
    );
  });

  it("throws a typed error only from the low-level canonical hash API", () => {
    let thrown: unknown;
    try {
      computePhase2CanonicalSha256({ value: 2n });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      name: "CanonicalJsonError",
      code: "ERR_INVALID_CANONICAL_JSON",
      message: "unsupported bigint at $.value",
    });
  });

  it("rejects extra and symbol keys on the requirements array", () => {
    const valid = loadFixture("valid", "phase2-gate.json");
    const validHash = computePhase2CanonicalSha256(valid);

    const extraKey = clone(valid);
    (extraKey.requirements as unknown as Record<string, unknown>).evil = "PASS";
    expect(() => computePhase2CanonicalSha256(extraKey)).toThrowError(
      "unsupported array property evil at $.requirements",
    );
    expect(validatePhase2Manifest(extraKey)).toContain(
      "manifest canonicalization failed: unsupported array property evil at $.requirements",
    );

    const symbolKey = clone(valid);
    const evil = Symbol("evil");
    (symbolKey.requirements as unknown as Record<PropertyKey, unknown>)[evil] =
      "PASS";
    expect(() => computePhase2CanonicalSha256(symbolKey)).toThrowError(
      "unsupported symbol key at $.requirements",
    );
    expect(validatePhase2Manifest(symbolKey)).toContain(
      "manifest canonicalization failed: unsupported symbol key at $.requirements",
    );
    expect(computePhase2CanonicalSha256(valid)).toBe(validHash);
  });

  it("requires dense data properties on arrays", () => {
    const hole = loadFixture("valid", "phase2-gate.json");
    delete hole.requirements[0];
    expect(validatePhase2Manifest(hole)).toContain(
      "manifest canonicalization failed: unsupported undefined at $.requirements[0]",
    );

    const accessor = loadFixture("valid", "phase2-gate.json");
    Object.defineProperty(accessor.requirements, "evil", {
      enumerable: true,
      get() {
        throw new Error("getter must not execute");
      },
    });
    expect(validatePhase2Manifest(accessor)).toContain(
      "manifest canonicalization failed: accessor property at $.requirements.evil",
    );

    const nonEnumerable = loadFixture("valid", "phase2-gate.json");
    Object.defineProperty(nonEnumerable.requirements, "evil", {
      enumerable: false,
      value: "PASS",
    });
    expect(validatePhase2Manifest(nonEnumerable)).toContain(
      "manifest canonicalization failed: non-enumerable property at $.requirements.evil",
    );
  });

  it("rejects symbol, accessor, and non-enumerable keys on plain objects", () => {
    const symbolKey = loadFixture("valid", "phase2-gate.json");
    const evil = Symbol("evil");
    (symbolKey.baseline as unknown as Record<PropertyKey, unknown>)[evil] =
      "PASS";
    expect(validatePhase2Manifest(symbolKey)).toContain(
      "manifest canonicalization failed: unsupported symbol key at $.baseline",
    );

    const accessor = loadFixture("valid", "phase2-gate.json");
    Object.defineProperty(accessor.baseline, "region", {
      enumerable: true,
      get() {
        throw new Error("getter must not execute");
      },
    });
    expect(validatePhase2Manifest(accessor)).toContain(
      "manifest canonicalization failed: accessor property at $.baseline.region",
    );

    const nonEnumerable = loadFixture("valid", "phase2-gate.json");
    Object.defineProperty(nonEnumerable.baseline, "region", {
      enumerable: false,
      value: "local",
    });
    expect(validatePhase2Manifest(nonEnumerable)).toContain(
      "manifest canonicalization failed: non-enumerable property at $.baseline.region",
    );
  });

  it("wraps unexpected proxy failures as typed canonical errors with cause", () => {
    const ownKeysFailure = new Error("ownKeys exploded");
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw ownKeysFailure;
        },
      },
    );
    let thrown: unknown;
    try {
      computePhase2CanonicalSha256(hostile);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      name: "CanonicalJsonError",
      code: "ERR_INVALID_CANONICAL_JSON",
      message: "unexpected canonicalization error: ownKeys exploded",
      cause: ownKeysFailure,
    });

    let errors: string[] = [];
    expect(() => {
      errors = validatePhase2Manifest(hostile);
    }).not.toThrow();
    expect(errors).toContain(
      "manifest canonicalization failed: unexpected canonicalization error: ownKeys exploded",
    );

    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    expect(() => computePhase2CanonicalSha256(revocable.proxy)).toThrowError(
      expect.objectContaining({
        name: "CanonicalJsonError",
        code: "ERR_INVALID_CANONICAL_JSON",
      }),
    );
    expect(() => validatePhase2Manifest(revocable.proxy)).not.toThrow();
  });

  it("exercises the real CLI without a shell", { timeout: 60_000 }, () => {
    const valid = runCheckerCli();
    expect(valid.error).toBeUndefined();
    expect(valid.status).toBe(0);
    expect(valid.stdout).toContain("phase2-manifest: valid");
    expect(valid.stderr).toBe("");

    const cycle = runCheckerCli([
      fixturePath("invalid", "phase2-gate-cycle.json"),
    ]);
    expect(cycle.error).toBeUndefined();
    expect(cycle.status).toBe(1);
    expect(cycle.stderr).toContain("dependency cycle detected");

    const missing = runCheckerCli([
      fixturePath("invalid", "missing-phase2-gate.json"),
    ]);
    expect(missing.error).toBeUndefined();
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("unable to read Phase 2 manifest");

    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), "phase2-gate-manifest-"),
    );
    const malformedPath = join(temporaryDirectory, "malformed.json");
    try {
      writeFileSync(malformedPath, "{not-json", "utf8");
      const malformed = runCheckerCli([malformedPath]);
      expect(malformed.error).toBeUndefined();
      expect(malformed.status).toBe(1);
      expect(malformed.stderr).toContain("unable to read Phase 2 manifest");
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it(
    "binds every active source authority to real source, root exports, and tests",
    { timeout: 60_000 },
    () => {
      const fixture = createSourceAuthorityFixture();
      try {
        expect(
          verifySourceAuthorities({
            repositoryRoot: fixture.root,
            manifestPath: join(
              fixture.root,
              "verification/gates/phase2-gate.json",
            ),
          }),
        ).toEqual([]);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    [
      "comment",
      (source: string) =>
        source.replace(
          "export class StaticRouter {",
          "/* export class StaticRouter */ class RenamedRouter {",
        ),
    ],
    [
      "string",
      (source: string) =>
        source.replace(
          "export class StaticRouter {",
          'const exportDecoy = "export class StaticRouter"; class RenamedRouter {',
        ),
    ],
    [
      "local declaration",
      (source: string) =>
        source.replace("export class StaticRouter {", "class StaticRouter {"),
    ],
  ])(
    "rejects a %s fake active export",
    { timeout: 20_000 },
    (_label, transform) => {
      const fixture = createSourceAuthorityFixture();
      try {
        const path = join(fixture.root, "router/static-router.ts");
        writeFileSync(path, transform(readFileSync(path, "utf8")));
        expect(
          verifySourceAuthorities({
            repositoryRoot: fixture.root,
            manifestPath: join(
              fixture.root,
              "verification/gates/phase2-gate.json",
            ),
          }).join("\n"),
        ).toMatch(
          /StaticRouter.*(?:real|runtime value) export|(?:real|runtime value) export.*StaticRouter/u,
        );
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it(
    "rejects a root barrel that resolves an authority export from the wrong path",
    { timeout: 20_000 },
    () => {
      const fixture = createSourceAuthorityFixture();
      try {
        const decoy = join(fixture.root, "router/decoy-router.ts");
        writeFileSync(decoy, "export class StaticRouter {}\n");
        const indexPath = join(fixture.root, "index.ts");
        writeFileSync(
          indexPath,
          readFileSync(indexPath, "utf8").replace(
            "export * from './router/static-router.js';",
            "export * from './router/decoy-router.js';",
          ),
        );
        fixture.git("add", ".");
        expect(
          verifySourceAuthorities({
            repositoryRoot: fixture.root,
            manifestPath: join(
              fixture.root,
              "verification/gates/phase2-gate.json",
            ),
          }).join("\n"),
        ).toMatch(/StaticRouter.*root index|root index.*StaticRouter/u);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it(
    "rejects a bound authority test that only comments the symbol name",
    { timeout: 20_000 },
    () => {
      const fixture = createSourceAuthorityFixture();
      try {
        writeFileSync(
          join(fixture.root, "tests/router/static-router.test.ts"),
          "// StaticRouter\nexport {};\n",
        );
        expect(
          verifySourceAuthorities({
            repositoryRoot: fixture.root,
            manifestPath: join(
              fixture.root,
              "verification/gates/phase2-gate.json",
            ),
          }).join("\n"),
        ).toMatch(
          /StaticRouter.*(?:test binding|observable test assertion)|(?:test binding|observable test assertion).*StaticRouter/u,
        );
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    [
      "type-only authority and type-only test",
      "export type StaticRouter = { readonly fake: true };\n",
      [
        'import type { StaticRouter } from "../../router/static-router.js";',
        "type NeverExecuted = StaticRouter;",
        "export type { NeverExecuted };",
      ].join("\n"),
    ],
    [
      "void-only test use",
      "export class StaticRouter {}\n",
      [
        'import { StaticRouter } from "../../router/static-router.js";',
        "void StaticRouter;",
      ].join("\n"),
    ],
    [
      "unreachable test use",
      "export class StaticRouter {}\n",
      [
        'import { StaticRouter } from "../../router/static-router.js";',
        "if (false) { void StaticRouter; }",
      ].join("\n"),
    ],
    [
      "unrelated assertion",
      "export class StaticRouter {}\n",
      [
        'import { describe, expect, it } from "vitest";',
        'import { StaticRouter } from "../../router/static-router.js";',
        'describe("fake", () => {',
        '  it("does not assert router behavior", () => {',
        "    new StaticRouter();",
        "    expect(true).toBe(true);",
        "  });",
        "});",
      ].join("\n"),
    ],
    [
      "constructor existence assertion",
      "export class StaticRouter {}\n",
      [
        'import { describe, expect, it } from "vitest";',
        'import { StaticRouter } from "../../router/static-router.js";',
        'describe("fake", () => {',
        '  it("only proves construction", () => {',
        "    expect(new StaticRouter()).toBeDefined();",
        "  });",
        "});",
      ].join("\n"),
    ],
    [
      "typeof-only function assertion",
      "export function StaticRouter() { return true; }\n",
      [
        'import { describe, expect, it } from "vitest";',
        'import { StaticRouter } from "../../router/static-router.js";',
        'describe("fake", () => {',
        '  it("only proves the export type", () => {',
        '    expect(typeof StaticRouter).toBe("function");',
        "  });",
        "});",
      ].join("\n"),
    ],
    [
      "truthy-only function result assertion",
      "export function StaticRouter() { return true; }\n",
      [
        'import { describe, expect, it } from "vitest";',
        'import { StaticRouter } from "../../router/static-router.js";',
        'describe("fake", () => {',
        '  it("only proves a truthy result", () => {',
        "    expect(StaticRouter()).toBeTruthy();",
        "  });",
        "});",
      ].join("\n"),
    ],
  ])(
    "rejects %s as a real authority/test binding",
    { timeout: 20_000 },
    (_label, source, testSource) => {
      const fixture = createSourceAuthorityFixture();
      try {
        writeFileSync(join(fixture.root, "router/static-router.ts"), source);
        writeFileSync(
          join(fixture.root, "tests/router/static-router.test.ts"),
          `${testSource}\n`,
        );
        fixture.git(
          "add",
          "router/static-router.ts",
          "tests/router/static-router.test.ts",
        );
        expect(
          verifySourceAuthorities({
            repositoryRoot: fixture.root,
            manifestPath: join(
              fixture.root,
              "verification/gates/phase2-gate.json",
            ),
          }).join("\n"),
        ).toMatch(/runtime value export|observable test assertion/u);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it("rejects abnormal Git index modes", () => {
    const blob = "a".repeat(40);
    for (const mode of ["000000", "120000", "160000"]) {
      expect(
        parseTrackedGitIndex(`${mode} ${blob} 0\tindex.ts\u0000`),
        mode,
      ).toBeNull();
    }
  });

  it(
    "rejects an active authority whose working bytes drift from the Git index",
    { timeout: 20_000 },
    () => {
      const fixture = createSourceAuthorityFixture();
      try {
        const path = join(fixture.root, "router/static-router.ts");
        writeFileSync(path, `${readFileSync(path, "utf8")}\n`);
        expect(
          verifySourceAuthorities({
            repositoryRoot: fixture.root,
            manifestPath: join(
              fixture.root,
              "verification/gates/phase2-gate.json",
            ),
          }).join("\n"),
        ).toMatch(
          /Git index blob.*working bytes|working bytes.*Git index blob/u,
        );
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it("requires exactly 64 unique requirement IDs", () => {
    const tooShort = loadFixture("valid", "phase2-gate.json");
    tooShort.requirements.pop();
    expect(validatePhase2Manifest(tooShort)).toContain(
      "manifest.requirements must contain exactly 64 entries; received 63",
    );

    const duplicate = loadFixture("valid", "phase2-gate.json");
    duplicate.requirements[1]!.id = duplicate.requirements[0]!.id;
    expect(validatePhase2Manifest(duplicate)).toContain(
      "duplicate requirement id: AH-CONTEXT-COMPILER-001",
    );

    const substituted = loadFixture("valid", "phase2-gate.json");
    requirement(substituted, "AH-DOC-INGEST-DOCX-001").id = "AH-FAKE-001";
    expect(validatePhase2Manifest(substituted)).toContain(
      "manifest requirement set contains unknown id: AH-FAKE-001",
    );
    expect(validatePhase2Manifest(substituted)).toContain(
      "manifest requirement set is missing required id: AH-DOC-INGEST-DOCX-001",
    );
  });

  it("rejects undeclared external prerequisites and malformed dependency graphs", () => {
    const unknown = loadFixture("valid", "phase2-gate.json");
    requirement(unknown, "AH-CONTEXT-COMPILER-001").dependencies.push(
      "AH-UNKNOWN-001",
    );
    expect(validatePhase2Manifest(unknown)).toContain(
      "requirement AH-CONTEXT-COMPILER-001 depends on unknown requirement AH-UNKNOWN-001; add it to phase1_prerequisites if it is an external prerequisite",
    );

    const undeclared = loadFixture("valid", "phase2-gate.json");
    undeclared.phase1_prerequisites = undeclared.phase1_prerequisites.filter(
      (id) => id !== "AH-RUNTIME-SESSION-001",
    );
    expect(validatePhase2Manifest(undeclared)).toContain(
      "requirement AH-PAUSE-RESUME-001 depends on unknown requirement AH-RUNTIME-SESSION-001; add it to phase1_prerequisites if it is an external prerequisite",
    );

    expect(
      validatePhase2ManifestFile(
        fixturePath("invalid", "phase2-gate-cycle.json"),
      ),
    ).toContain(
      "dependency cycle detected: AH-CONTEXT-COMPILER-001 -> AH-RUNTIME-COMPACTION-001 -> AH-HOOK-001 -> AH-CONTEXT-COMPILER-001",
    );
  });

  it("rejects unexpected fields at every manifest object boundary", () => {
    const rootExtra = loadFixture("valid", "phase2-gate.json");
    (rootExtra as unknown as Record<string, unknown>).status = "PASS";
    const rootErrors = validatePhase2Manifest(rootExtra);
    expect(rootErrors).toContain("manifest contains unexpected field status");
    expectCanonicalHashMismatch(rootErrors);

    const baselineExtra = loadFixture("valid", "phase2-gate.json");
    (baselineExtra.baseline as unknown as Record<string, unknown>).branch =
      "main";
    const baselineErrors = validatePhase2Manifest(baselineExtra);
    expect(baselineErrors).toContain(
      "manifest.baseline contains unexpected field branch",
    );
    expectCanonicalHashMismatch(baselineErrors);

    const thresholdExtra = loadFixture("valid", "phase2-gate.json");
    (
      thresholdExtra.mutation_thresholds as unknown as Record<string, unknown>
    ).egress = 0;
    const thresholdErrors = validatePhase2Manifest(thresholdExtra);
    expect(thresholdErrors).toContain(
      "manifest.mutation_thresholds contains unexpected field egress",
    );
    expectCanonicalHashMismatch(thresholdErrors);

    const requirementExtra = loadFixture("valid", "phase2-gate.json");
    (
      requirement(requirementExtra, "AH-RAG-QUERY-001") as unknown as Record<
        string,
        unknown
      >
    ).implementation_status = "verified";
    const requirementErrors = validatePhase2Manifest(requirementExtra);
    expect(requirementErrors).toContain(
      "requirement AH-RAG-QUERY-001 contains unexpected field implementation_status",
    );
    expectCanonicalHashMismatch(requirementErrors);
  });

  it("treats array order as part of the frozen authority", () => {
    const reordered = loadFixture("valid", "phase2-gate.json");
    requirement(reordered, "AH-UI-TUI-001").dependencies.reverse();
    expectCanonicalHashMismatch(validatePhase2Manifest(reordered));
  });

  it("freezes every requirement's complete dependency set", () => {
    const missingOriginal = loadFixture("valid", "phase2-gate.json");
    requirement(missingOriginal, "AH-DOC-INGEST-DOCX-001").dependencies = [];
    expect(validatePhase2Manifest(missingOriginal)).toContain(
      'requirement AH-DOC-INGEST-DOCX-001 dependencies must exactly match frozen authority; expected ["AH-TOOL-READ-001"], received []',
    );

    const extraAcyclic = loadFixture("valid", "phase2-gate.json");
    requirement(extraAcyclic, "AH-DOC-INGEST-DOCX-001").dependencies.push(
      "AH-HOOK-001",
    );
    expect(validatePhase2Manifest(extraAcyclic)).toContain(
      'requirement AH-DOC-INGEST-DOCX-001 dependencies must exactly match frozen authority; expected ["AH-TOOL-READ-001"], received ["AH-TOOL-READ-001","AH-HOOK-001"]',
    );
  });

  it("requires the canonical evidence root and per-requirement evidence paths", () => {
    const wrongRoot = loadFixture("valid", "phase2-gate.json");
    wrongRoot.evidence_root = "artifacts/phase2";
    expect(validatePhase2Manifest(wrongRoot)).toContain(
      'manifest.evidence_root must be "artifacts/phase-2"; received "artifacts/phase2"',
    );

    const wrongPath = loadFixture("valid", "phase2-gate.json");
    requirement(wrongPath, "AH-RAG-QUERY-001").evidence_path =
      "artifacts/phase2/AH-RAG-QUERY-001.json";
    expect(validatePhase2Manifest(wrongPath)).toContain(
      'requirement AH-RAG-QUERY-001 evidence_path must be "artifacts/phase-2/AH-RAG-QUERY-001.json"; received "artifacts/phase2/AH-RAG-QUERY-001.json"',
    );
  });

  it("requires ownership, test suites, mutation classes, and minimum thresholds", () => {
    const missingOwner = loadFixture("valid", "phase2-gate.json");
    requirement(missingOwner, "AH-RAG-QUERY-001").owner = "";
    expect(validatePhase2Manifest(missingOwner)).toContain(
      "requirement AH-RAG-QUERY-001 owner must be a non-empty string",
    );

    const missingSuite = loadFixture("valid", "phase2-gate.json");
    requirement(missingSuite, "AH-RAG-QUERY-001").test_suites = [];
    expect(validatePhase2Manifest(missingSuite)).toContain(
      "requirement AH-RAG-QUERY-001 test_suites must be a non-empty array",
    );

    const badSuite = loadFixture("valid", "phase2-gate.json");
    requirement(badSuite, "AH-RAG-QUERY-001").test_suites = ["banana"];
    expect(validatePhase2Manifest(badSuite)).toContain(
      'requirement AH-RAG-QUERY-001 test_suites entry must be a concrete Phase 2 test path without traversal; received "banana"',
    );

    const missingEval = loadFixture("valid", "phase2-gate.json");
    requirement(missingEval, "AH-RAG-QUERY-001").eval_suites = [];
    expect(validatePhase2Manifest(missingEval)).toContain(
      "requirement AH-RAG-QUERY-001 eval_suites must be a non-empty array",
    );

    const badEval = loadFixture("valid", "phase2-gate.json");
    requirement(badEval, "AH-RAG-QUERY-001").eval_suites = [
      "evals/../phase-2.yaml",
    ];
    expect(validatePhase2Manifest(badEval)).toContain(
      'requirement AH-RAG-QUERY-001 eval_suites entry must be one of the seven Phase 2 eval paths; received "evals/../phase-2.yaml"',
    );

    const badClass = loadFixture("valid", "phase2-gate.json");
    requirement(badClass, "AH-RAG-QUERY-001").mutation_class = "optional";
    expect(validatePhase2Manifest(badClass)).toContain(
      'requirement AH-RAG-QUERY-001 mutation_class must be "critical" or "core"; received "optional"',
    );

    const lowCritical = loadFixture("valid", "phase2-gate.json");
    lowCritical.mutation_thresholds.critical = 89;
    expect(validatePhase2Manifest(lowCritical)).toContain(
      "mutation_thresholds.critical must be at least 90; received 89",
    );

    const lowCore = loadFixture("valid", "phase2-gate.json");
    lowCore.mutation_thresholds.core = 84;
    expect(validatePhase2Manifest(lowCore)).toContain(
      "mutation_thresholds.core must be at least 85; received 84",
    );
  });

  it("locks valid-looking priorities, owners, and suites to each requirement", () => {
    const wrongPriority = loadFixture("valid", "phase2-gate.json");
    requirement(wrongPriority, "AH-RAG-QUERY-001").priority = "P1";
    expect(validatePhase2Manifest(wrongPriority)).toContain(
      'requirement AH-RAG-QUERY-001 priority must exactly match frozen authority; expected "P0", received "P1"',
    );

    const swappedOwner = loadFixture("valid", "phase2-gate.json");
    requirement(swappedOwner, "AH-RAG-QUERY-001").owner = "apps/web";
    expect(validatePhase2Manifest(swappedOwner)).toContain(
      'requirement AH-RAG-QUERY-001 owner must exactly match frozen authority; expected "packages/rag", received "apps/web"',
    );

    const borrowedSuite = loadFixture("valid", "phase2-gate.json");
    requirement(borrowedSuite, "AH-RAG-QUERY-001").test_suites = [
      "tests/phase-2/unit/ah-rag-meta-001.test.ts",
    ];
    expect(validatePhase2Manifest(borrowedSuite)).toContain(
      'requirement AH-RAG-QUERY-001 test_suites must exactly match frozen authority; expected ["tests/phase-2/unit/ah-rag-query-001.test.ts"], received ["tests/phase-2/unit/ah-rag-meta-001.test.ts"]',
    );

    const borrowedEval = loadFixture("valid", "phase2-gate.json");
    requirement(borrowedEval, "AH-RAG-QUERY-001").eval_suites = [
      "evals/research/phase-2.yaml",
    ];
    expect(validatePhase2Manifest(borrowedEval)).toContain(
      'requirement AH-RAG-QUERY-001 eval_suites must exactly match frozen authority; expected ["evals/documents/phase-2.yaml"], received ["evals/research/phase-2.yaml"]',
    );
  });

  it.each([
    "AH-TOOL-BEHAVIOR-VERIFY-001",
    "AH-TOOL-WEB-FETCH-001",
    "AH-TOOL-WEB-SEARCH-001",
    "AH-RAG-QUERY-001",
  ])("keeps risk-critical requirement %s at the 90 mutation gate", (id) => {
    const downgraded = loadFixture("valid", "phase2-gate.json");
    requirement(downgraded, id).mutation_class = "core";
    expect(validatePhase2Manifest(downgraded)).toContain(
      `requirement ${id} mutation_class must exactly match frozen authority; expected "critical", received "core"`,
    );
  });

  it("rejects any canonical authority hash drift", () => {
    const tampered = loadFixture("valid", "phase2-gate.json");
    tampered.mutation_thresholds.critical = 91;
    expectCanonicalHashMismatch(validatePhase2Manifest(tampered));
  });

  it("cannot bypass frozen authority by passing a second API argument", () => {
    const drifted = loadFixture("valid", "phase2-gate.json");
    requirement(drifted, "AH-RAG-QUERY-001").priority = "P1";
    requirement(drifted, "AH-RAG-QUERY-001").owner = "apps/web";
    requirement(drifted, "AH-RAG-QUERY-001").mutation_class = "core";
    const errors = validatePhase2Manifest(drifted, {
      enforceAuthority: false,
    });
    expect(errors).toContain(
      'requirement AH-RAG-QUERY-001 priority must exactly match frozen authority; expected "P0", received "P1"',
    );
    expect(errors).toContain(
      'requirement AH-RAG-QUERY-001 owner must exactly match frozen authority; expected "packages/rag", received "apps/web"',
    );
    expect(errors).toContain(
      'requirement AH-RAG-QUERY-001 mutation_class must exactly match frozen authority; expected "critical", received "core"',
    );
    expectCanonicalHashMismatch(errors);
  });

  it("pins Phase 2 to the source-release baseline", () => {
    const wrongPhase = loadFixture("valid", "phase2-gate.json");
    wrongPhase.phase = 3;
    expect(validatePhase2Manifest(wrongPhase)).toContain(
      "manifest.phase must be 2; received 3",
    );

    const wrongSha = loadFixture("valid", "phase2-gate.json");
    wrongSha.baseline.sha = "deadbeef";
    expect(validatePhase2Manifest(wrongSha)).toContain(
      'manifest.baseline.sha must be "8dca581e11b8043aed257cb07c5161237633c40e"; received "deadbeef"',
    );

    const wrongRepository = loadFixture("valid", "phase2-gate.json");
    wrongRepository.baseline.repository = "internal-factory";
    expect(validatePhase2Manifest(wrongRepository)).toContain(
      'manifest.baseline.repository must be "https://github.com/123oqwe/agentharness91.git"; received "internal-factory"',
    );
  });

  it("enforces every release-critical dependency edge", () => {
    const valid = loadFixture("valid", "phase2-gate.json");
    const requiredEdges: Array<[string, string]> = [
      ["AH-DOC-INGEST-WEB-001", "AH-TOOL-WEB-FETCH-001"],
      ["AH-RAG-QUERY-001", "AH-RAG-EMBED-001"],
      ["AH-RAG-QUERY-001", "AH-RAG-META-001"],
      ["AH-RAG-QUERY-001", "AH-RAG-FTS-001"],
      ["AH-RAG-DELETE-001", "AH-RAG-EMBED-001"],
      ["AH-RAG-DELETE-001", "AH-RAG-META-001"],
      ["AH-RAG-DELETE-001", "AH-RAG-GRAPH-001"],
      ["AH-RAG-DELETE-001", "AH-RAG-FTS-001"],
      ["AH-RUNTIME-COMPACTION-001", "AH-HOOK-001"],
      ["AH-TOOL-ESCALATE-001", "AH-CONTRACT-TOOLSPEC-001"],
      ["AH-TOOL-ESCALATE-001", "AH-POLICY-ENGINE-001"],
      ["AH-TOOL-ESCALATE-001", "AH-CAPMAP-020"],
      ["AH-TOOL-ESCALATE-001", "AH-PAUSE-RESUME-001"],
      ["AH-UI-PLANNING-001", "AH-PA-VERTICAL-001"],
      ["AH-UI-NOTIFY-001", "AH-TOOL-ESCALATE-001"],
      ["AH-UI-TUI-001", "AH-UI-CHAT-001"],
      ["AH-UI-TUI-001", "AH-UX-API-001"],
      ["AH-UI-TUI-001", "AH-UX-CONTRACT-001"],
      ["AH-UI-TUI-001", "AH-RUNTIME-STEERING-001"],
    ];

    const webBackends: Record<string, string> = {
      "AH-UI-DOC-001": "AH-DOC-VERTICAL-001",
      "AH-UI-MM-001": "AH-MM-ARTIFACT-001",
      "AH-UI-NOTIFY-001": "AH-CAPMAP-020",
      "AH-UI-PLANNING-001": "AH-PLANNING-VERTICAL-001",
      "AH-UI-RECONCILE-001": "AH-PAUSE-RESUME-001",
      "AH-UI-RESEARCH-001": "AH-RESEARCH-VERTICAL-001",
      "AH-UI-WRITING-001": "AH-WRITING-VERTICAL-001",
    };
    for (const [id, backend] of Object.entries(webBackends)) {
      requiredEdges.push(
        [id, "AH-UX-WEB-001"],
        [id, "AH-UX-CONTRACT-001"],
        [id, backend],
        ["AH-UX-STATES-001", id],
      );
    }
    requiredEdges.push(
      ["AH-UX-STATES-001", "AH-UI-TUI-001"],
      ["AH-UX-STATES-001", "AH-UX-WEB-001"],
    );

    for (const [id, dependency] of requiredEdges) {
      const missingEdge = clone(valid);
      requirement(missingEdge, id).dependencies = requirement(
        missingEdge,
        id,
      ).dependencies.filter((candidate) => candidate !== dependency);
      expect(
        validatePhase2Manifest(missingEdge),
        `${id} -> ${dependency}`,
      ).toContain(
        `requirement ${id} is missing required dependency ${dependency}`,
      );
    }
  });
});
