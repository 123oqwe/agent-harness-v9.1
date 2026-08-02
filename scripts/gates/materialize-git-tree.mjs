#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

import { spawnTrustedGitSync } from "./trusted-git.mjs";

const HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const ALLOWED_MODES = new Set(["100644", "100755"]);
const PORTABLE_FORBIDDEN = /[<>:"\\|?*]/u;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const MAX_ENTRIES = 100_000;
const MAX_BLOB_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

const splitNul = (buffer) => {
  const entries = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    entries.push(buffer.subarray(start, index));
    start = index + 1;
  }
  if (start !== buffer.length)
    throw new Error("Git tree listing is not NUL terminated");
  return entries.filter((entry) => entry.length > 0);
};

const decodePath = (bytes) => {
  const path = utf8.decode(bytes);
  const segments = path.split("/");
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.toLowerCase() === ".git" ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        PORTABLE_FORBIDDEN.test(segment) ||
        [...segment].some((character) => {
          const code = character.codePointAt(0);
          return code !== undefined && (code <= 0x1f || code === 0x7f);
        }) ||
        WINDOWS_DEVICE.test(segment),
    )
  ) {
    throw new Error(`unsafe Git tree path: ${JSON.stringify(path)}`);
  }
  return { path, segments };
};

const collisionKey = (path) => path.normalize("NFKC").toLowerCase();

export const parseGitTreeEntries = (bytes) => {
  const rawEntries = splitNul(bytes);
  if (rawEntries.length > MAX_ENTRIES)
    throw new Error(`Git tree exceeds ${MAX_ENTRIES} entries`);
  const namespace = new Map();
  return rawEntries.map((raw) => {
    const tab = raw.indexOf(9);
    if (tab <= 0) throw new Error("malformed Git tree entry");
    const header = raw.subarray(0, tab).toString("ascii");
    const match = header.match(
      /^([0-7]{6}) ([a-z]+) ([a-f0-9]{40}|[a-f0-9]{64})$/u,
    );
    if (!match) throw new Error(`malformed Git tree header: ${header}`);
    const [, mode, type, blobSha] = match;
    if (type !== "blob" || !ALLOWED_MODES.has(mode))
      throw new Error(`unsupported Git tree entry: ${mode} ${type}`);
    const { path, segments } = decodePath(raw.subarray(tab + 1));
    for (let index = 1; index <= segments.length; index += 1) {
      const candidate = segments.slice(0, index).join("/");
      const key = collisionKey(candidate);
      const kind = index === segments.length ? "file" : "directory";
      const previous = namespace.get(key);
      if (previous && (previous.path !== candidate || previous.kind !== kind))
        throw new Error(
          `Git tree path collision: ${previous.path} and ${candidate}`,
        );
      namespace.set(key, { path: candidate, kind });
    }
    return { mode, blobSha, path, segments };
  });
};

const verifyBlobHash = (blobSha, bytes) => {
  const algorithm = blobSha.length === 40 ? "sha1" : "sha256";
  const actual = createHash(algorithm)
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  if (actual !== blobSha) throw new Error(`Git blob hash mismatch: ${blobSha}`);
};

const loadTree = ({ repositoryRoot, commitSha }) => {
  if (!HASH.test(commitSha)) throw new TypeError("commit SHA is invalid");
  const listed = spawnTrustedGitSync(
    ["ls-tree", "-r", "-z", "--full-tree", commitSha],
    {
      cwd: repositoryRoot,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    },
  );
  if (listed.status !== 0) throw new Error("cannot list bound Git tree");
  const entries = parseGitTreeEntries(listed.stdout);
  let totalBytes = 0;
  const loaded = entries.map((entry) => {
    const blob = spawnTrustedGitSync(["cat-file", "blob", entry.blobSha], {
      cwd: repositoryRoot,
      encoding: "buffer",
      maxBuffer: MAX_BLOB_BYTES,
      timeout: 120_000,
    });
    if (blob.status !== 0)
      throw new Error(`cannot read Git blob ${entry.blobSha}`);
    totalBytes += blob.stdout.length;
    if (totalBytes > MAX_TOTAL_BYTES)
      throw new Error(`Git tree exceeds ${MAX_TOTAL_BYTES} bytes`);
    verifyBlobHash(entry.blobSha, blob.stdout);
    return { ...entry, bytes: blob.stdout };
  });
  return { entries: loaded, totalBytes };
};

export const materializeExactGitTree = ({
  repositoryRoot,
  commitSha,
  destination,
}) => {
  const source = realpathSync(repositoryRoot);
  const target = resolve(destination);
  const tree = loadTree({ repositoryRoot: source, commitSha });
  mkdirSync(target, { mode: 0o700 });
  for (const entry of tree.entries) {
    let parent = target;
    for (const segment of entry.segments.slice(0, -1)) {
      parent = join(parent, segment);
      try {
        mkdirSync(parent, { mode: 0o755 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      if (!lstatSync(parent).isDirectory())
        throw new Error(
          `materialization ancestor is not a directory: ${entry.path}`,
        );
    }
    const output = join(target, entry.path);
    const descriptor = openSync(
      output,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      entry.mode === "100755" ? 0o755 : 0o644,
    );
    try {
      writeFileSync(descriptor, entry.bytes);
    } finally {
      closeSync(descriptor);
    }
    chmodSync(output, entry.mode === "100755" ? 0o755 : 0o644);
  }
  return { files: tree.entries.length, bytes: tree.totalBytes };
};

const parseArguments = (argv) => {
  if (
    argv.length !== 6 ||
    argv[0] !== "--repository" ||
    argv[2] !== "--commit" ||
    argv[4] !== "--destination"
  ) {
    throw new Error(
      "usage: materialize-git-tree.mjs --repository <path> --commit <sha> --destination <path>",
    );
  }
  return { repositoryRoot: argv[1], commitSha: argv[3], destination: argv[5] };
};

const isMain = (() => {
  if (process.argv[1] === undefined) return false;
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(process.argv[1])
    );
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    const result = materializeExactGitTree(
      parseArguments(process.argv.slice(2)),
    );
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    process.stderr.write(
      `materialize-git-tree: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
