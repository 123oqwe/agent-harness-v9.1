#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createSafeCommandEnvironment } from "./run-command.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REQUIRED_EXPORTS = [
  "ScriptedTestProvider",
  "ModelGateway",
  "PolicyEngine",
  "PolicyEnforcementPoint",
  "AuthorizationService",
  "VirtualFilesystem",
  "execSandboxed",
  "ToolRegistry",
  "SkillRegistry",
  "DurableSession",
  "LoopEngine",
  "SecretsBroker",
  "SecretsBrokerApi",
];

export const runPackageSmoke = async ({ repositoryRoot = root } = {}) => {
  const packageJson = JSON.parse(
    readFileSync(join(repositoryRoot, "package.json"), "utf8"),
  );
  const temporaryRoot = mkdtempSync(
    join(repositoryRoot, ".phase2-package-smoke-"),
  );
  const extracted = join(temporaryRoot, "extracted");
  mkdirSync(extracted);
  const errors = [];
  let entry = "";
  let tarballSha256 = null;
  let exported = [];
  try {
    const packed = spawnSync(
      "npm",
      [
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        temporaryRoot,
      ],
      {
        cwd: repositoryRoot,
        env: createSafeCommandEnvironment(),
        shell: false,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 120_000,
      },
    );
    if (packed.status !== 0)
      throw new Error(`npm pack failed with exit ${String(packed.status)}`);
    const packResult = JSON.parse(packed.stdout);
    const tarball = join(temporaryRoot, basename(packResult[0].filename));
    tarballSha256 = createHash("sha256")
      .update(readFileSync(tarball))
      .digest("hex");
    const unpacked = spawnSync("tar", ["-xzf", tarball, "-C", extracted], {
      shell: false,
      env: createSafeCommandEnvironment(),
      encoding: "utf8",
      timeout: 120_000,
    });
    if (unpacked.status !== 0)
      throw new Error(
        `tar extraction failed with exit ${String(unpacked.status)}`,
      );
    entry = resolve(extracted, "package", packageJson.main ?? "dist/index.js");
    if (!existsSync(entry))
      throw new Error(`packed package entry is missing: ${entry}`);
    try {
      const module = await import(
        `${pathToFileURL(entry).href}?smoke=${Date.now()}`
      );
      exported = Object.keys(module);
      for (const name of REQUIRED_EXPORTS) {
        if (!(name in module))
          errors.push(`public package export is missing: ${name}`);
      }
    } catch (error) {
      errors.push(
        `cannot import built package: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
  return {
    errors,
    entry,
    exported,
    tarballSha256,
    installed: false,
    releaseReady: errors.length === 0,
  };
};

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const result = await runPackageSmoke();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.errors.length === 0 ? 0 : 1;
}
