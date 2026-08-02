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
  const salt = Buffer.from(saltRow.value, "base64");
  if (salt.byteLength !== 32) throw new Error("session encryption salt invalid");
  // hkdfSync consumes the caller-owned view synchronously; this authority does
  // not retain or duplicate the master key after derivation.
  return Buffer.from(
    hkdfSync("sha256", masterKey, salt, keyDerivationContext(), 32),
  );
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
