#!/usr/bin/env node

// Source-admission defense, not a runtime isolation boundary. Gateway,
// SecretsBroker, Policy/PEP, VFS, Sandbox, and Receipts remain authoritative.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPOSITORY_ROOT = resolve(scriptDirectory, "..");
export const ROOT_INDEX_SHA256 =
  "59bbb6cd7e51405c92e224c6d92258e8a3de2d4c6f578d14d54c9fded07511cd";

const workspace = (path, name, dependencies, role) =>
  Object.freeze({
    path,
    name,
    dependencies: Object.freeze(dependencies),
    role,
  });

export const EXPECTED_WORKSPACES = Object.freeze([
  workspace("packages/contracts", "@agent-harness/contracts", [], "package"),
  workspace(
    "packages/context",
    "@agent-harness/context",
    ["@agent-harness/contracts"],
    "package",
  ),
  workspace(
    "packages/documents",
    "@agent-harness/documents",
    ["@agent-harness/contracts"],
    "package",
  ),
  workspace(
    "packages/rag",
    "@agent-harness/rag",
    ["@agent-harness/documents"],
    "package",
  ),
  workspace(
    "packages/multimodal",
    "@agent-harness/multimodal",
    ["@agent-harness/documents"],
    "package",
  ),
  workspace(
    "packages/tool-fabric",
    "@agent-harness/tool-fabric",
    ["@agent-harness/context"],
    "package",
  ),
  workspace(
    "packages/api",
    "@agent-harness/api",
    [
      "@agent-harness/context",
      "@agent-harness/documents",
      "@agent-harness/rag",
      "@agent-harness/multimodal",
      "@agent-harness/tool-fabric",
    ],
    "package",
  ),
  workspace(
    "packages/ui",
    "@agent-harness/ui",
    ["@agent-harness/api"],
    "package",
  ),
  workspace(
    "apps/api",
    "@agent-harness/app-api",
    ["@agent-harness/api"],
    "app",
  ),
  workspace(
    "apps/web",
    "@agent-harness/app-web",
    ["@agent-harness/api", "@agent-harness/ui"],
    "app",
  ),
  workspace(
    "apps/desktop",
    "@agent-harness/app-desktop",
    ["@agent-harness/api", "@agent-harness/ui"],
    "app",
  ),
  workspace(
    "apps/tui",
    "@agent-harness/app-tui",
    ["@agent-harness/api", "@agent-harness/ui"],
    "app",
  ),
]);

const ROOT_PUBLICATION = Object.freeze({
  name: "agent-harness",
  version: "0.1.0",
  exports: {
    ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
  },
  files: ["dist"],
});
const EXPECTED_WORKSPACE_GLOBS = ["packages/*", "apps/*"];
const EXPECTED_PACKAGE_MANAGER = "npm@10.8.2";
const EXPECTED_TURBO = "2.10.5";
const EXPECTED_WORKSPACE_EXPORTS = {
  ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
};
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs"]);
const AUTHORITY_NAMES = new Set([
  "AuthorizationService",
  "DurableSession",
  "LoopEngine",
  "ModelGateway",
  "PolicyEngine",
  "PolicyEnforcementPoint",
  "Receipt",
  "Sandbox",
  "SecretsBroker",
  "SkillRegistry",
  "ToolDispatcher",
  "ToolRegistry",
  "VirtualFilesystem",
]);
const FORBIDDEN_IMPORTS = new Map([
  ["filesystem", new Set(["fs", "fs/promises", "node:fs", "node:fs/promises"])],
  ["CLI", new Set(["child_process", "node:child_process"])],
  ["HTTP", new Set(["http", "https", "node:http", "node:https", "undici"])],
  [
    "socket",
    new Set(["net", "tls", "dgram", "node:net", "node:tls", "node:dgram"]),
  ],
  ["DNS", new Set(["dns", "dns/promises", "node:dns", "node:dns/promises"])],
  ["module loader", new Set(["module", "node:module"])],
]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const stable = (value) => JSON.stringify(value);
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const readJson = (path, errors, label) => {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      errors.push(`${label} must not be a symlink`);
      return null;
    }
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(value)) throw new TypeError("root must be an object");
    return value;
  } catch (error) {
    errors.push(
      `${label} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
};

const sourceFiles = (root, errors, label) => {
  if (!existsSync(root)) return [];
  const metadata = lstatSync(root);
  if (metadata.isSymbolicLink()) {
    errors.push(`symlink source path is forbidden: ${label}`);
    return [];
  }
  if (metadata.isFile())
    return SOURCE_EXTENSIONS.has(extname(root)) ? [root] : [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "dist" || entry.name === "node_modules") return [];
    const path = join(root, entry.name);
    return entry.isDirectory() ||
      entry.isSymbolicLink() ||
      SOURCE_EXTENSIONS.has(extname(entry.name))
      ? sourceFiles(path, errors, `${label}/${entry.name}`)
      : [];
  });
};

const declarationNames = (node) => {
  if (
    (ts.isClassDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)) &&
    node.name
  ) {
    return [node.name.text];
  }
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
    );
  }
  return [];
};

const moduleAccesses = (sourceFile) => {
  const specifiers = [];
  const loaders = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      const argument = node.arguments[0];
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        argument &&
        ts.isStringLiteral(argument)
      ) {
        specifiers.push(argument.text);
      } else if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        loaders.push("non-literal dynamic import");
      }
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require"
      ) {
        loaders.push("require");
        if (argument && ts.isStringLiteral(argument))
          specifiers.push(argument.text);
      }
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "createRequire"
      ) {
        loaders.push("createRequire");
      }
      if (
        ts.isCallExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "createRequire"
      ) {
        loaders.push("createRequire");
        if (argument && ts.isStringLiteral(argument))
          specifiers.push(argument.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { specifiers, loaders };
};

const isDeclarationName = (node) => {
  const parent = node.parent;
  return (
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.name === node) ||
    (ts.isImportSpecifier(parent) && parent.name === node) ||
    (ts.isImportClause(parent) && parent.name === node) ||
    (ts.isNamespaceImport(parent) && parent.name === node) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isClassDeclaration(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isInterfaceDeclaration(parent) && parent.name === node) ||
    (ts.isTypeAliasDeclaration(parent) && parent.name === node)
  );
};

const elementAccessName = (node) =>
  ts.isElementAccessExpression(node) &&
  node.argumentExpression &&
  ts.isStringLiteral(node.argumentExpression)
    ? node.argumentExpression.text
    : null;

const sourceAuthorityViolations = (sourceFile) => {
  const violations = new Set();
  const visit = (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === "fetch" &&
      !isDeclarationName(node)
    ) {
      violations.add("direct global fetch access is forbidden");
    }
    if (
      (ts.isPropertyAccessExpression(node) &&
        node.expression.getText() === "globalThis" &&
        node.name.text === "fetch") ||
      (ts.isElementAccessExpression(node) &&
        node.expression.getText() === "globalThis" &&
        elementAccessName(node) === "fetch")
    ) {
      violations.add("direct global fetch access is forbidden");
    }
    if (
      (ts.isPropertyAccessExpression(node) &&
        ["process", "Deno"].includes(node.expression.getText()) &&
        node.name.text === "env") ||
      (ts.isElementAccessExpression(node) &&
        ["process", "Deno"].includes(node.expression.getText()) &&
        elementAccessName(node) === "env")
    ) {
      violations.add("direct credential environment read is forbidden");
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ["process", "Deno"].includes(node.initializer.getText()) &&
      node.name.elements.some(
        (element) =>
          (element.propertyName ?? element.name)
            .getText()
            .replace(/["']/gu, "") === "env",
      )
    ) {
      violations.add("direct credential environment read is forbidden");
    }
    if (
      ts.isIdentifier(node) &&
      ["eval", "Function"].includes(node.text) &&
      !isDeclarationName(node)
    ) {
      violations.add(`dynamic code evaluation via ${node.text} is forbidden`);
    }
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      node.expression.getText() === "globalThis"
    ) {
      const name = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : elementAccessName(node);
      if (name === "eval" || name === "Function")
        violations.add(`dynamic code evaluation via ${name} is forbidden`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...violations];
};

const pathIsInside = (root, candidate) => {
  const relation = relative(root, candidate);
  return (
    relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`))
  );
};

const findCycle = (graph) => {
  const visited = new Set();
  const active = new Set();
  const stack = [];
  const visit = (name) => {
    if (active.has(name)) return [...stack.slice(stack.indexOf(name)), name];
    if (visited.has(name)) return null;
    visited.add(name);
    active.add(name);
    stack.push(name);
    for (const dependency of graph.get(name) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    active.delete(name);
    return null;
  };
  for (const name of graph.keys()) {
    const cycle = visit(name);
    if (cycle) return cycle;
  }
  return null;
};

const checkConfigBindings = (root, packageJson, errors) => {
  const files = new Map();
  for (const path of [
    "turbo.json",
    "tsconfig.json",
    "tsconfig.build.json",
    "tsconfig.workspace.json",
    "vitest.config.ts",
    "scripts/check-cycles.mjs",
    "scripts/gates/verify-phase2-local.mjs",
  ]) {
    try {
      files.set(path, readFileSync(join(root, path), "utf8"));
    } catch {
      errors.push(`${path} is missing or unreadable`);
    }
  }
  const turbo = files.get("turbo.json");
  if (turbo) {
    try {
      const config = JSON.parse(turbo);
      if (stable(config.tasks?.build?.dependsOn) !== stable(["^build"]))
        errors.push("turbo build must follow the workspace dependency DAG");
      if (stable(config.tasks?.build?.outputs) !== stable(["dist/**"]))
        errors.push("turbo build output must be dist/**");
      if (
        stable(config.tasks?.typecheck?.dependsOn) !==
        stable(["^build", "^typecheck"])
      )
        errors.push(
          "turbo typecheck must build dependencies before checking consumers",
        );
    } catch {
      errors.push("turbo.json must be valid JSON");
    }
  }
  for (const path of ["tsconfig.json", "tsconfig.build.json"]) {
    const source = files.get(path) ?? "";
    if (!source.includes('"packages"') || !source.includes('"apps"')) {
      errors.push(
        `${path} must exclude workspace source from the Phase 1 root build`,
      );
    }
  }
  const coverage = files.get("vitest.config.ts") ?? "";
  for (const pattern of ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"]) {
    if (!coverage.includes(pattern))
      errors.push(`coverage must include ${pattern}`);
  }
  if (/exclude\s*:\s*\[[^\]]*["']index\.ts["']/su.test(coverage))
    errors.push(
      "coverage must not exclude every workspace index.ts entrypoint",
    );
  const cycles = files.get("scripts/check-cycles.mjs") ?? "";
  if (!cycles.includes("EXPECTED_WORKSPACES"))
    errors.push("cycle detection must include workspace-scoped imports");
  const gate = files.get("scripts/gates/verify-phase2-local.mjs") ?? "";
  for (const id of [
    "workspace-boundaries",
    "phase2-architecture",
    "workspace-coverage",
  ]) {
    if (!gate.includes(id)) errors.push(`Phase 2 gate must run ${id}`);
  }
  const scripts = isRecord(packageJson?.scripts) ? packageJson.scripts : {};
  if (
    !String(scripts.lint ?? "").includes("packages") ||
    !String(scripts.lint ?? "").includes("apps")
  )
    errors.push("lint must include packages and apps");
  for (const [name, script] of Object.entries(scripts)) {
    if (typeof script === "string" && /(^|\s)npx(?:\s|$)/u.test(script))
      errors.push(`script ${name} must not use implicit npx downloads`);
  }
};

export const checkWorkspaceBoundaries = ({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
} = {}) => {
  const root = resolve(repositoryRoot);
  const errors = [];
  const rootPackage = readJson(
    join(root, "package.json"),
    errors,
    "package.json",
  );
  if (rootPackage) {
    const publication = {
      name: rootPackage.name,
      version: rootPackage.version,
      exports: rootPackage.exports,
      files: rootPackage.files,
    };
    if (stable(publication) !== stable(ROOT_PUBLICATION))
      errors.push(
        "Phase 1 root name/version/exports/files publication surface changed",
      );
    if (rootPackage.packageManager !== EXPECTED_PACKAGE_MANAGER)
      errors.push(`packageManager must be ${EXPECTED_PACKAGE_MANAGER}`);
    if (stable(rootPackage.workspaces) !== stable(EXPECTED_WORKSPACE_GLOBS))
      errors.push("workspaces must be exactly packages/* and apps/*");
    if (rootPackage.devDependencies?.turbo !== EXPECTED_TURBO)
      errors.push(`turbo must be pinned exactly to ${EXPECTED_TURBO}`);
  }
  try {
    if (sha256(readFileSync(join(root, "index.ts"))) !== ROOT_INDEX_SHA256)
      errors.push("Phase 1 root public export set changed");
  } catch {
    errors.push("Phase 1 root index.ts is missing or unreadable");
  }

  const expectedByName = new Map(
    EXPECTED_WORKSPACES.map((entry) => [entry.name, entry]),
  );
  const expectedPaths = new Set(EXPECTED_WORKSPACES.map((entry) => entry.path));
  for (const collection of ["packages", "apps"]) {
    const collectionRoot = join(root, collection);
    if (!existsSync(collectionRoot)) continue;
    for (const entry of readdirSync(collectionRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const path = `${collection}/${entry.name}`;
      if (!expectedPaths.has(path))
        errors.push(`unregistered workspace ${path}`);
    }
  }
  const graph = new Map();
  for (const expected of EXPECTED_WORKSPACES) {
    const directory = join(root, expected.path);
    if (!existsSync(directory)) {
      errors.push(`missing workspace ${expected.path}`);
      continue;
    }
    if (lstatSync(directory).isSymbolicLink()) {
      errors.push(`workspace ${expected.path} must not be a symlink`);
      continue;
    }
    const manifest = readJson(
      join(directory, "package.json"),
      errors,
      `${expected.path}/package.json`,
    );
    if (!manifest) continue;
    if (manifest.name !== expected.name)
      errors.push(`${expected.path} has wrong package name`);
    if (manifest.private !== true)
      errors.push(`${expected.path} must be private`);
    if (manifest.version !== "0.0.0")
      errors.push(`${expected.path} version must be 0.0.0`);
    if (manifest.type !== "module") errors.push(`${expected.path} must be ESM`);
    if (
      manifest.main !== "./dist/index.js" ||
      manifest.types !== "./dist/index.d.ts"
    )
      errors.push(`${expected.path} must expose its built entrypoint`);
    if (stable(manifest.files) !== stable(["dist"]))
      errors.push(`${expected.path} files must be exactly dist`);
    if (stable(manifest.exports) !== stable(EXPECTED_WORKSPACE_EXPORTS))
      errors.push(`${expected.path} must use canonical built exports`);
    if (!existsSync(join(directory, "src/index.ts")))
      errors.push(`${expected.path} is missing src/index.ts`);
    if (!existsSync(join(directory, "tsconfig.json")))
      errors.push(`${expected.path} is missing tsconfig.json`);

    const dependencyNames = [];
    for (const section of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      const dependencies = isRecord(manifest[section]) ? manifest[section] : {};
      for (const [name, version] of Object.entries(dependencies)) {
        if (!expectedByName.has(name)) {
          errors.push(
            `${expected.path} external dependency ${name} is not approved in B0.4`,
          );
          continue;
        }
        dependencyNames.push(name);
        const target = expectedByName.get(name);
        if (version !== "0.0.0")
          errors.push(
            `${expected.path} workspace dependency ${name} must use 0.0.0`,
          );
        if (expected.role === "package" && target.role === "app")
          errors.push(
            `package ${expected.path} must not depend on app ${target.path}`,
          );
        if (expected.role === "app" && target.role === "app")
          errors.push(
            `app ${expected.path} must not depend on app ${target.path}`,
          );
      }
    }
    const uniqueDependencies = [...new Set(dependencyNames)].sort();
    const allowedDependencies = [...expected.dependencies].sort();
    if (stable(uniqueDependencies) !== stable(allowedDependencies))
      errors.push(
        `${expected.path} dependencies are outside the frozen source DAG`,
      );
    graph.set(expected.name, uniqueDependencies);
  }
  const cycle = findCycle(graph);
  if (cycle) errors.push(`workspace dependency cycle: ${cycle.join(" -> ")}`);

  for (const expected of EXPECTED_WORKSPACES) {
    const directory = join(root, expected.path);
    for (const file of sourceFiles(
      join(directory, "src"),
      errors,
      `${expected.path}/src`,
    )) {
      const sourceFile = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        extname(file) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const label = relative(root, file).replaceAll("\\", "/");
      const accesses = moduleAccesses(sourceFile);
      for (const loader of new Set(accesses.loaders)) {
        errors.push(`${label}: direct module loader ${loader} is forbidden`);
      }
      for (const specifier of accesses.specifiers) {
        for (const [category, forbidden] of FORBIDDEN_IMPORTS) {
          if (forbidden.has(specifier))
            errors.push(`${label}: direct ${category} access is forbidden`);
        }
        if (
          specifier.startsWith("agent-harness/") ||
          specifier.startsWith("@harness/") ||
          specifier.startsWith("@contracts/") ||
          specifier.startsWith("@spec-types/")
        )
          errors.push(`${label}: deep root import is forbidden`);
        if (specifier === "agent-harness")
          errors.push(
            `${label}: root package import from ${expected.path} is forbidden`,
          );
        if (specifier.startsWith(".")) {
          const base = resolve(dirname(file), specifier);
          const candidates = specifier.endsWith(".js")
            ? [base, base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx"]
            : [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")];
          if (!pathIsInside(directory, base))
            errors.push(`${label}: deep root import is forbidden`);
          else if (!candidates.some((candidate) => existsSync(candidate)))
            errors.push(
              `${label}: unresolvable relative import ${specifier} is forbidden`,
            );
        }
        const importedWorkspace = [...expectedByName.entries()].find(
          ([name]) => specifier === name || specifier.startsWith(`${name}/`),
        );
        if (importedWorkspace) {
          const [name, target] = importedWorkspace;
          if (specifier !== name)
            errors.push(
              `${label}: workspace deep import ${specifier} is forbidden`,
            );
          if (!expected.dependencies.includes(name))
            errors.push(
              `${label}: import ${name} is outside the frozen source DAG`,
            );
          if (expected.role === "package" && target.role === "app")
            errors.push(`${label}: package source must not import an app`);
          if (expected.role === "app" && target.role === "app")
            errors.push(`${label}: app source must not import another app`);
        }
      }
      const visit = (node) => {
        for (const name of declarationNames(node)) {
          if (AUTHORITY_NAMES.has(name))
            errors.push(
              `${label}: duplicate authority declaration ${name} is forbidden`,
            );
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      for (const violation of sourceAuthorityViolations(sourceFile))
        errors.push(`${label}: ${violation}`);
    }
  }

  if (rootPackage) checkConfigBindings(root, rootPackage, errors);
  const lock = readJson(
    join(root, "package-lock.json"),
    errors,
    "package-lock.json",
  );
  if (lock) {
    const rootLock = lock.packages?.[""];
    if (stable(rootLock?.workspaces) !== stable(EXPECTED_WORKSPACE_GLOBS))
      errors.push("package-lock root workspaces do not match package.json");
    if (rootLock?.devDependencies?.turbo !== EXPECTED_TURBO)
      errors.push(`package-lock must pin turbo exactly to ${EXPECTED_TURBO}`);
    for (const expected of EXPECTED_WORKSPACES) {
      const lockedWorkspace = lock.packages?.[expected.path];
      if (!isRecord(lockedWorkspace)) {
        errors.push(`package-lock is missing workspace ${expected.path}`);
        continue;
      }
      const expectedDependencies = Object.fromEntries(
        expected.dependencies.map((name) => [name, "0.0.0"]),
      );
      const lockedDependencies = isRecord(lockedWorkspace.dependencies)
        ? lockedWorkspace.dependencies
        : {};
      const dependencyEntries = (value) =>
        Object.entries(value).sort(([left], [right]) =>
          left.localeCompare(right),
        );
      if (
        stable(dependencyEntries(lockedDependencies)) !==
        stable(dependencyEntries(expectedDependencies))
      ) {
        errors.push(
          `package-lock workspace ${expected.path} dependencies do not match the frozen source DAG`,
        );
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    workspaceCount: EXPECTED_WORKSPACES.length,
    workspaces: EXPECTED_WORKSPACES.map(({ path, name, role }) => ({
      path,
      name,
      role,
    })),
  };
};

const parseArguments = (argv) => {
  if (argv.length === 0) return DEFAULT_REPOSITORY_ROOT;
  if (argv.length === 2 && argv[0] === "--root") return resolve(argv[1]);
  throw new Error("usage: check-workspace-boundaries.mjs [--root <path>]");
};

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  let result;
  try {
    result = checkWorkspaceBoundaries({
      repositoryRoot: parseArguments(process.argv.slice(2)),
    });
  } catch (error) {
    result = {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
  if (result.ok) {
    process.stdout.write(
      `workspace-boundaries: valid (${result.workspaceCount} workspaces)\n`,
    );
  } else {
    for (const error of result.errors)
      process.stderr.write(`workspace-boundaries: ${error}\n`);
  }
  process.exitCode = result.ok ? 0 : 1;
}
