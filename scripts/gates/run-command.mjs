#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { writeSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { clearTimeout, setTimeout } from "node:timers";

import { securePublish } from "./secure-publish.mjs";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const INHERITED_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "CI",
  "NO_COLOR",
  "FORCE_COLOR",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
];
const SENSITIVE_ENV_NAME =
  /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE)/iu;

export const expectedCommandArgv = (command, args = []) => [
  command,
  ...args.map(
    (arg) => `<arg-sha256:${createHash("sha256").update(arg).digest("hex")}>`,
  ),
];

const HASH = /^[a-f0-9]{64}$/u;
const RESULT_STATUSES = new Set([
  "passed",
  "failed",
  "timeout",
  "aborted",
  "spawn_error",
  "signaled",
]);
const RESULT_KEYS = new Set([
  "id",
  "argv",
  "status",
  "exitCode",
  "signal",
  "durationMs",
  "stdout",
  "stderr",
  "error",
]);

const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const validStreamResult = (stream) =>
  stream !== null &&
  typeof stream === "object" &&
  !Array.isArray(stream) &&
  Object.keys(stream).sort().join(",") ===
    "bytes,capturedBytes,sha256,truncated" &&
  Number.isSafeInteger(stream.bytes) &&
  stream.bytes >= 0 &&
  Number.isSafeInteger(stream.capturedBytes) &&
  stream.capturedBytes >= 0 &&
  stream.capturedBytes <= stream.bytes &&
  typeof stream.truncated === "boolean" &&
  stream.truncated === (stream.bytes > stream.capturedBytes) &&
  HASH.test(stream.sha256);

const validRunnerResult = (result, command) => {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  if (
    Object.keys(result).length !== RESULT_KEYS.size ||
    Object.keys(result).some((key) => !RESULT_KEYS.has(key))
  )
    return false;
  if (result.id !== command.id) return false;
  const rawArgv = [command.command, ...(command.args ?? [])];
  if (
    !sameJson(result.argv, expectedCommandArgv(command.command, command.args ?? [])) &&
    !sameJson(result.argv, rawArgv)
  )
    return false;
  if (!RESULT_STATUSES.has(result.status)) return false;
  if (!Number.isSafeInteger(result.durationMs) || result.durationMs < 0) return false;
  if (!(result.exitCode === null || Number.isSafeInteger(result.exitCode))) return false;
  if (!(result.signal === null || typeof result.signal === "string")) return false;
  if (!validStreamResult(result.stdout) || !validStreamResult(result.stderr)) return false;
  if (!(result.error === null || (typeof result.error === "object" && !Array.isArray(result.error))))
    return false;
  if (result.status === "passed" && (result.exitCode !== 0 || result.signal !== null))
    return false;
  return true;
};

const stableError = (error) => {
  if (error instanceof Error) {
    return {
      name: error.name,
      code: error.code ?? null,
      message: error.message,
    };
  }
  return { name: "Error", code: null, message: String(error) };
};

const emptyStreamResult = () => ({
  bytes: 0,
  capturedBytes: 0,
  truncated: false,
  sha256: EMPTY_SHA256,
});

const validateCommand = ({ id, command, args, timeoutMs, maxOutputBytes }) => {
  if (typeof id !== "string" || id.length === 0)
    throw new TypeError("command id must be non-empty");
  if (typeof command !== "string" || command.length === 0)
    throw new TypeError("command executable must be non-empty");
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    throw new TypeError("command args must be an array of strings");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new TypeError("timeoutMs must be a positive integer");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0) {
    throw new TypeError("maxOutputBytes must be a non-negative integer");
  }
};

export const createSafeCommandEnvironment = (additionalEnv = {}) => {
  if (
    additionalEnv === null ||
    typeof additionalEnv !== "object" ||
    Array.isArray(additionalEnv)
  ) {
    throw new TypeError("additionalEnv must be an object");
  }
  const environment = Object.fromEntries(
    INHERITED_ENV_ALLOWLIST.flatMap((name) =>
      typeof process.env[name] === "string" ? [[name, process.env[name]]] : [],
    ),
  );
  for (const [name, value] of Object.entries(additionalEnv)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
      SENSITIVE_ENV_NAME.test(name)
    ) {
      throw new TypeError(`unsafe environment variable name: ${name}`);
    }
    if (typeof value !== "string") {
      throw new TypeError(`environment variable ${name} must be a string`);
    }
    environment[name] = value;
  }
  return environment;
};

const createStreamCollector = (limit) => {
  const hash = createHash("sha256");
  let bytes = 0;
  let capturedBytes = 0;
  return {
    write(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      hash.update(buffer);
      capturedBytes += Math.min(
        buffer.length,
        Math.max(0, limit - capturedBytes),
      );
    },
    finish() {
      return {
        bytes,
        capturedBytes,
        truncated: bytes > capturedBytes,
        sha256: hash.digest("hex"),
      };
    },
  };
};

export const runCommand = async ({
  id,
  command,
  args = [],
  cwd = process.cwd(),
  additionalEnv = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  signal,
  spawnImplementation = spawn,
}) => {
  validateCommand({ id, command, args, timeoutMs, maxOutputBytes });
  const environment = createSafeCommandEnvironment(additionalEnv);
  const argv = expectedCommandArgv(command, args);
  if (signal?.aborted) {
    return Promise.resolve({
      id,
      argv,
      status: "aborted",
      exitCode: null,
      signal: null,
      durationMs: 0,
      stdout: emptyStreamResult(),
      stderr: emptyStreamResult(),
      error: {
        name: "AbortError",
        code: "ABORT_ERR",
        message: "command aborted before spawn",
      },
    });
  }

  return new Promise((resolveResult) => {
    const startedAt = performance.now();
    const stdout = createStreamCollector(maxOutputBytes);
    const stderr = createStreamCollector(maxOutputBytes);
    let timedOut = false;
    let aborted = false;
    let spawnError = null;
    let settled = false;
    let escalationTimer;

    const child = spawnImplementation(command, args, {
      cwd,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const killOwnedProcessGroup = (signalName) => {
        if (process.platform !== "win32" && Number.isSafeInteger(child.pid)) {
          try {
            process.kill(-child.pid, signalName);
            return;
          } catch (error) {
            if (error?.code === "ESRCH") return;
          }
        }
        child.kill(signalName);
      };
      killOwnedProcessGroup("SIGTERM");
      escalationTimer = setTimeout(() => {
        killOwnedProcessGroup("SIGKILL");
      }, 500);
      escalationTimer.unref?.();
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk) => stdout.write(chunk));
    child.stderr?.on("data", (chunk) => stderr.write(chunk));
    child.once("error", (error) => {
      spawnError = stableError(error);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timeout.unref?.();

    child.once("close", (exitCode, childSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (!timedOut && !aborted) clearTimeout(escalationTimer);
      signal?.removeEventListener("abort", onAbort);
      const status = aborted
        ? "aborted"
        : timedOut
          ? "timeout"
          : spawnError
            ? "spawn_error"
            : childSignal
              ? "signaled"
              : exitCode === 0
                ? "passed"
                : "failed";
      resolveResult({
        id,
        argv,
        status,
        exitCode,
        signal: childSignal,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        stdout: stdout.finish(),
        stderr: stderr.finish(),
        error: spawnError,
      });
    });
  });
};

export const executeGateCommands = async (
  commands,
  { runner = runCommand, signal } = {},
) => {
  if (!Array.isArray(commands))
    throw new TypeError("commands must be an array");
  const seen = new Set();
  for (const item of commands) {
    validateCommand({
      id: item?.id,
      command: item?.command,
      args: item?.args ?? [],
      timeoutMs: item?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: item?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    });
    if (seen.has(item.id)) throw new TypeError(`duplicate command id: ${item.id}`);
    seen.add(item.id);
  }
  const results = [];
  for (const command of commands) {
    let result;
    try {
      result = await runner({ ...command, signal: command.signal ?? signal });
    } catch (error) {
      result = {
        id: command.id,
        argv: expectedCommandArgv(command.command, command.args ?? []),
        status: "runner_error",
        exitCode: null,
        signal: null,
        durationMs: 0,
        stdout: emptyStreamResult(),
        stderr: emptyStreamResult(),
        error: stableError(error),
      };
    }
    if (!validRunnerResult(result, command)) {
      result = {
        id: command.id,
        argv: expectedCommandArgv(command.command, command.args ?? []),
        status: "runner_error",
        exitCode: null,
        signal: null,
        durationMs: 0,
        stdout: emptyStreamResult(),
        stderr: emptyStreamResult(),
        error: {
          name: "RunnerContractError",
          code: "INVALID_RUNNER_RESULT",
          message: `runner returned an invalid result for ${command.id}`,
        },
      };
    } else {
      result = {
        ...result,
        id: command.id,
        argv: expectedCommandArgv(command.command, command.args ?? []),
      };
    }
    results.push(result);
    if (result.status !== "passed") return { ok: false, results };
  }
  return { ok: true, results };
};

const within = (root, candidate) => {
  const relation = relative(root, candidate);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`));
};

export const writeAllSync = (
  descriptor,
  bytes,
  writer = writeSync,
) => {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let offset = 0;
  while (offset < buffer.length) {
    const written = writer(
      descriptor,
      buffer,
      offset,
      buffer.length - offset,
    );
    if (!Number.isSafeInteger(written) || written <= 0)
      throw new Error("descriptor write made no progress");
    offset += written;
  }
};

export const writeAtomicGateReport = (
  reportPath,
  report,
  { allowedRoot, helperAuthority, failureInjector = () => {} } = {},
) => {
  if (!isAbsolute(reportPath)) throw new Error("gate report path must be absolute");
  if (!allowedRoot) throw new Error("gate report publication requires allowedRoot");
  const root = resolve(allowedRoot);
  const target = resolve(reportPath);
  if (!within(root, target))
    throw new Error(`unsafe report path outside allowed root: ${target}`);
  failureInjector("before-descriptor-publish");
  securePublish({
    operation: "write_file_atomic",
    root,
    path: relative(root, target).split(sep).join("/"),
    contentBase64: Buffer.from(`${JSON.stringify(report, null, 2)}\n`).toString(
      "base64",
    ),
    authority: helperAuthority,
  });
};
