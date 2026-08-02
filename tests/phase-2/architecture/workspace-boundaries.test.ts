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
  ]) {
    cpSync(join(repositoryRoot, path), join(root, path), { recursive: true });
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
        "@agent-harness/api": "0.0.0",
        "@agent-harness/ui": "0.0.0",
      });
    }
  });

  it("builds and imports every private workspace entrypoint", async () => {
    const paths = [
      "packages/contracts",
      "packages/context",
      "packages/documents",
      "packages/rag",
      "packages/multimodal",
      "packages/tool-fabric",
      "packages/api",
      "packages/ui",
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
      expect(sourceModule.workspaceIdentity).toEqual(module.workspaceIdentity);
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
  });

  it("rejects package-to-app and app-to-app dependency edges", () => {
    const root = copyArchitectureFixture();
    updateJson(root, "packages/api/package.json", (manifest) => {
      manifest.dependencies = { "@agent-harness/app-api": "0.0.0" };
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
    updateJson(root, "packages/contracts/package.json", (manifest) => {
      manifest.dependencies = { "@agent-harness/context": "0.0.0" };
    });

    const result = runChecker(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/cycle|source DAG/u);
  });

  it("rejects deep root imports and duplicate authority declarations", () => {
    const root = copyArchitectureFixture();
    writeFileSync(
      join(root, "packages/context/src/index.ts"),
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
    expect(result.stderr).toMatch(/root package import.*packages\/context/u);
    expect(result.stderr).toMatch(/duplicate authority.*ModelGateway/u);
  });

  it("rejects noncanonical exports even with a declared production dependency", () => {
    const root = copyArchitectureFixture();
    updateJson(root, "packages/tool-fabric/package.json", (manifest) => {
      manifest.dependencies = {
        "@agent-harness/context": "0.0.0",
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
      join(root, "packages/context/src/index.ts"),
      [
        'void import("node:fs");',
        'void import("@agent-harness/contracts/private.js");',
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
      join(root, "packages/context/src/local-feature.ts"),
      "export const localFeature = true;\n",
    );
    writeFileSync(
      join(root, "packages/context/src/index.ts"),
      'export const localFeature = () => import("./local-feature.js");\n',
    );

    const result = runChecker(root);
    expect(result.status, result.stderr).toBe(0);
  });

  it("enforces the frozen safe builtin set per workspace", () => {
    const allowedRoot = copyArchitectureFixture();
    writeFileSync(
      join(allowedRoot, "packages/context/src/index.ts"),
      'import { createHash } from "node:crypto"; void createHash;\n',
    );
    expect(runChecker(allowedRoot).status).toBe(0);

    const deniedRoot = copyArchitectureFixture();
    writeFileSync(
      join(deniedRoot, "packages/context/src/index.ts"),
      'import { join } from "node:path"; void join;\n',
    );
    const denied = runChecker(deniedRoot);
    expect(denied.status).toBe(1);
    expect(denied.stderr).toMatch(
      /builtin import node:path is not approved for packages\/context/u,
    );
  });

  it("limits global transport access to the frozen workspace authority allowlist", () => {
    const allowedRoot = copyArchitectureFixture();
    writeFileSync(
      join(allowedRoot, "packages/api/src/index.ts"),
      'void fetch("https://example.invalid");\n',
    );
    expect(runChecker(allowedRoot).status).toBe(0);

    const deniedRoot = copyArchitectureFixture();
    writeFileSync(
      join(deniedRoot, "packages/api/src/index.ts"),
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
      join(root, "packages/context/src/outside.ts"),
    );
    symlinkSync(
      join(external, "nested"),
      join(root, "packages/context/src/nested"),
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
      join(root, "packages/tool-fabric/src/index.ts"),
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
    expect(result.stderr).toMatch(/filesystem/u);
    expect(result.stderr).toMatch(/CLI/u);
    expect(result.stderr).toMatch(/HTTP/u);
    expect(result.stderr).toMatch(/socket/u);
    expect(result.stderr).toMatch(/DNS/u);
    expect(result.stderr).toMatch(/global fetch/u);
    expect(result.stderr).toMatch(/credential environment/u);
  });

  it("rejects fetch/environment aliases, element access, eval, and Function", () => {
    const root = copyArchitectureFixture();
    writeFileSync(
      join(root, "packages/context/src/index.ts"),
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
