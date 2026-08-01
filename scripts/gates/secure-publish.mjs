#!/usr/bin/env node

import { spawnSync } from "node:child_process";
const HELPER_PATH = "scripts/gates/secure-publish.py";
const environment = () =>
  Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"].flatMap(
      (name) =>
        typeof process.env[name] === "string" ? [[name, process.env[name]]] : [],
    ),
  );

export const securePublish = (request) => {
  if (process.platform === "win32") {
    throw new Error(
      "descriptor-relative release publication is unsupported on this platform",
    );
  }
  const authority = request?.authority;
  if (
    !authority ||
    typeof authority.repositoryRoot !== "string" ||
    !/^[a-f0-9]{40,64}$/u.test(authority.treeSha ?? "")
  ) {
    throw new Error("descriptor publication requires a bound Git tree helper");
  }
  const helper = spawnSync(
    "git",
    ["cat-file", "blob", `${authority.treeSha}:${HELPER_PATH}`],
    {
      cwd: authority.repositoryRoot,
      encoding: "buffer",
      env: environment(),
      shell: false,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 30_000,
    },
  );
  if (helper.status !== 0 || helper.error !== undefined) {
    throw new Error("cannot load secure publication helper from bound Git tree");
  }
  const pythonRequest = { ...request };
  delete pythonRequest.authority;
  const execution = spawnSync(
    "python3",
    ["-I", "-B", "-c", helper.stdout.toString("utf8")],
    {
      input: JSON.stringify(pythonRequest),
      encoding: "utf8",
      env: environment(),
      shell: false,
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
};
