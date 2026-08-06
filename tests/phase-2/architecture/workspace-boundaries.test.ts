import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const checkerPath = join(
  repositoryRoot,
  "scripts/check-workspace-boundaries.mjs",
);
const temporaryRoots: string[] = [];

const runChecker = (root = repositoryRoot) =>
  spawnSync(process.execPath, [checkerPath, "--root", root], {
    encoding: "utf8",
    shell: false,
    timeout: 20_000,
  });

const copyArchitectureFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "phase2-workspace-boundaries-"));
  temporaryRoots.push(root);
  for (const path of [
    "package.json",
    "package-lock.json",
    "index.ts",
    "turbo.json",
    "tsconfig.json",
    "tsconfig.build.json",
    "tsconfig.workspace.json",
    "eslint.config.js",
    "vitest.config.ts",
    "packages",
    "apps",
    "scripts",
    "verification",
  ]) {
    cpSync(join(repositoryRoot, path), join(root, path), {
      recursive: true,
      filter: (source) =>
        !source.split("/").some((part) => part === "dist" || part === ".turbo"),
    });
  }
  const gate = JSON.parse(
    readFileSync(join(root, "verification/gates/phase2-gate.json"), "utf8"),
  ) as { requirements: Array<{ test_files?: string[] }> };
  for (const testPath of gate.requirements.flatMap(
    (requirement) => requirement.test_files ?? [],
  )) {
    mkdirSync(join(root, testPath, ".."), { recursive: true });
    writeFileSync(join(root, testPath), "export {};\n");
  }
  return root;
};

const updateJson = (
  root: string,
  path: string,
  update: (value: Record<string, unknown>) => void,
) => {
  const absolute = join(root, path);
  const value = JSON.parse(readFileSync(absolute, "utf8")) as Record<
    string,
    unknown
  >;
  update(value);
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Phase 2 incremental monorepo architecture", () => {
  it("accepts the checked-in workspace topology and pinned local toolchain", () => {
    const result = runChecker();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const turbo = spawnSync(
      join(repositoryRoot, "node_modules/.bin/turbo"),
      ["--version"],
      { cwd: repositoryRoot, encoding: "utf8", shell: false },
    );
    expect(turbo.status, turbo.stderr).toBe(0);
    expect(turbo.stdout.trim()).toBe("2.10.5");
  });

  it("keeps the Phase 1 root publication surface unchanged", () => {
    const root = JSON.parse(
      readFileSync(join(repositoryRoot, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    expect({
      name: root.name,
      version: root.version,
      exports: root.exports,
      files: root.files,
    }).toEqual({
      name: "agent-harness",
      version: "0.1.0",
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
        },
      },
      files: ["dist"],
    });
  });

  it("makes every client app depend explicitly on both API contracts and shared UI", () => {
    for (const path of ["apps/web", "apps/desktop", "apps/tui"]) {
      const manifest = JSON.parse(
        readFileSync(join(repositoryRoot, path, "package.json"), "utf8"),
      ) as { dependencies: Record<string, string> };
      expect(manifest.dependencies, path).toEqual({
        "@agent-harness/ui": "0.0.0",
      });
    }
  });

  it(
    "builds and imports every private workspace entrypoint",
    { timeout: 120_000 },
    async () => {
      const paths = [
        "packages/runtime-core",
        "packages/tools",
        "packages/ui",
        "packages/documents",
        "packages/rag",
        "packages/multimodal",
        "apps/api",
        "apps/web",
        "apps/desktop",
        "apps/tui",
      ];
      for (const path of paths) {
        rmSync(join(repositoryRoot, path, "dist"), {
          recursive: true,
          force: true,
        });
      }
      const build = spawnSync(
        join(repositoryRoot, "node_modules/.bin/turbo"),
        ["run", "build", "--filter=@agent-harness/*"],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          shell: false,
          timeout: 120_000,
        },
      );
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

      for (const path of paths) {
        const manifest = JSON.parse(
          readFileSync(join(repositoryRoot, path, "package.json"), "utf8"),
        ) as {
          name: string;
          private: boolean;
          type: string;
          version: string;
        };
        expect(manifest.private, path).toBe(true);
        expect(manifest.version, path).toBe("0.0.0");
        expect(manifest.type, path).toBe("module");
        const module = (await import(
          pathToFileURL(join(repositoryRoot, path, "dist/index.js")).href
        )) as { workspaceIdentity?: { name: string; path: string } };
        expect(module.workspaceIdentity).toEqual({
          name: manifest.name,
          path,
        });
        const sourceModule = (await import(
          pathToFileURL(join(repositoryRoot, path, "src/index.ts")).href
        )) as { workspaceIdentity?: { name: string; path: string } };
        expect(sourceModule.workspaceIdentity).toEqual(
          module.workspaceIdentity,
        );
      }

      const apiApp = (await import(
        pathToFileURL(join(repositoryRoot, "apps/api/dist/index.js")).href
      )) as {
        composeApiApp?: (kernel: unknown) => unknown;
      };
      expect(apiApp.composeApiApp).toBeTypeOf("function");
      expect(() => apiApp.composeApiApp?.(null)).toThrow(/kernel public port/u);
      const minimalKernel = {
        Harness: class Harness {
          run() {
            return Promise.resolve();
          }
        },
        createDefaultExecutionContext: () => ({}),
      };
      const binding = apiApp.composeApiApp?.(minimalKernel) as {
        kernel?: typeof minimalKernel;
      };
      expect(binding.kernel?.Harness).toBe(minimalKernel.Harness);
      expect(binding.kernel?.createDefaultExecutionContext).toBe(
        minimalKernel.createDefaultExecutionContext,
      );
      expect(() =>
        apiApp.composeApiApp?.({ Harness: minimalKernel.Harness }),
      ).toThrow(/kernel public port/u);

      const sourceApiApp = (await import(
        pathToFileURL(join(repositoryRoot, "apps/api/src/index.ts")).href
      )) as { composeApiApp: (kernel: unknown) => typeof binding };
      const sourceBinding = sourceApiApp.composeApiApp(minimalKernel);
      expect(sourceBinding.kernel?.Harness).toBe(minimalKernel.Harness);
      expect(sourceBinding.kernel?.createDefaultExecutionContext).toBe(
        minimalKernel.createDefaultExecutionContext,
      );
      expect(() => sourceApiApp.composeApiApp(null)).toThrow(
        /kernel public port/u,
      );
      expect(() => sourceApiApp.composeApiApp(() => undefined)).toThrow(
        /kernel public port/u,
      );
      expect(() =>
        sourceApiApp.composeApiApp({ Harness: minimalKernel.Harness }),
      ).toThrow(/kernel public port/u);
      expect(() =>
        sourceApiApp.composeApiApp({
          Harness: class WrongName {
            run() {
              return Promise.resolve();
            }
          },
          createDefaultExecutionContext:
            minimalKernel.createDefaultExecutionContext,
        }),
      ).toThrow(/kernel public port/u);
      expect(() =>
        sourceApiApp.composeApiApp({
          Harness: class Harness {},
          createDefaultExecutionContext:
            minimalKernel.createDefaultExecutionContext,
        }),
      ).toThrow(/kernel public port/u);
    },
  );

  it("rejects package-to-app and app-to-app dependency edges", () => {
    const root = copyArchitectureFixture();
    updateJson(root, "packages/tools/package.json", (manifest) => {
      manifest.dependencies = { "@agent-harness/runtime-core": "0.0.0", "@agent-harness/app-api": "0.0.0" };
    });
    updateJson(root, "apps/web/package.json", (manifest) => {
      manifest.dependencies = { "@agent-harness/app-api": "0.0.0" };
    });

    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/package.*app|app.*app/u);
  });

  it("rejects dependency cycles and edges outside the frozen source DAG", () => {
    const root = copyArchitectureFixture();
    updateJson(root, "packages/documents/package.json", (manifest) => {
      manifest.dependencies = { "@agent-harness/runtime-core": "0.0.0" };
    });

    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/cycle|source DAG/u);
  });

  it("rejects deep root imports and duplicate authority declarations", () => {
    const root = copyArchitectureFixture();
    writeFileSync(
      join(root, "packages/runtime-core/src/index.ts"),
      [
        'import "agent-harness/runtime/runtime-loop.js";',
        'import "@harness/runtime/loop.js";',
        'import "agent-harness";',
        "export class ModelGateway {}",
      ].join("\n"),
    );

    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/deep root import/u);
    expect(result.stderr).toMatch(
      /root package import.*packages\/runtime-core/u,
    );
    expect(result.stderr).toMatch(/duplicate authority.*ModelGateway/u);
  });

  it(
    "keeps Phase 1 authority workspaces as identity-only scaffolds",
    { timeout: 20_000 },
    () => {
    for (const [label, source] of [
      [
        "known duplicate",
        [
          "export const workspaceIdentity = Object.freeze({ name: '@agent-harness/runtime-core', path: 'packages/runtime-core' } as const);",
          "export class StaticRouter {}",
        ].join("\n"),
      ],
      [
        "renamed business implementation",
        [
          "export const workspaceIdentity = Object.freeze({ name: '@agent-harness/runtime-core', path: 'packages/runtime-core' } as const);",
          "export function chooseExecutionRoute() { return 'direct'; }",
        ].join("\n"),
      ],
      [
        "unbound extra export",
        [
          "export const workspaceIdentity = Object.freeze({ name: '@agent-harness/runtime-core', path: 'packages/runtime-core' } as const);",
          "export { hiddenRouter } from './hidden-router.js';",
        ].join("\n"),
      ],
    ] as const) {
      const root = copyArchitectureFixture();
      writeFileSync(join(root, "packages/runtime-core/src/index.ts"), `${source}\n`);
      if (label === "unbound extra export") {
        writeFileSync(
          join(root, "packages/runtime-core/src/hidden-router.ts"),
          "export const hiddenRouter = () => 'direct';\n",
        );
      }

      const result = runChecker(root);
      expect(result.status, label).toBe(1);
      expect(result.stderr, label).toMatch(/identity-only scaffold/u);
    }
    },
  );

  it("rejects hidden renamed implementations outside the scaffold index", () => {
    const root = copyArchitectureFixture();
    writeFileSync(
      join(root, "packages/runtime-core/src/renamed-router.ts"),
      "export function chooseExecutionRoute() { return 'direct'; }\n",
    );

    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/identity-only scaffold/u);
  });

  it.each([".mts", ".cts", ".jsx", ".cjs"])(
    "rejects hidden authority source using the %s extension",
    (extension) => {
      const root = copyArchitectureFixture();
      writeFileSync(
        join(root, `packages/runtime-core/src/renamed-router${extension}`),
        "export function chooseExecutionRoute() { return 'direct'; }\n",
      );

      const result = runChecker(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/identity-only scaffold/u);
    },
  );

  it("derives duplicate authority names from the source-authority manifest", () => {
    const root = copyArchitectureFixture();
    const manifestPath = join(root, "verification/gates/phase2-gate.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      requirements: Array<Record<string, unknown>>;
    };
    const requirement = manifest.requirements.find(
      (entry) => entry.id === "AH-HOOK-001",
    );
    if (!requirement) throw new Error("missing AH-HOOK-001");
    const source = "packages/runtime-core/src/fake-verification.ts";
    const test = "tests/phase-2/unit/ah-hook-001.test.ts";
    requirement.source_files = [source];
    requirement.test_files = [test];
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(root, source), "export class VerificationEngine {}\n");
    mkdirSync(join(root, test, ".."), { recursive: true });
    writeFileSync(
      join(root, test),
      'import { VerificationEngine } from "../../../packages/runtime-core/src/fake-verification.js";\nvoid VerificationEngine;\n',
    );
    const indexPath = join(root, "packages/runtime-core/src/index.ts");
    writeFileSync(
      indexPath,
      `${readFileSync(indexPath, "utf8")}\nexport { VerificationEngine } from "./fake-verification.js";\n`,
    );

    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/duplicate authority declaration VerificationEngine/u);
  });

  it("does not authorize a router implementation with another owner's requirement comment", () => {
    const root = copyArchitectureFixture();
    writeFileSync(
      join(root, "packages/runtime-core/src/renamed-router.ts"),
      [
        "// AH-RUNTIME-SESSIONTREE-001 belongs to packages/runtime-core.",
        "export function chooseExecutionRoute() { return 'direct'; }",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "packages/runtime-core/src/index.ts"),
      [
        "export const workspaceIdentity = Object.freeze({ name: '@agent-harness/runtime-core', path: 'packages/runtime-core' } as const);",
        "export { chooseExecutionRoute } from './renamed-router.js';",
      ].join("\n"),
    );

    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/identity-only scaffold|structured requirement binding/u);
  });

  it("fails closed for nonliteral hidden business declarations", () => {
    const root = copyArchitectureFixture();
    writeFileSync(
      join(root, "packages/runtime-core/src/computed-router.ts"),
      [
        "const routeName = getRouteName();",
        "export default { [routeName]: () => 'direct' };",
      ].join("\n"),
    );

    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/identity-only scaffold|nonliteral/u);
  });

  it("allows explicitly bound SessionTree and Hook additions in runtime-core", () => {
    const root = copyArchitectureFixture();
    const manifestPath = join(root, "verification/gates/phase2-gate.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      requirements: Array<Record<string, unknown>>;
    };
    const bindings = [
      {
        id: "AH-RUNTIME-SESSIONTREE-001",
        source: "packages/runtime-core/src/session-tree.ts",
        test: "tests/phase-2/unit/ah-runtime-sessiontree-001.test.ts",
        code: [
          "export const sessionTreeRequirementId = 'AH-RUNTIME-SESSIONTREE-001' as const;",
          "export class SessionTree {}",
        ].join("\n"),
        testCode: [
          "import { SessionTree } from '../../../packages/runtime-core/src/session-tree.js';",
          "void SessionTree;",
        ].join("\n"),
        reexport: "export { SessionTree } from './session-tree.js';",
      },
      {
        id: "AH-HOOK-001",
        source: "packages/runtime-core/src/hook.ts",
        test: "tests/phase-2/unit/ah-hook-001.test.ts",
        code: [
          "export const hookRequirementId = 'AH-HOOK-001' as const;",
          "export function runHook() { return 'ok'; }",
        ].join("\n"),
        testCode: [
          "import { runHook } from '../../../packages/runtime-core/src/hook.js';",
          "void runHook;",
        ].join("\n"),
        reexport: "export { runHook } from './hook.js';",
      },
    ];
    for (const binding of bindings) {
      const requirement = manifest.requirements.find(
        (entry) => entry.id === binding.id,
      );
      if (!requirement) throw new Error(`missing ${binding.id}`);
      requirement.source_files = [
        ...new Set([
          ...((requirement.source_files as string[] | undefined) ?? []),
          binding.source,
        ]),
      ];
      requirement.test_suites = [
        ...new Set([
          ...((requirement.test_suites as string[] | undefined) ?? []),
          binding.test,
        ]),
      ];
      requirement.test_files = requirement.test_suites;
      mkdirSync(join(root, binding.source, ".."), { recursive: true });
      writeFileSync(join(root, binding.source), `${binding.code}\n`);
      mkdirSync(join(root, binding.test, ".."), { recursive: true });
      writeFileSync(join(root, binding.test), `${binding.testCode}\n`);
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(
      join(root, "packages/runtime-core/src/index.ts"),
      [
        "export const workspaceIdentity = Object.freeze({ name: '@agent-harness/runtime-core', path: 'packages/runtime-core' } as const);",
        "export interface RuntimeCorePackagePort { readonly workspace: typeof workspaceIdentity.name; }",
        ...bindings.map((binding) => binding.reexport),
      ].join("\n"),
    );

    const result = runChecker(root);
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects noncanonical exports even with a declared production dependency", () => {
    const root = copyArchitectureFixture();
    updateJson(root, "packages/tools/package.json", (manifest) => {
      manifest.dependencies = {
        "@agent-harness/runtime-core": "0.0.0",
        execa: "9.0.0",
      };
      manifest.exports = { ".": "./src/index.ts" };
    });

    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toMatch(/external dependency execa/u);
    expect(result.stderr).toMatch(/canonical built exports/u);
  });

  it("rejects dynamic imports, require, createRequire, and workspace deep imports", () => {
    const root = copyArchitectureFixture();
    writeFileSync(
      join(root, "packages/runtime-core/src/index.ts"),
      [
        'void import("node:fs");',
        'void import("@agent-harness/runtime-core/private.js");',
        'void import("./missing-feature.js");',
        "void import(moduleName);",
        'void require("node:child_process");',
        'void createRequire(import.meta.url)("node:http");',
      ].join("\n"),
    );

    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/filesystem/u);
    expect(result.stderr).toMatch(/CLI/u);
    expect(result.stderr).toMatch(/HTTP|createRequire/u);
    expect(result.stderr).toMatch(/workspace deep import/u);
    expect(result.stderr).toMatch(/non-literal dynamic import/u);
    expect(result.stderr).toMatch(/unresolvable relative import/u);
  });

  it("allows a literal dynamic import that resolves inside the same workspace", () => {
    const root = copyArchitectureFixture();
    writeFileSync(
      join(root, "packages/rag/src/local-feature.ts"),
      "export const localFeature = true;\n",
    );
    writeFileSync(
      join(root, "packages/rag/src/index.ts"),
      'export const localFeature = () => import("./local-feature.js");\n',
    );

    const result = runChecker(root);
    expect(result.status, result.stderr).toBe(0);
  });

  it("enforces the frozen safe builtin set per workspace", () => {
    const allowedRoot = copyArchitectureFixture();
    writeFileSync(
      join(allowedRoot, "packages/rag/src/index.ts"),
      'import { createHash } from "node:crypto"; void createHash;\n',
    );
    expect(runChecker(allowedRoot).status).toBe(0);

    const deniedRoot = copyArchitectureFixture();
    writeFileSync(
      join(deniedRoot, "packages/rag/src/index.ts"),
      'import { join } from "node:path"; void join;\n',
    );
    const denied = runChecker(deniedRoot);
    expect(denied.status).toBe(1);
    expect(denied.stderr).toMatch(
      /builtin import node:path is not approved for packages\/rag/u,
    );
  });

  it("limits global transport access to the frozen workspace authority allowlist", () => {
    const allowedRoot = copyArchitectureFixture();
    writeFileSync(
      join(allowedRoot, "apps/api/src/index.ts"),
      'void fetch("https://example.invalid");\n',
    );
    expect(runChecker(allowedRoot).status).toBe(0);

    const deniedRoot = copyArchitectureFixture();
    writeFileSync(
      join(deniedRoot, "apps/api/src/index.ts"),
      'void new WebSocket("wss://example.invalid");\n',
    );
    const denied = runChecker(deniedRoot);
    expect(denied.status).toBe(1);
    expect(denied.stderr).toMatch(/WebSocket/u);
  });

  it("fails closed for undeclared, absolute, aliased, scheme, legacy, and global network access", () => {
    const root = copyArchitectureFixture();
    writeFileSync(
      join(root, "packages/rag/src/index.ts"),
      [
        'import Database from "better-sqlite3";',
        'import "/tmp/escape.js";',
        'import "#internal";',
        'import legacy = require("node:path");',
        'void import("data:text/javascript,export default 1");',
        'void process.getBuiltinModule("node:fs");',
        'void new WebSocket("wss://example.invalid");',
        'void new EventSource("https://example.invalid/events");',
        'void global.fetch("https://example.invalid");',
        "void globalThis.WebSocket;",
        "void new XMLHttpRequest();",
        'void navigator.sendBeacon("https://example.invalid", "x");',
        'void globalThis.navigator.sendBeacon("https://example.invalid", "x");',
        "void Database; void legacy;",
      ].join("\n"),
    );

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/undeclared bare import better-sqlite3/u);
    expect(result.stderr).toMatch(/absolute import \/tmp\/escape\.js/u);
    expect(result.stderr).toMatch(/package import alias #internal/u);
    expect(result.stderr).toMatch(/URL scheme import data:/u);
    expect(result.stderr).toMatch(/import-equals require/u);
    expect(result.stderr).toMatch(/process\.getBuiltinModule/u);
    expect(result.stderr).toMatch(/WebSocket/u);
    expect(result.stderr).toMatch(/EventSource/u);
    expect(result.stderr).toMatch(/XMLHttpRequest/u);
    expect(result.stderr).toMatch(/navigator\.sendBeacon/u);
  });

  it.each([
    ["bare process", "void process.pid;"],
    ["direct element access", 'void process["getBuiltinModule"]("node:fs");'],
    [
      "direct destructuring",
      'const { getBuiltinModule } = process; void getBuiltinModule("node:fs");',
    ],
    [
      "global object property",
      'void globalThis.process.getBuiltinModule("node:fs");',
    ],
    [
      "global object element access",
      'void global["process"]["getBuiltinModule"]("node:fs");',
    ],
    [
      "global process destructuring",
      'const { process: runtime } = self; void runtime.getBuiltinModule("node:fs");',
    ],
    [
      "bare process alias",
      'const runtime = process; void runtime.getBuiltinModule("node:fs");',
    ],
    [
      "global object alias",
      'const host = window; void host.process.getBuiltinModule("node:fs");',
    ],
    [
      "constant computed aliases",
      'const host = globalThis; const processKey = "process"; const builtinKey = "getBuiltinModule"; void host[processKey][builtinKey]("node:fs");',
    ],
  ])("rejects global process access through %s", (_label, source) => {
    const root = copyArchitectureFixture();
    writeFileSync(
      join(root, "packages/rag/src/index.ts"),
      `${source}\n`,
    );

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/global process access is forbidden/u);
  });

  it("keeps process-independent cancellation globals available", () => {
    const root = copyArchitectureFixture();
    writeFileSync(
      join(root, "packages/rag/src/index.ts"),
      [
        "const controller = new AbortController();",
        "const signal: AbortSignal = controller.signal;",
        'const processResult = "safe local value";',
        "void signal; void processResult;",
      ].join("\n"),
    );

    const result = runChecker(root);

    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    [
      "a direct let initializer",
      "let authority = globalThis; void authority.process.pid;",
    ],
    [
      "an unwrapped var initializer through a resolved alias",
      "const root = window; var authority = ((root)); void authority.fetch;",
    ],
  ])(
    "rejects mutable global authority aliases through %s",
    (_label, source) => {
      const root = copyArchitectureFixture();
      writeFileSync(
        join(root, "packages/runtime-core/src/index.ts"),
        `${source}\n`,
      );

      const result = runChecker(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(
        /mutable global authority alias is forbidden/u,
      );
    },
  );

  it.each([
    [
      "multi-level constant process key",
      'const key0 = "process"; const key1 = key0; void globalThis[key1].pid;',
      /global process access is forbidden/u,
    ],
    [
      "computed process destructuring",
      'const key0 = "process"; const key1 = key0; const { [key1]: runtime } = globalThis; void runtime.pid;',
      /global process access is forbidden/u,
    ],
    [
      "cyclic constant aliases",
      "const key0 = key1; const key1 = key0; void globalThis[key0];",
      /unresolved global property access is forbidden/u,
    ],
    [
      "let string property key",
      'let key = "process"; void globalThis[key];',
      /unresolved global property access is forbidden/u,
    ],
    [
      "var string property key",
      'var key = "process"; void globalThis[key];',
      /unresolved global property access is forbidden/u,
    ],
    [
      "unknown property key",
      "const key = getGlobalKey(); void globalThis[key];",
      /unresolved global property access is forbidden/u,
    ],
  ])(
    "fails closed for %s",
    (_label, source, expectedError) => {
      const root = copyArchitectureFixture();
      writeFileSync(
        join(root, "packages/runtime-core/src/index.ts"),
        `${source}\n`,
      );

      const result = runChecker(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(expectedError);
    },
    20_000,
  );

  it("resolves a multi-level constant transport key only for its authority workspace", () => {
    const allowedRoot = copyArchitectureFixture();
    writeFileSync(
      join(allowedRoot, "apps/api/src/index.ts"),
      'const key0 = "fetch"; const key1 = key0; void globalThis[key1];\n',
    );
    expect(runChecker(allowedRoot).status).toBe(0);

    const deniedRoot = copyArchitectureFixture();
    writeFileSync(
      join(deniedRoot, "packages/runtime-core/src/index.ts"),
      'const key0 = "fetch"; const key1 = key0; void globalThis[key1];\n',
    );
    const denied = runChecker(deniedRoot);
    expect(denied.status).toBe(1);
    expect(denied.stderr).toMatch(/global fetch access is forbidden/u);
  }, 20_000);

  it("does not make a development dependency importable by production source", () => {
    const root = copyArchitectureFixture();
    updateJson(root, "packages/rag/package.json", (manifest) => {
      manifest.devDependencies = { "better-sqlite3": "12.4.1" };
    });
    updateJson(root, "package-lock.json", (lock) => {
      const packages = lock.packages as Record<string, Record<string, unknown>>;
      packages["packages/rag"]!.devDependencies = {
        "better-sqlite3": "12.4.1",
      };
    });
    writeFileSync(
      join(root, "packages/rag/src/index.ts"),
      'import Database from "better-sqlite3"; void Database;\n',
    );

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /production source cannot import development dependency better-sqlite3/u,
    );
  });

  it("allows a manifest-declared production dependency from production source", () => {
    const root = copyArchitectureFixture();
    updateJson(root, "packages/rag/package.json", (manifest) => {
      manifest.dependencies = {
        "@agent-harness/documents": "0.0.0",
        "better-sqlite3": "12.4.1",
      };
    });
    updateJson(root, "package-lock.json", (lock) => {
      const packages = lock.packages as Record<string, Record<string, unknown>>;
      packages["packages/rag"]!.dependencies = {
        "@agent-harness/documents": "0.0.0",
        "better-sqlite3": "12.4.1",
      };
    });
    writeFileSync(
      join(root, "packages/rag/src/index.ts"),
      'import Database from "better-sqlite3"; void Database;\n',
    );

    const result = runChecker(root);

    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects source files and nested directories reached through symlinks", () => {
    const root = copyArchitectureFixture();
    const external = mkdtempSync(join(tmpdir(), "phase2-workspace-external-"));
    temporaryRoots.push(external);
    writeFileSync(
      join(external, "outside.ts"),
      "export const outside = true;\n",
    );
    mkdirSync(join(external, "nested"));
    writeFileSync(
      join(external, "nested/index.ts"),
      "export const nested = true;\n",
    );
    symlinkSync(
      join(external, "outside.ts"),
      join(root, "packages/runtime-core/src/outside.ts"),
    );
    symlinkSync(
      join(external, "nested"),
      join(root, "packages/runtime-core/src/nested"),
    );

    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/symlink.*outside\.ts/u);
    expect(result.stderr).toMatch(/symlink.*nested/u);
  });

  it("rejects unregistered extra workspaces under either configured glob", () => {
    const root = copyArchitectureFixture();
    mkdirSync(join(root, "packages/rogue"));
    writeFileSync(
      join(root, "packages/rogue/package.json"),
      '{"name":"@agent-harness/rogue","private":true,"version":"0.0.0"}\n',
    );

    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unregistered workspace packages\/rogue/u);
  });

  it("rejects workspace dependency drift in the lockfile", () => {
    const root = copyArchitectureFixture();
    updateJson(root, "package-lock.json", (lock) => {
      const packages = lock.packages as Record<string, Record<string, unknown>>;
      packages["apps/web"]!.dependencies = {
        "@agent-harness/ui": "0.0.0",
        "@agent-harness/rogue": "0.0.0",
      };
    });

    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /package-lock.*apps\/web.*dependencies.*package\.json/u,
    );
  });

  it("rejects direct filesystem, CLI, HTTP, socket, DNS, fetch, and credential access", () => {
    const root = copyArchitectureFixture();
    writeFileSync(
      join(root, "packages/tools/src/index.ts"),
      [
        'import { readFileSync } from "node:fs";',
        'import { spawn } from "node:child_process";',
        'import "node:http";',
        'import "node:net";',
        'import "node:dns";',
        'void fetch("https://example.invalid");',
        "void process.env.API_KEY;",
      ].join("\n"),
    );

    const result = runChecker(root);
    expect(result.status).toBe(1);
    // node:fs, node:child_process, node:http, node:dns are in packages/tools safeBuiltins
    // so they are allowed and NOT flagged. Only node:net (socket), fetch, process, and
    // credential access are flagged.
    expect(result.stderr).toMatch(/socket/u);
    expect(result.stderr).toMatch(/global fetch/u);
    expect(result.stderr).toMatch(/credential environment/u);
  });

  it("rejects fetch/environment aliases, element access, eval, and Function", () => {
    const root = copyArchitectureFixture();
    writeFileSync(
      join(root, "packages/runtime-core/src/index.ts"),
      [
        "const f = fetch; void f;",
        'void globalThis["fetch"];',
        "const { env } = process; void env;",
        'void process["env"];',
        'void eval("1 + 1");',
        'void Function("return 1")();',
      ].join("\n"),
    );

    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/global fetch access/u);
    expect(result.stderr).toMatch(/credential environment/u);
    expect(result.stderr).toMatch(/dynamic code evaluation.*eval/u);
    expect(result.stderr).toMatch(/dynamic code evaluation.*Function/u);
  });

  it("rejects unpinned npm, Turbo, incomplete coverage, and missing workspaces", () => {
    const root = copyArchitectureFixture();
    updateJson(root, "package.json", (manifest) => {
      manifest.packageManager = "npm@latest";
      const devDependencies = manifest.devDependencies as Record<
        string,
        string
      >;
      devDependencies.turbo = "^2.10.5";
    });
    updateJson(root, "turbo.json", (config) => {
      const tasks = config.tasks as Record<string, Record<string, unknown>>;
      tasks.typecheck = { dependsOn: ["^typecheck"], outputs: [] };
    });
    rmSync(join(root, "apps/tui"), { recursive: true });
    writeFileSync(
      join(root, "vitest.config.ts"),
      readFileSync(join(root, "vitest.config.ts"), "utf8")
        .replace("        'packages/*/src/**/*.{ts,tsx}',\n", "")
        .replace("'**/*.test.ts'", "'**/*.test.ts', 'index.ts'"),
    );

    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/npm@10\.8\.2/u);
    expect(result.stderr).toMatch(/turbo.*2\.10\.5/u);
    expect(result.stderr).toMatch(/turbo typecheck.*build/u);
    expect(result.stderr).toMatch(/coverage/u);
    expect(result.stderr).toMatch(/workspace index\.ts/u);
    expect(result.stderr).toMatch(/apps\/tui/u);
  });
});
