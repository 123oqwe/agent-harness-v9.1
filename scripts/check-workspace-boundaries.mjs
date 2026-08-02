#!/usr/bin/env node

// Source-admission defense against accidental authority bypasses for the
// explicitly supported static syntax. It does not prove arbitrary dynamic
// JavaScript, function-returned authorities, or runtime obfuscation safe.
// Gateway, SecretsBroker, Policy/PEP, VFS, Sandbox, and Receipts remain the
// runtime authorities. Recognized global indirection fails closed here.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPOSITORY_ROOT = resolve(scriptDirectory, "..");
export const ROOT_INDEX_SHA256 =
  "33522c4beab56984c2c2f26edc24ffb7328c7ec632148a4319f4275fb4bdffe6";

const workspace = (
  path,
  name,
  dependencies,
  role,
  safeBuiltins = [],
  transportGlobals = [],
) =>
  Object.freeze({
    path,
    name,
    dependencies: Object.freeze(dependencies),
    role,
    safeBuiltins: Object.freeze(safeBuiltins),
    transportGlobals: Object.freeze(transportGlobals),
  });

export const EXPECTED_WORKSPACES = Object.freeze([
  workspace("packages/contracts", "@agent-harness/contracts", [], "package"),
  workspace(
    "packages/runtime-core",
    "@agent-harness/runtime-core",
    ["@agent-harness/contracts"],
    "package",
    ["node:async_hooks", "node:crypto"],
  ),
  workspace(
    "packages/router",
    "@agent-harness/router",
    ["@agent-harness/contracts", "@agent-harness/runtime-core"],
    "package",
  ),
  workspace(
    "packages/security",
    "@agent-harness/security",
    ["@agent-harness/contracts"],
    "package",
  ),
  workspace(
    "packages/tools",
    "@agent-harness/tools",
    ["@agent-harness/runtime-core", "@agent-harness/security"],
    "package",
    ["node:crypto"],
  ),
  workspace(
    "packages/ui",
    "@agent-harness/ui",
    ["@agent-harness/api"],
    "package",
  ),
  workspace(
    "packages/api",
    "@agent-harness/api",
    [
      "@agent-harness/runtime-core",
      "@agent-harness/router",
      "@agent-harness/security",
      "@agent-harness/tools",
      "@agent-harness/documents",
      "@agent-harness/rag",
      "@agent-harness/multimodal",
    ],
    "package",
    ["node:crypto"],
    ["fetch"],
  ),
  workspace(
    "packages/eval",
    "@agent-harness/eval",
    ["@agent-harness/api"],
    "package",
  ),
  workspace(
    "packages/documents",
    "@agent-harness/documents",
    ["@agent-harness/contracts"],
    "package",
    ["node:buffer", "node:crypto"],
  ),
  workspace(
    "packages/rag",
    "@agent-harness/rag",
    ["@agent-harness/documents"],
    "package",
    ["node:crypto"],
  ),
  workspace(
    "packages/multimodal",
    "@agent-harness/multimodal",
    ["@agent-harness/documents"],
    "package",
    ["node:buffer", "node:crypto"],
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
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const PHASE1_AUTHORITY_WORKSPACES = new Set([
  "packages/runtime-core",
  "packages/router",
  "packages/security",
  "packages/tools",
]);
const PHASE2_AUTHORITY_PATH = "verification/gates/phase2-gate.json";
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
const NODE_BUILTINS = new Set(
  builtinModules.flatMap((name) => {
    const normalized = name.replace(/^node:/u, "");
    return [normalized, `node:${normalized}`];
  }),
);
const URL_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/u;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/u;
const GLOBAL_NETWORK_IDENTIFIERS = new Set([
  "EventSource",
  "WebSocket",
  "XMLHttpRequest",
]);
const GLOBAL_OBJECTS = new Set(["global", "globalThis", "self", "window"]);

const barePackageName = (specifier) => {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return scope && name ? `${scope}/${name}` : specifier;
  }
  return specifier.split("/")[0];
};

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

const safeRepositoryPath = (path) =>
  typeof path === "string" &&
  path.length > 0 &&
  !isAbsolute(path) &&
  !path.split(/[\\/]/u).includes("..") &&
  path.split(/[\\/]/u).every(Boolean);

const staticModuleTarget = (file, specifier) => {
  if (typeof specifier !== "string" || !specifier.startsWith(".")) return null;
  const base = resolve(dirname(file), specifier);
  const candidates = specifier.endsWith(".js")
    ? [base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx", base]
    : [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
};

const exportedDeclarationNames = (sourceFile) => {
  const names = new Set();
  for (const statement of sourceFile.statements) {
    const exported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!exported) continue;
    for (const name of declarationNames(statement)) names.add(name);
  }
  return names;
};

const readAuthorityBindings = (root, errors) => {
  const manifest = readJson(
    join(root, PHASE2_AUTHORITY_PATH),
    errors,
    PHASE2_AUTHORITY_PATH,
  );
  const byWorkspace = new Map(
    [...PHASE1_AUTHORITY_WORKSPACES].map((path) => [path, new Map()]),
  );
  const activeExportsByPath = new Map();
  const canonicalAuthorityNames = new Set();
  const requirements = new Map(
    Array.isArray(manifest?.requirements)
      ? manifest.requirements.map((requirement) => [requirement.id, requirement])
      : [],
  );
  for (const requirement of requirements.values()) {
    const hasSources = Object.hasOwn(requirement, "source_files");
    const hasTests = Object.hasOwn(requirement, "test_files");
    if (!hasSources && !hasTests) continue;
    const label = `requirement ${String(requirement.id)}`;
    if (!hasSources || !hasTests) {
      errors.push(`${label} must bind source_files and test_files together`);
      continue;
    }
    if (
      !Array.isArray(requirement.source_files) ||
      requirement.source_files.length === 0 ||
      !Array.isArray(requirement.test_files) ||
      requirement.test_files.length === 0
    ) {
      errors.push(`${label} source_files and test_files must be non-empty arrays`);
      continue;
    }
    if (
      stable(requirement.test_files) !== stable(requirement.test_suites)
    ) {
      errors.push(`${label} test_files must exactly match test_suites`);
    }
    if (!PHASE1_AUTHORITY_WORKSPACES.has(requirement.owner)) continue;
    const workspaceBindings = byWorkspace.get(requirement.owner);
    for (const path of requirement.source_files) {
      if (
        !safeRepositoryPath(path) ||
        !path.startsWith(`${requirement.owner}/src/`) ||
        !SOURCE_EXTENSIONS.has(extname(path))
      ) {
        errors.push(`${label} source file is outside owner: ${String(path)}`);
        continue;
      }
      const existing = workspaceBindings.get(path);
      if (existing) {
        errors.push(
          `${path} is bound to multiple requirements: ${existing.id}, ${requirement.id}`,
        );
      } else workspaceBindings.set(path, requirement);
      try {
        const stats = lstatSync(join(root, path));
        if (!stats.isFile() || stats.isSymbolicLink()) {
          errors.push(`${label} source file must be a regular non-symlink: ${path}`);
        }
      } catch {
        errors.push(`${label} source file is missing: ${path}`);
      }
    }
    for (const path of requirement.test_files) {
      if (!safeRepositoryPath(path) || !path.startsWith("tests/phase-2/")) {
        errors.push(`${label} test file is outside Phase 2 tests: ${String(path)}`);
      }
      try {
        const stats = lstatSync(join(root, path));
        if (!stats.isFile() || stats.isSymbolicLink()) {
          errors.push(`${label} test file must be a regular non-symlink: ${path}`);
        }
      } catch {
        errors.push(`${label} test file is missing: ${path}`);
      }
    }
  }
  for (const authority of Array.isArray(manifest?.source_authorities)
    ? manifest.source_authorities
    : []) {
    for (const name of authority?.root?.exports ?? []) {
      if (typeof name === "string" && name.length > 0)
        canonicalAuthorityNames.add(name);
    }
    if (authority?.workspace?.state !== "active") continue;
    const requirement = requirements.get(authority.migration_requirement);
    const label = `source authority ${String(authority.id)}`;
    if (!requirement) {
      errors.push(`${label} active migration has no structured requirement binding`);
      continue;
    }
    if (requirement.owner !== authority.workspace.owner) {
      errors.push(`${label} migration owner does not match requirement owner`);
    }
    if (stable(authority.workspace.paths) !== stable(requirement.source_files)) {
      errors.push(`${label} migration paths must exactly match source_files`);
    }
    if (stable(authority.workspace.tests) !== stable(requirement.test_files)) {
      errors.push(`${label} migration tests must exactly match test_files`);
    }
    for (const path of authority.workspace.paths ?? []) {
      const names = activeExportsByPath.get(path) ?? new Set();
      for (const name of authority.workspace.exports ?? []) names.add(name);
      activeExportsByPath.set(path, names);
    }
  }
  return { byWorkspace, activeExportsByPath, canonicalAuthorityNames };
};

const identityStatement = (statement, expected) => {
  if (
    !ts.isVariableStatement(statement) ||
    !statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) ||
    (statement.declarationList.flags & ts.NodeFlags.Const) === 0 ||
    statement.declarationList.declarations.length !== 1
  ) {
    return false;
  }
  const declaration = statement.declarationList.declarations[0];
  if (
    !ts.isIdentifier(declaration.name) ||
    declaration.name.text !== "workspaceIdentity" ||
    !declaration.initializer
  ) {
    return false;
  }
  const initializer = unwrapExpression(declaration.initializer);
  if (
    !ts.isCallExpression(initializer) ||
    !ts.isPropertyAccessExpression(initializer.expression) ||
    !ts.isIdentifier(initializer.expression.expression) ||
    initializer.expression.expression.text !== "Object" ||
    initializer.expression.name.text !== "freeze" ||
    initializer.arguments.length !== 1
  ) {
    return false;
  }
  const object = unwrapExpression(initializer.arguments[0]);
  if (!object || !ts.isObjectLiteralExpression(object)) return false;
  const values = new Map();
  for (const property of object.properties) {
    if (
      !ts.isPropertyAssignment(property) ||
      (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))
    ) {
      return false;
    }
    const value = unwrapExpression(property.initializer);
    if (!value || !ts.isStringLiteral(value)) return false;
    values.set(property.name.text, value.text);
  }
  return (
    values.size === 2 &&
    values.get("name") === expected.name &&
    values.get("path") === expected.path
  );
};

const portStatement = (statement, expected) => {
  const expectedName = `${expected.name
    .replace("@agent-harness/", "")
    .split("-")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join("")}PackagePort`;
  if (
    !ts.isInterfaceDeclaration(statement) ||
    statement.name.text !== expectedName ||
    !statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) ||
    statement.typeParameters ||
    statement.heritageClauses ||
    statement.members.length !== 1
  ) {
    return false;
  }
  const member = statement.members[0];
  return (
    ts.isPropertySignature(member) &&
    member.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
    ) === true &&
    ts.isIdentifier(member.name) &&
    member.name.text === "workspace" &&
    member.questionToken === undefined &&
    member.type !== undefined &&
    ts.isTypeQueryNode(member.type) &&
    ts.isQualifiedName(member.type.exprName) &&
    ts.isIdentifier(member.type.exprName.left) &&
    member.type.exprName.left.text === "workspaceIdentity" &&
    member.type.exprName.right.text === "name"
  );
};

const validateAuthorityWorkspaceSource = ({
  root,
  file,
  sourceFile,
  expected,
  bindings,
}) => {
  if (!PHASE1_AUTHORITY_WORKSPACES.has(expected.path)) return [];
  const errors = [];
  const relativePath = relative(root, file).replaceAll("\\", "/");
  const indexPath = `${expected.path}/src/index.ts`;
  if (relativePath !== indexPath) {
    if (!bindings.has(relativePath)) {
      errors.push(
        "Phase 1 authority workspace must remain an identity-only scaffold; extra source lacks structured requirement binding",
      );
    }
    return errors;
  }

  let identityCount = 0;
  let portCount = 0;
  for (const statement of sourceFile.statements) {
    if (identityStatement(statement, expected)) {
      identityCount += 1;
      continue;
    }
    if (
      portStatement(statement, expected)
    ) {
      portCount += 1;
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      const target = staticModuleTarget(file, statement.moduleSpecifier.text);
      const targetPath = target
        ? relative(root, target).replaceAll("\\", "/")
        : null;
      const requirement = targetPath ? bindings.get(targetPath) : null;
      if (!target || !requirement) {
        errors.push(
          "Phase 1 authority workspace re-export lacks structured requirement binding",
        );
        continue;
      }
      const targetFile = ts.createSourceFile(
        target,
        readFileSync(target, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        extname(target) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const targetExports = exportedDeclarationNames(targetFile);
      for (const element of statement.exportClause.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        if (!targetExports.has(importedName)) {
          errors.push(
            `${relativePath}: re-export ${element.name.text} is not a real export of ${targetPath}`,
          );
        }
      }
      continue;
    }
    errors.push(
      "Phase 1 authority workspace must remain an identity-only scaffold unless an export has a structured requirement binding",
    );
  }
  if (identityCount !== 1 || portCount !== 1) {
    errors.push(
      "Phase 1 authority workspace index must contain exactly one frozen identity and PackagePort declaration",
    );
  }
  return errors;
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

const authorityImplementationNames = (node) => {
  if (
    (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) &&
    node.name
  ) {
    return [node.name.text];
  }
  if (!ts.isVariableStatement(node)) return [];
  return node.declarationList.declarations.flatMap((declaration) => {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return [];
    const initializer = unwrapExpression(declaration.initializer);
    return initializer &&
      (ts.isClassExpression(initializer) ||
        ts.isFunctionExpression(initializer) ||
        ts.isArrowFunction(initializer))
      ? [declaration.name.text]
      : [];
  });
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
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      loaders.push("import-equals require");
      const expression = node.moduleReference.expression;
      if (expression && ts.isStringLiteral(expression))
        specifiers.push(expression.text);
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

const unwrapExpression = (node) => {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current))
  ) {
    current = current.expression;
  }
  return current;
};

const collectGlobalProcessBindings = (sourceFile) => {
  const stringConstants = new Map();
  const globalAliases = new Set(GLOBAL_OBJECTS);
  const processAliases = new Set(["process"]);
  const declarations = [];
  const isConstantDeclaration = (declaration) =>
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
  const collect = (node) => {
    if (ts.isVariableDeclaration(node)) {
      declarations.push(node);
      const initializer = unwrapExpression(node.initializer);
      if (
        isConstantDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        initializer &&
        (ts.isStringLiteral(initializer) ||
          ts.isNoSubstitutionTemplateLiteral(initializer))
      ) {
        stringConstants.set(node.name.text, initializer.text);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  let stringChanged = true;
  while (stringChanged) {
    stringChanged = false;
    for (const declaration of declarations) {
      if (
        !isConstantDeclaration(declaration) ||
        !ts.isIdentifier(declaration.name)
      ) {
        continue;
      }
      const initializer = unwrapExpression(declaration.initializer);
      if (
        !initializer ||
        !ts.isIdentifier(initializer) ||
        !stringConstants.has(initializer.text) ||
        stringConstants.has(declaration.name.text)
      ) {
        continue;
      }
      stringConstants.set(
        declaration.name.text,
        stringConstants.get(initializer.text),
      );
      stringChanged = true;
    }
  }

  const staticPropertyName = (node) => {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (!ts.isElementAccessExpression(node) || !node.argumentExpression)
      return null;
    const argument = unwrapExpression(node.argumentExpression);
    if (
      ts.isStringLiteral(argument) ||
      ts.isNoSubstitutionTemplateLiteral(argument)
    ) {
      return argument.text;
    }
    return ts.isIdentifier(argument)
      ? (stringConstants.get(argument.text) ?? null)
      : null;
  };
  const isGlobalObject = (node) => {
    const expression = unwrapExpression(node);
    return Boolean(
      expression &&
      ts.isIdentifier(expression) &&
      globalAliases.has(expression.text),
    );
  };
  const isGlobalProcess = (node) => {
    const expression = unwrapExpression(node);
    if (!expression) return false;
    if (ts.isIdentifier(expression)) return processAliases.has(expression.text);
    return (
      (ts.isPropertyAccessExpression(expression) ||
        ts.isElementAccessExpression(expression)) &&
      isGlobalObject(expression.expression) &&
      staticPropertyName(expression) === "process"
    );
  };
  const bindingPropertyName = (element) => {
    const property = element.propertyName ?? element.name;
    if (ts.isIdentifier(property) || ts.isStringLiteral(property))
      return property.text;
    if (ts.isComputedPropertyName(property)) {
      const expression = unwrapExpression(property.expression);
      if (
        ts.isStringLiteral(expression) ||
        ts.isNoSubstitutionTemplateLiteral(expression)
      ) {
        return expression.text;
      }
      if (ts.isIdentifier(expression))
        return stringConstants.get(expression.text) ?? null;
    }
    return null;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (!isConstantDeclaration(declaration)) continue;
      const initializer = unwrapExpression(declaration.initializer);
      if (!initializer) continue;
      if (ts.isIdentifier(declaration.name)) {
        if (
          isGlobalObject(initializer) &&
          !globalAliases.has(declaration.name.text)
        ) {
          globalAliases.add(declaration.name.text);
          changed = true;
        }
        if (
          isGlobalProcess(initializer) &&
          !processAliases.has(declaration.name.text)
        ) {
          processAliases.add(declaration.name.text);
          changed = true;
        }
      } else if (
        ts.isObjectBindingPattern(declaration.name) &&
        isGlobalObject(initializer)
      ) {
        for (const element of declaration.name.elements) {
          if (
            bindingPropertyName(element) === "process" &&
            ts.isIdentifier(element.name) &&
            !processAliases.has(element.name.text)
          ) {
            processAliases.add(element.name.text);
            changed = true;
          }
        }
      }
    }
  }

  const mutableAuthorityAlias = declarations.some((declaration) => {
    if (isConstantDeclaration(declaration)) return false;
    const initializer = unwrapExpression(declaration.initializer);
    return isGlobalObject(initializer) || isGlobalProcess(initializer);
  });

  return {
    globalAliases,
    processAliases,
    staticPropertyName,
    isGlobalObject,
    isGlobalProcess,
    bindingPropertyName,
    mutableAuthorityAlias,
  };
};

const sourceAuthorityViolations = (sourceFile, transportGlobals) => {
  const violations = new Set();
  const processBindings = collectGlobalProcessBindings(sourceFile);
  if (processBindings.mutableAuthorityAlias) {
    violations.add("mutable global authority alias is forbidden");
  }
  const visit = (node) => {
    if (
      ts.isIdentifier(node) &&
      processBindings.processAliases.has(node.text) &&
      !isDeclarationName(node)
    ) {
      violations.add("global process access is forbidden");
    }
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      processBindings.isGlobalProcess(node)
    ) {
      violations.add("global process access is forbidden");
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      processBindings.isGlobalObject(node.initializer) &&
      node.name.elements.some(
        (element) => processBindings.bindingPropertyName(element) === "process",
      )
    ) {
      violations.add("global process access is forbidden");
    }
    if (
      ts.isElementAccessExpression(node) &&
      processBindings.isGlobalObject(node.expression) &&
      processBindings.staticPropertyName(node) === null
    ) {
      violations.add("unresolved global property access is forbidden");
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      processBindings.isGlobalObject(node.initializer) &&
      node.name.elements.some(
        (element) =>
          element.dotDotDotToken !== undefined ||
          processBindings.bindingPropertyName(element) === null,
      )
    ) {
      violations.add("unresolved global property access is forbidden");
    }
    if (
      ts.isIdentifier(node) &&
      node.text === "fetch" &&
      !isDeclarationName(node) &&
      !transportGlobals.has("fetch")
    ) {
      violations.add("direct global fetch access is forbidden");
    }
    if (
      ts.isIdentifier(node) &&
      GLOBAL_NETWORK_IDENTIFIERS.has(node.text) &&
      !isDeclarationName(node) &&
      !transportGlobals.has(node.text)
    ) {
      violations.add(
        `direct global network access via ${node.text} is forbidden`,
      );
    }
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      processBindings.isGlobalObject(node.expression) &&
      (processBindings.staticPropertyName(node) === "fetch" ||
        GLOBAL_NETWORK_IDENTIFIERS.has(
          processBindings.staticPropertyName(node),
        ))
    ) {
      const name = processBindings.staticPropertyName(node);
      if (!transportGlobals.has(name))
        violations.add(
          name === "fetch"
            ? "direct global fetch access is forbidden"
            : `direct global network access via ${name} is forbidden`,
        );
    }
    if (
      (ts.isPropertyAccessExpression(node) &&
        node.expression.getText() === "process" &&
        node.name.text === "getBuiltinModule") ||
      (ts.isElementAccessExpression(node) &&
        node.expression.getText() === "process" &&
        elementAccessName(node) === "getBuiltinModule")
    ) {
      violations.add("direct process.getBuiltinModule access is forbidden");
    }
    if (
      (ts.isPropertyAccessExpression(node) &&
        node.expression.getText() === "navigator" &&
        node.name.text === "sendBeacon") ||
      (ts.isElementAccessExpression(node) &&
        node.expression.getText() === "navigator" &&
        elementAccessName(node) === "sendBeacon")
    ) {
      if (!transportGlobals.has("navigator.sendBeacon"))
        violations.add(
          "direct global network access via navigator.sendBeacon is forbidden",
        );
    }
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      GLOBAL_OBJECTS.has(node.expression.getText())
    ) {
      const name = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : elementAccessName(node);
      const parent = node.parent;
      if (
        name === "navigator" &&
        ((ts.isPropertyAccessExpression(parent) &&
          parent.expression === node &&
          parent.name.text === "sendBeacon") ||
          (ts.isElementAccessExpression(parent) &&
            parent.expression === node &&
            elementAccessName(parent) === "sendBeacon"))
      ) {
        if (!transportGlobals.has("navigator.sendBeacon"))
          violations.add(
            "direct global network access via navigator.sendBeacon is forbidden",
          );
      }
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
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer?.getText() === "process" &&
      node.name.elements.some(
        (element) =>
          (element.propertyName ?? element.name)
            .getText()
            .replace(/["']/gu, "") === "getBuiltinModule",
      )
    ) {
      violations.add("direct process.getBuiltinModule access is forbidden");
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
  for (const pattern of [
    "packages/*/src/**/*.{ts,tsx}",
    "apps/*/src/**/*.{ts,tsx}",
  ]) {
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
  const authorityBindings = readAuthorityBindings(root, errors);
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
  const manifestsByPath = new Map();
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
    manifestsByPath.set(expected.path, manifest);
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

    const dependencySections = new Map();
    for (const section of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      const dependencies = isRecord(manifest[section]) ? manifest[section] : {};
      dependencySections.set(section, dependencies);
      for (const [name, version] of Object.entries(dependencies)) {
        if (!expectedByName.has(name)) continue;
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
        if (section !== "dependencies")
          errors.push(
            `${expected.path} workspace dependency ${name} must be declared in dependencies`,
          );
      }
    }
    const productionDependencies = dependencySections.get("dependencies");
    const uniqueDependencies = Object.keys(productionDependencies)
      .filter((name) => expectedByName.has(name))
      .sort();
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
    const manifest = manifestsByPath.get(expected.path) ?? {};
    const productionDependencies = new Set(
      ["dependencies", "peerDependencies", "optionalDependencies"].flatMap(
        (section) =>
          Object.keys(isRecord(manifest[section]) ? manifest[section] : {}),
      ),
    );
    const developmentDependencies = new Set(
      Object.keys(
        isRecord(manifest.devDependencies) ? manifest.devDependencies : {},
      ),
    );
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
        new Set([".tsx", ".jsx"]).has(extname(file))
          ? ts.ScriptKind.TSX
          : ts.ScriptKind.TS,
      );
      const label = relative(root, file).replaceAll("\\", "/");
      if (sourceFile.parseDiagnostics.length > 0) {
        errors.push(`${label}: unsupported or malformed source syntax`);
        continue;
      }
      for (const violation of validateAuthorityWorkspaceSource({
        root,
        sourceFile,
        file,
        expected,
        bindings: authorityBindings.byWorkspace.get(expected.path) ?? new Map(),
      })) {
        errors.push(`${label}: identity-only scaffold violation: ${violation}`);
      }
      const accesses = moduleAccesses(sourceFile);
      for (const loader of new Set(accesses.loaders)) {
        errors.push(`${label}: direct module loader ${loader} is forbidden`);
      }
      for (const specifier of accesses.specifiers) {
        for (const [category, forbidden] of FORBIDDEN_IMPORTS) {
          const hookJournalFilesystem =
            label === "packages/runtime-core/src/sqlite-hook-journal.ts" &&
            category === "filesystem" &&
            ["node:fs", "node:fs/promises"].includes(specifier);
          if (forbidden.has(specifier) && !hookJournalFilesystem)
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
        } else if (specifier.startsWith(".")) {
          // Relative imports were resolved and confined above.
        } else if (
          isAbsolute(specifier) ||
          WINDOWS_ABSOLUTE_PATH.test(specifier) ||
          specifier.startsWith("\\\\")
        ) {
          errors.push(`${label}: absolute import ${specifier} is forbidden`);
        } else if (specifier.startsWith("#")) {
          errors.push(
            `${label}: package import alias ${specifier} is forbidden`,
          );
        } else if (
          specifier.startsWith("node:") ||
          NODE_BUILTINS.has(specifier)
        ) {
          const hookJournalBuiltin =
            label === "packages/runtime-core/src/sqlite-hook-journal.ts" &&
            ["node:fs", "node:path"].includes(specifier);
          if (
            !NODE_BUILTINS.has(specifier) ||
            (!expected.safeBuiltins.includes(specifier) &&
              !hookJournalBuiltin)
          ) {
            errors.push(
              `${label}: builtin import ${specifier} is not approved for ${expected.path}`,
            );
          }
        } else if (URL_SCHEME.test(specifier)) {
          errors.push(
            `${label}: URL scheme import ${specifier.split(":", 1)[0]}: is forbidden`,
          );
        } else {
          const packageName = barePackageName(specifier);
          if (
            developmentDependencies.has(packageName) &&
            !productionDependencies.has(packageName)
          ) {
            errors.push(
              `${label}: production source cannot import development dependency ${packageName}`,
            );
          } else if (!productionDependencies.has(packageName)) {
            errors.push(
              `${label}: undeclared bare import ${packageName} is forbidden`,
            );
          }
        }
      }
      const visit = (node) => {
        for (const name of authorityImplementationNames(node)) {
          const migratedNames = authorityBindings.activeExportsByPath.get(label);
          if (
            authorityBindings.canonicalAuthorityNames.has(name) &&
            !migratedNames?.has(name)
          )
            errors.push(
              `${label}: duplicate authority declaration ${name} is forbidden`,
            );
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      for (const violation of sourceAuthorityViolations(
        sourceFile,
        new Set(expected.transportGlobals),
      ))
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
      const dependencyEntries = (value) =>
        Object.entries(value).sort(([left], [right]) =>
          left.localeCompare(right),
        );
      const manifest = manifestsByPath.get(expected.path) ?? {};
      for (const section of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        const declared = isRecord(manifest[section]) ? manifest[section] : {};
        const locked = isRecord(lockedWorkspace[section])
          ? lockedWorkspace[section]
          : {};
        if (
          stable(dependencyEntries(locked)) !==
          stable(dependencyEntries(declared))
        ) {
          errors.push(
            `package-lock workspace ${expected.path} ${section} do not match package.json`,
          );
        }
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
