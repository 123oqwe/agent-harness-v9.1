import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export type TrustedPythonAsset = "checkpoint" | "sqlite_preflight";

export interface TrustedPythonHostCall {
  readonly request: Readonly<Record<string, unknown>>;
  readonly requestKeys: readonly string[];
  readonly responseKeys: readonly string[];
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

interface TestOnlyPythonHostCall extends TrustedPythonHostCall {
  readonly host: URL;
  readonly hostSha256: string;
}

const DEFAULT_PYTHON = "/usr/bin/python3";
const MAX_HOST_BYTES = 1024 * 1024;
const MAX_INLINE_HOST_BYTES = 128 * 1024;
const SUPERVISOR = new URL("./trusted-python-supervisor.py", import.meta.url);
const SUPERVISOR_SHA256 = "1a94d2f57a9431842bf43dafba9cc41d8e3188df7940441c52ccaefd50b9ddb5";
const ASSETS: Readonly<Record<TrustedPythonAsset, Readonly<{ url: URL; sha256: string }>>> = {
  checkpoint: Object.freeze({
    url: new URL("./secure-checkpoint-host.py", import.meta.url),
    sha256: "d0d301625ff4e351e8c67eb276cbbe81b51b95478ae016bded3e74ba3b41adc5",
  }),
  sqlite_preflight: Object.freeze({
    url: new URL("./secure-sqlite-preflight.py", import.meta.url),
    sha256: "d0500e192787461cf323e9174fec8f94c924ae84f316c9a19574b1d28ebc08d1",
  }),
};

const productionAssetBytes = new Map<TrustedPythonAsset, Buffer>();
let cachedPython: string | undefined;
let cachedSupervisorBytes: Buffer | undefined;

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function validateJson(value: unknown, budget = { nodes: 0 }): void {
  budget.nodes += 1;
  if (budget.nodes > 100_000) throw new Error("trusted host JSON node limit exceeded");
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error("trusted host JSON integer is unsafe");
  }
  if (typeof value === "string" && Buffer.byteLength(value) > 2 * 1024 * 1024) {
    throw new Error("trusted host JSON string limit exceeded");
  }
  if (Array.isArray(value)) {
    for (const entry of value) validateJson(entry, budget);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) validateJson(entry, budget);
  }
}

function trustedOwner(uid: number): boolean {
  return uid === 0 || uid === process.getuid?.();
}

function assertSafeAncestors(path: string): void {
  let current = path;
  while (true) {
    const metadata = lstatSync(current);
    if (!trustedOwner(metadata.uid) || metadata.mode & 0o022) {
      throw new Error("trusted host ancestor metadata is unsafe");
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function trustedPython(): string {
  if (cachedPython) return cachedPython;
  const candidate = realpathSync(DEFAULT_PYTHON);
  if (!isAbsolute(candidate)) throw new Error("trusted Python must be absolute");
  assertSafeAncestors(candidate);
  const executable = lstatSync(candidate);
  if (!executable.isFile() || !trustedOwner(executable.uid) || !(executable.mode & 0o111)) {
    throw new Error("trusted Python interpreter is not executable");
  }
  cachedPython = candidate;
  return candidate;
}

function descriptorBytes(descriptor: number, size: number): Buffer {
  const content = Buffer.alloc(size);
  let offset = 0;
  while (offset < content.byteLength) {
    const count = readSync(descriptor, content, offset, content.byteLength - offset, offset);
    if (count === 0) throw new Error("trusted host file changed during read");
    offset += count;
  }
  return content;
}

function verifiedAssetBytes(url: URL, sha256: string): Buffer {
  const path = fileURLToPath(url);
  assertSafeAncestors(path);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    const named = lstatSync(path);
    if (
      !opened.isFile() ||
      !trustedOwner(opened.uid) ||
      opened.mode & 0o022 ||
      opened.nlink !== 1 ||
      opened.size > MAX_HOST_BYTES ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino
    ) {
      throw new Error("trusted host file metadata is unsafe");
    }
    const content = descriptorBytes(descriptor, opened.size);
    if (createHash("sha256").update(content).digest("hex") !== sha256) {
      throw new Error("trusted host file hash mismatch");
    }
    return Buffer.from(content);
  } finally {
    closeSync(descriptor);
  }
}

function supervisorBytes(): Buffer {
  if (!cachedSupervisorBytes) {
    cachedSupervisorBytes = verifiedAssetBytes(SUPERVISOR, SUPERVISOR_SHA256);
  }
  return cachedSupervisorBytes;
}

function launchVerifiedBytes(
  verifiedHost: Buffer,
  options: TrustedPythonHostCall,
  scanDescendants: boolean,
): Record<string, unknown> {
  if (verifiedHost.byteLength > MAX_INLINE_HOST_BYTES) {
    throw new Error("trusted host is too large for immutable-byte execution");
  }
  if (!exactKeys(options.request, options.requestKeys)) {
    throw new Error("trusted host request schema is malformed");
  }
  validateJson(options.request);
  const timeoutMs = options.timeoutMs ?? 2_000;
  const maximum = options.maxOutputBytes ?? 2 * 1024 * 1024;
  const verified_host_b64 = verifiedHost.toString("base64");
  const program = scanDescendants
    ? `import base64;exec(compile(base64.b64decode('${supervisorBytes().toString("base64")}'),'<trusted-supervisor>','exec'))`
    : `import base64;exec(compile(base64.b64decode('${verified_host_b64}'),'<trusted-host>','exec'))`;
  const input = scanDescendants
    ? {
        request: options.request,
        timeout_ms: timeoutMs,
        max_output_bytes: maximum,
        verified_host_b64,
        scan_descendants: true,
      }
    : options.request;
  const result = spawnSync(
    trustedPython(),
    [
      "-I",
      "-B",
      "-E",
      "-c",
      program,
    ],
    {
      input: JSON.stringify(input),
      encoding: "utf8",
      shell: false,
      timeout: timeoutMs + 2_000,
      killSignal: "SIGKILL",
      maxBuffer: maximum + 1,
      env: { HOME: "/var/empty", LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (result.error) {
    throw new Error(`trusted host execution failed: ${result.error.message}`);
  }
  const stdout = String(result.stdout);
  if (Buffer.byteLength(stdout) > maximum) throw new Error("trusted host output limit exceeded");
  let response: unknown;
  try {
    response = JSON.parse(stdout);
  } catch {
    if (result.status !== 0 && stdout.trim().length === 0) {
      throw new Error("trusted host execution failed: supervisor produced no response");
    }
    throw new Error("trusted host response is malformed");
  }
  validateJson(response);
  if (result.status !== 0) {
    if (!exactKeys(response, ["ok", "error"]) || response.ok !== false || typeof response.error !== "string") {
      throw new Error("trusted host failure response is malformed");
    }
    throw new Error(response.error);
  }
  if (!exactKeys(response, options.responseKeys) || response.ok !== true) {
    throw new Error("trusted host response schema is malformed");
  }
  return response;
}

/** Production authority: only fixed, build-pinned assets can be selected. */
export function launchTrustedPythonHost(
  asset: TrustedPythonAsset,
  options: TrustedPythonHostCall,
): Record<string, unknown> {
  if (!(asset in ASSETS)) throw new Error("unknown fixed asset for production host");
  let bytes = productionAssetBytes.get(asset);
  if (!bytes) {
    const value = ASSETS[asset];
    bytes = verifiedAssetBytes(value.url, value.sha256);
    productionAssetBytes.set(asset, bytes);
  }
  return launchVerifiedBytes(bytes, options, false);
}

/** @internal Non-authoritative adversarial seam; never re-exported by the package. */
export function launchTestOnlyPythonHost(options: TestOnlyPythonHostCall): Record<string, unknown> {
  return launchVerifiedBytes(
    verifiedAssetBytes(options.host, options.hostSha256),
    options,
    true,
  );
}
