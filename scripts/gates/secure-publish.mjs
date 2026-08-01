#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";

import { spawnTrustedGitSync } from "./trusted-git.mjs";

const HELPER_PATH = "scripts/gates/secure-publish.py";
const TOOL_CANDIDATES = Object.freeze({
  python3: [
    "/usr/bin/python3",
    "/usr/local/bin/python3",
    "/opt/homebrew/bin/python3",
  ],
});

const trustedExecutable = (name) => {
  for (const candidate of TOOL_CANDIDATES[name] ?? []) {
    try {
      const resolved = realpathSync(candidate);
      accessSync(resolved, constants.X_OK);
      if (statSync(resolved).isFile()) return resolved;
    } catch {
      // Continue through the fixed, non-PATH candidate list.
    }
  }
  throw new Error(`trusted absolute ${name} executable is unavailable`);
};

const environment = () =>
  Object.fromEntries(
    ["HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"].flatMap((name) =>
      typeof process.env[name] === "string" ? [[name, process.env[name]]] : [],
    ),
  );

const sameIdentity = (left, right) =>
  left.dev === right.dev && left.ino === right.ino;

const openAuthorityRoot = (repositoryRoot) => {
  const descriptor = openSync(
    repositoryRoot,
    constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(descriptor);
    const named = lstatSync(repositoryRoot);
    if (
      !opened.isDirectory() ||
      named.isSymbolicLink() ||
      !sameIdentity(opened, named)
    )
      throw new Error("authority repository root changed while opening");
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
};

const assertPlainRequest = (request) => {
  if (
    request === null ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(request))
  )
    throw new TypeError("secure publication request must be a plain object");
  if (Object.hasOwn(request, "root"))
    throw new Error("caller publication root is forbidden; authority repository is required");
};

export const securePublish = (request) => {
  if (process.platform === "win32")
    throw new Error(
      "descriptor-relative release publication is unsupported on this platform",
    );
  assertPlainRequest(request);
  const authority = request.authority;
  if (
    !authority ||
    Object.getPrototypeOf(authority) !== Object.prototype ||
    Object.keys(authority).sort().join(",") !== "repositoryRoot,treeSha" ||
    typeof authority.repositoryRoot !== "string" ||
    !/^[a-f0-9]{40,64}$/u.test(authority.treeSha ?? "")
  )
    throw new Error("descriptor publication requires a bound Git tree helper");

  const python3 = trustedExecutable("python3");
  const repositoryRoot = realpathSync(authority.repositoryRoot);
  const rootDescriptor = openAuthorityRoot(repositoryRoot);
  try {
    const head = spawnTrustedGitSync(["rev-parse", "HEAD^{tree}"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    });
    if (
      head.status !== 0 ||
      head.error !== undefined ||
      head.stdout.trim() !== authority.treeSha
    )
      throw new Error("supplied authority tree does not match trusted Git HEAD tree");

    const helper = spawnTrustedGitSync(
      ["cat-file", "blob", `${authority.treeSha}:${HELPER_PATH}`],
      {
        cwd: repositoryRoot,
        encoding: "buffer",
        maxBuffer: 2 * 1024 * 1024,
        timeout: 30_000,
      },
    );
    if (helper.status !== 0 || helper.error !== undefined)
      throw new Error("cannot load secure publication helper from bound Git tree");

    const namedAfterLoad = lstatSync(repositoryRoot);
    if (
      namedAfterLoad.isSymbolicLink() ||
      !sameIdentity(fstatSync(rootDescriptor), namedAfterLoad)
    )
      throw new Error("authority repository root changed while loading helper");

    if (Object.hasOwn(request, "testAfterAuthorityOpen")) {
      const testHooksAllowed =
        process.env.PHASE2_SECURE_PUBLISH_TESTING === "1" ||
        process.env.NODE_ENV === "test";
      if (
        !testHooksAllowed ||
        typeof request.testAfterAuthorityOpen !== "function"
      )
        throw new Error("authority-open test hook is forbidden");
      request.testAfterAuthorityOpen();
    }

    const pythonRequest = { ...request, rootFd: 3 };
    delete pythonRequest.authority;
    delete pythonRequest.testAfterAuthorityOpen;
    const execution = spawnSync(
      python3,
      ["-I", "-B", "-c", helper.stdout.toString("utf8")],
      {
        input: JSON.stringify(pythonRequest),
        encoding: "utf8",
        env: {
          ...environment(),
          ...(process.env.PHASE2_SECURE_PUBLISH_TESTING === "1"
            ? { PHASE2_SECURE_PUBLISH_TESTING: "1" }
            : {}),
        },
        shell: false,
        stdio: ["pipe", "pipe", "pipe", rootDescriptor],
        maxBuffer: 16 * 1024 * 1024,
        timeout: 120_000,
      },
    );
    let result;
    try {
      result = JSON.parse(execution.stdout || "null");
    } catch {
      result = null;
    }
    if (
      execution.status !== 0 ||
      result?.ok !== true ||
      execution.error !== undefined
    ) {
      const detail =
        result?.error ??
        execution.error?.message ??
        execution.stderr?.trim() ??
        `exit ${String(execution.status)}`;
      throw new Error(`descriptor-relative publication failed: ${detail}`);
    }
    return result;
  } finally {
    closeSync(rootDescriptor);
  }
};
