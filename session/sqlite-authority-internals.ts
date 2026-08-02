import type Database from "better-sqlite3";
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

import type { SessionEvent } from "./durable-session.js";

function encryptionPrefix(): string {
  return "ahenc:v1";
}

function keyDerivationContext(): string {
  return "agent-harness/session-store/v1";
}

const RECORD_KEY_CHECK_METADATA = "session_record_key_check";
const RECORD_KEY_CHECK_PLAINTEXT = "agent-harness/session-record-key-check/v1";
const RECORD_KEY_CHECK_AAD = "metadata:session_record_key_check";
const MAX_DURABLE_IDENTIFIER_BYTES = 256;

function containsForbiddenControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

export function validateDurableIdentifier(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string") throw new Error(`${name} is malformed`);
  let wellFormed = true;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        wellFormed = false;
        break;
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      wellFormed = false;
      break;
    }
  }
  if (
    !wellFormed ||
    value.length === 0 ||
    value.trim() !== value ||
    value.normalize("NFC") !== value ||
    Buffer.byteLength(value) > MAX_DURABLE_IDENTIFIER_BYTES ||
    containsForbiddenControl(value)
  ) {
    throw new Error(`${name} is malformed`);
  }
}

export function encodeLengthPrefixedIdentifiers(values: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  for (const value of values) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.byteLength);
    parts.push(length, bytes);
  }
  return Buffer.concat(parts);
}

export function hasSessionEncryptionEnvelope(value: string): boolean {
  const parts = value.split(":");
  return parts.length === 5 && `${parts[0]}:${parts[1]}` === encryptionPrefix();
}

export function deriveSessionRecordKey(
  db: Database.Database,
  masterKey: Uint8Array,
): Buffer {
  const saltRow = db
    .prepare("SELECT value FROM metadata WHERE key = 'encryption_salt'")
    .get() as { value: string } | undefined;
  if (!saltRow) throw new Error("session encryption salt unavailable");
  return deriveSessionRecordKeyFromSalt(saltRow.value, masterKey);
}

export function deriveSessionRecordKeyFromSalt(
  encodedSalt: string,
  masterKey: Uint8Array,
): Buffer {
  const salt = Buffer.from(encodedSalt, "base64");
  if (salt.byteLength !== 32) throw new Error("session encryption salt invalid");
  // hkdfSync consumes the caller-owned view synchronously; this authority does
  // not retain or duplicate the master key after derivation.
  return Buffer.from(
    hkdfSync("sha256", masterKey, salt, keyDerivationContext(), 32),
  );
}

export function authenticateSessionRecordMaterial(
  key: Buffer,
  material: Readonly<{
    sentinel?: string | null;
    legacy?: Readonly<{ run_id: string; goal: string }> | null;
  }>,
): void {
  if (material.sentinel) {
    try {
      if (
        decryptSessionString(key, material.sentinel, RECORD_KEY_CHECK_AAD) !==
        RECORD_KEY_CHECK_PLAINTEXT
      ) {
        throw new Error("record key sentinel mismatch");
      }
      return;
    } catch {
      throw new Error("session record key authentication failed");
    }
  }
  if (!material.legacy) {
    throw new Error("session record key authentication unavailable");
  }
  try {
    decryptSessionString(
      key,
      material.legacy.goal,
      `runs:${material.legacy.run_id}:goal`,
    );
  } catch {
    throw new Error("session record key authentication failed");
  }
}

export function encryptSessionString(
  key: Buffer,
  value: string,
  associatedData: string,
): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(associatedData));
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return [
    encryptionPrefix(),
    nonce.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptSessionString(
  key: Buffer,
  value: string,
  associatedData: string,
): string {
  const parts = value.split(":");
  if (!hasSessionEncryptionEnvelope(value)) {
    throw new Error("invalid encrypted envelope");
  }
  const nonce = Buffer.from(parts[2]!, "base64");
  const tag = Buffer.from(parts[3]!, "base64");
  const ciphertext = Buffer.from(parts[4]!, "base64");
  if (nonce.byteLength !== 12 || tag.byteLength !== 16) {
    throw new Error("invalid encrypted envelope");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(associatedData));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString();
}

/**
 * Authenticate the derived record key before callers perform schema or
 * business writes. A legacy database may acquire the key check only after an
 * existing encrypted run has authenticated the same key.
 */
export function ensureSessionRecordKeyCheck(
  db: Database.Database,
  key: Buffer,
): void {
  const row = db
    .prepare("SELECT value FROM metadata WHERE key = ?")
    .get(RECORD_KEY_CHECK_METADATA) as { value: string } | undefined;
  if (row) {
    try {
      if (
        decryptSessionString(key, row.value, RECORD_KEY_CHECK_AAD) !==
        RECORD_KEY_CHECK_PLAINTEXT
      ) {
        throw new Error("record key sentinel mismatch");
      }
      return;
    } catch {
      throw new Error("session record key authentication failed");
    }
  }

  const legacy = db
    .prepare("SELECT run_id, goal FROM runs ORDER BY run_id LIMIT 1")
    .get() as { run_id: string; goal: string } | undefined;
  if (legacy) {
    try {
      decryptSessionString(key, legacy.goal, `runs:${legacy.run_id}:goal`);
    } catch {
      throw new Error("session record key authentication failed");
    }
  }
  db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run(
    RECORD_KEY_CHECK_METADATA,
    encryptSessionString(key, RECORD_KEY_CHECK_PLAINTEXT, RECORD_KEY_CHECK_AAD),
  );
}

/** Authenticate an existing database without performing any write. */
export function authenticateSessionRecordKey(
  db: Database.Database,
  key: Buffer,
): void {
  const row = db
    .prepare("SELECT value FROM metadata WHERE key = ?")
    .get(RECORD_KEY_CHECK_METADATA) as { value: string } | undefined;
  const legacy = db
    .prepare("SELECT run_id, goal FROM runs ORDER BY run_id LIMIT 1")
    .get() as { run_id: string; goal: string } | undefined;
  authenticateSessionRecordMaterial(key, {
    sentinel: row?.value ?? null,
    legacy: legacy ?? null,
  });
}

export function insertCanonicalSessionEvent(
  db: Database.Database,
  key: Buffer,
  runId: string,
  event: SessionEvent,
): void {
  db.prepare(
    "INSERT INTO events (seq, run_id, type, timestamp, data_json, hash, prev_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    event.seq,
    runId,
    event.type,
    event.timestamp,
    encryptSessionString(
      key,
      JSON.stringify(event.data),
      `events:${runId}:${event.seq}:data_json`,
    ),
    event.hash,
    event.prev_hash,
  );
}

export function insertCanonicalSessionRun(
  db: Database.Database,
  key: Buffer,
  runId: string,
  goal: string,
  strategy: string | null,
  timestamp: string,
): void {
  db.prepare(
    "INSERT INTO runs (run_id, goal, strategy, status, created_at) VALUES (?, ?, ?, 'running', ?)",
  ).run(
    runId,
    encryptSessionString(key, goal, `runs:${runId}:goal`),
    strategy,
    timestamp,
  );
}

export function runImmediateTransaction<T>(
  db: Database.Database,
  operation: () => T,
): T {
  return db.transaction(operation).immediate();
}
