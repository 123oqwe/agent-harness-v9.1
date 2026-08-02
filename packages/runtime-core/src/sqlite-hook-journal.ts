import Database from "better-sqlite3";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  HOOK_EVENTS,
  HookSystem,
  type HookJournalClaim,
  type HookJournalPort,
  type HookJournalRecord,
  type HookRegistration,
  type HookScope,
  type HookSystemOptions,
} from "./hook-system.js";

const ENCRYPTION_PREFIX = "ahenc:v1";
const KEY_CONTEXT = "agent-harness/hook-journal/v1";
const KEY_CHECK_CONTEXT = "agent-harness/hook-journal/key-check/v1";
const SHA256 = /^[a-f0-9]{64}$/u;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS hook_journal_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hook_journal (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  operation_id TEXT,
  attempt_id TEXT,
  idempotency_key TEXT NOT NULL,
  event TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('CLAIMED', 'COMMITTED', 'RECONCILIATION')),
  owner_id TEXT,
  claim_token_hash TEXT UNIQUE,
  lease_expires_at_ms INTEGER,
  outcome_ciphertext TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, run_id, session_id, idempotency_key)
);
`;

interface JournalRow {
  tenant_id: string;
  run_id: string;
  session_id: string;
  operation_id: string | null;
  attempt_id: string | null;
  idempotency_key: string;
  event: HookJournalRecord["event"];
  input_hash: string;
  state: "CLAIMED" | "COMMITTED" | "RECONCILIATION";
  owner_id: string | null;
  claim_token_hash: string | null;
  lease_expires_at_ms: number | null;
  outcome_ciphertext: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface SqliteHookJournalOptions {
  readonly masterKey: Uint8Array;
  readonly ownerId: string;
  readonly leaseMs: number;
  readonly nowMs?: () => number;
}

function requiredId(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} is required`);
  }
}

function validateScope(scope: HookScope): void {
  requiredId("tenant_id", scope?.tenant_id);
  requiredId("run_id", scope?.run_id);
  requiredId("session_id", scope?.session_id);
  if (scope.operation_id !== undefined)
    requiredId("operation_id", scope.operation_id);
  if (scope.attempt_id !== undefined)
    requiredId("attempt_id", scope.attempt_id);
}

function sameScope(left: HookScope, right: HookScope): boolean {
  return (
    left.tenant_id === right.tenant_id &&
    left.run_id === right.run_id &&
    left.session_id === right.session_id &&
    left.operation_id === right.operation_id &&
    left.attempt_id === right.attempt_id
  );
}

function rowScope(row: JournalRow): HookScope {
  return Object.freeze({
    tenant_id: row.tenant_id,
    run_id: row.run_id,
    session_id: row.session_id,
    ...(row.operation_id === null ? {} : { operation_id: row.operation_id }),
    ...(row.attempt_id === null ? {} : { attempt_id: row.attempt_id }),
  });
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function aad(
  row: Pick<
    JournalRow,
    | "tenant_id"
    | "run_id"
    | "session_id"
    | "operation_id"
    | "attempt_id"
    | "idempotency_key"
    | "event"
    | "input_hash"
  >,
): string {
  return JSON.stringify([
    row.tenant_id,
    row.run_id,
    row.session_id,
    row.operation_id,
    row.attempt_id,
    row.idempotency_key,
    row.event,
    row.input_hash,
  ]);
}

export class SqliteHookJournal implements HookJournalPort {
  readonly #database: Database.Database;
  readonly #recordKey: Buffer;
  readonly #ownerId: string;
  readonly #leaseMs: number;
  readonly #nowMs: () => number;
  #closed = false;

  constructor(databasePath: string, options: SqliteHookJournalOptions) {
    requiredId("databasePath", databasePath);
    requiredId("ownerId", options?.ownerId);
    if (
      options?.masterKey === undefined ||
      options.masterKey.byteLength !== 32
    ) {
      throw new TypeError("32-byte Hook journal masterKey is required");
    }
    if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs <= 0) {
      throw new TypeError(
        "Hook journal leaseMs must be a positive safe integer",
      );
    }
    mkdirSync(dirname(databasePath), { recursive: true });
    this.#database = new Database(databasePath);
    chmodSync(databasePath, 0o600);
    this.#database.exec(SCHEMA);
    const getMetadata = this.#database.prepare(
      "SELECT value FROM hook_journal_metadata WHERE key = ?",
    );
    const insertMetadata = this.#database.prepare(
      "INSERT OR IGNORE INTO hook_journal_metadata (key, value) VALUES (?, ?)",
    );
    insertMetadata.run("encryption_salt", randomBytes(32).toString("base64"));
    const saltRow = getMetadata.get("encryption_salt") as
      { value: string } | undefined;
    const salt = Buffer.from(saltRow?.value ?? "", "base64");
    if (salt.byteLength !== 32) {
      this.#database.close();
      throw new Error("Hook journal encryption salt invalid");
    }
    const suppliedKey = Buffer.from(options.masterKey);
    let recordKey: Buffer;
    try {
      recordKey = Buffer.from(
        hkdfSync("sha256", suppliedKey, salt, KEY_CONTEXT, 32),
      );
    } finally {
      suppliedKey.fill(0);
      salt.fill(0);
    }
    const expectedKeyCheck = createHmac("sha256", recordKey)
      .update(KEY_CHECK_CONTEXT)
      .digest();
    try {
      const keyCheckRow = getMetadata.get("encryption_key_check") as
        { value: string } | undefined;
      if (keyCheckRow === undefined) {
        const rowCount = this.#database
          .prepare("SELECT COUNT(*) AS count FROM hook_journal")
          .get() as { count: number };
        if (rowCount.count !== 0) {
          throw new Error(
            "Hook journal key-check migration requires an empty journal",
          );
        }
        insertMetadata.run(
          "encryption_key_check",
          expectedKeyCheck.toString("hex"),
        );
      } else {
        const actualKeyCheck = SHA256.test(keyCheckRow.value)
          ? Buffer.from(keyCheckRow.value, "hex")
          : Buffer.alloc(0);
        try {
          if (
            actualKeyCheck.byteLength !== expectedKeyCheck.byteLength ||
            !timingSafeEqual(actualKeyCheck, expectedKeyCheck)
          ) {
            throw new Error("Hook journal master key rejected");
          }
        } finally {
          actualKeyCheck.fill(0);
        }
      }
      this.#recordKey = recordKey;
    } catch (error) {
      recordKey.fill(0);
      this.#database.close();
      throw error;
    } finally {
      expectedKeyCheck.fill(0);
    }
    this.#ownerId = options.ownerId;
    this.#leaseMs = options.leaseMs;
    this.#nowMs = options.nowMs ?? (() => Date.now());
  }

  async claim(input: {
    readonly scope: HookScope;
    readonly idempotency_key: string;
    readonly event: HookJournalRecord["event"];
    readonly input_hash: string;
  }): Promise<HookJournalClaim> {
    this.#assertOpen();
    this.#validateClaimInput(input);
    const transaction = this.#database.transaction((): HookJournalClaim => {
      const row = this.#getRow(input.scope, input.idempotency_key);
      const now = this.#now();
      if (!row) {
        const token = randomUUID();
        this.#database
          .prepare(
            `INSERT INTO hook_journal (
              tenant_id, run_id, session_id, operation_id, attempt_id,
              idempotency_key, event, input_hash, state, owner_id,
              claim_token_hash, lease_expires_at_ms, outcome_ciphertext,
              created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CLAIMED', ?, ?, ?, NULL, ?, ?)`,
          )
          .run(
            input.scope.tenant_id,
            input.scope.run_id,
            input.scope.session_id,
            input.scope.operation_id ?? null,
            input.scope.attempt_id ?? null,
            input.idempotency_key,
            input.event,
            input.input_hash,
            this.#ownerId,
            tokenHash(token),
            now + this.#leaseMs,
            now,
            now,
          );
        return { status: "claimed", claim_token: token };
      }
      this.#assertIdentity(row, input.scope, input.event, input.input_hash);
      if (row.state === "COMMITTED") {
        if (row.outcome_ciphertext === null) {
          throw new Error("Hook journal committed row is incomplete");
        }
        return {
          status: "replay",
          record: {
            scope: rowScope(row),
            idempotency_key: row.idempotency_key,
            event: row.event,
            input_hash: row.input_hash,
            outcome: this.#decryptOutcome(row),
          },
        };
      }
      if (row.state === "RECONCILIATION") {
        return {
          status: "reconciliation",
          reason_code: "hook_claim_abandoned",
        };
      }
      if (row.lease_expires_at_ms !== null && row.lease_expires_at_ms <= now) {
        this.#database
          .prepare(
            `UPDATE hook_journal
             SET state = 'RECONCILIATION', owner_id = NULL,
                 claim_token_hash = NULL, lease_expires_at_ms = NULL,
                 updated_at_ms = ?
             WHERE tenant_id = ? AND run_id = ? AND session_id = ?
               AND idempotency_key = ? AND state = 'CLAIMED'`,
          )
          .run(
            now,
            row.tenant_id,
            row.run_id,
            row.session_id,
            row.idempotency_key,
          );
        return {
          status: "reconciliation",
          reason_code: "hook_claim_abandoned",
        };
      }
      return {
        status: "reconciliation",
        reason_code: "hook_claim_in_flight",
      };
    });
    return transaction.immediate();
  }

  async commit(claimToken: string, record: HookJournalRecord): Promise<void> {
    this.#assertOpen();
    requiredId("claimToken", claimToken);
    this.#validateRecord(record);
    const transaction = this.#database.transaction((): "committed" | "expired" => {
      const row = this.#database
        .prepare("SELECT * FROM hook_journal WHERE claim_token_hash = ?")
        .get(tokenHash(claimToken)) as JournalRow | undefined;
      if (!row || row.state !== "CLAIMED") {
        throw new Error("invalid Hook journal claim");
      }
      this.#assertIdentity(row, record.scope, record.event, record.input_hash);
      if (row.idempotency_key !== record.idempotency_key) {
        throw new Error("Hook journal record identity conflict");
      }
      const now = this.#now();
      if (row.lease_expires_at_ms === null || row.lease_expires_at_ms <= now) {
        this.#database
          .prepare(
            `UPDATE hook_journal
             SET state = 'RECONCILIATION', owner_id = NULL,
                 claim_token_hash = NULL, lease_expires_at_ms = NULL,
                 updated_at_ms = ?
             WHERE tenant_id = ? AND run_id = ? AND session_id = ?
               AND idempotency_key = ?`,
          )
          .run(
            now,
            row.tenant_id,
            row.run_id,
            row.session_id,
            row.idempotency_key,
          );
        return "expired";
      }
      const encrypted = this.#encryptOutcome(row, record.outcome);
      const result = this.#database
        .prepare(
          `UPDATE hook_journal
           SET state = 'COMMITTED', owner_id = NULL, claim_token_hash = NULL,
               lease_expires_at_ms = NULL, outcome_ciphertext = ?, updated_at_ms = ?
           WHERE tenant_id = ? AND run_id = ? AND session_id = ?
             AND idempotency_key = ? AND state = 'CLAIMED'`,
        )
        .run(
          encrypted,
          now,
          row.tenant_id,
          row.run_id,
          row.session_id,
          row.idempotency_key,
        );
      if (result.changes !== 1) throw new Error("Hook journal commit conflict");
      return "committed";
    });
    if (transaction.immediate() === "expired") {
      throw new Error("Hook journal claim expired and requires reconciliation");
    }
  }

  async release(claimToken: string): Promise<void> {
    this.#assertOpen();
    requiredId("claimToken", claimToken);
    const transaction = this.#database.transaction(() => {
      const result = this.#database
        .prepare(
          `DELETE FROM hook_journal
           WHERE claim_token_hash = ? AND state = 'CLAIMED'`,
        )
        .run(tokenHash(claimToken));
      if (result.changes !== 1) throw new Error("invalid Hook journal claim");
    });
    transaction.immediate();
  }

  close(): void {
    if (this.#closed) return;
    try {
      this.#database.close();
    } finally {
      this.#recordKey.fill(0);
      this.#closed = true;
    }
  }

  #getRow(scope: HookScope, idempotencyKey: string): JournalRow | undefined {
    return this.#database
      .prepare(
        `SELECT * FROM hook_journal
         WHERE tenant_id = ? AND run_id = ? AND session_id = ?
           AND idempotency_key = ?`,
      )
      .get(scope.tenant_id, scope.run_id, scope.session_id, idempotencyKey) as
      JournalRow | undefined;
  }

  #assertIdentity(
    row: JournalRow,
    scope: HookScope,
    event: HookJournalRecord["event"],
    inputHash: string,
  ): void {
    if (
      !sameScope(rowScope(row), scope) ||
      row.event !== event ||
      row.input_hash !== inputHash
    ) {
      throw new Error("Hook journal idempotency key collision");
    }
  }

  #validateClaimInput(input: {
    scope: HookScope;
    idempotency_key: string;
    event: HookJournalRecord["event"];
    input_hash: string;
  }): void {
    validateScope(input.scope);
    requiredId("idempotency_key", input.idempotency_key);
    if (!HOOK_EVENTS.includes(input.event))
      throw new TypeError("unknown Hook event");
    if (!SHA256.test(input.input_hash)) {
      throw new TypeError("Hook journal input_hash must be SHA-256");
    }
  }

  #validateRecord(record: HookJournalRecord): void {
    this.#validateClaimInput(record);
    if (!record.outcome || record.outcome.event !== record.event) {
      throw new TypeError("Hook journal outcome event mismatch");
    }
  }

  #now(): number {
    const value = this.#nowMs();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(
        "Hook journal clock must return non-negative milliseconds",
      );
    }
    return value;
  }

  #encryptOutcome(
    row: JournalRow,
    outcome: HookJournalRecord["outcome"],
  ): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#recordKey, nonce);
    cipher.setAAD(Buffer.from(aad(row), "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(outcome), "utf8"),
      cipher.final(),
    ]);
    return [
      ENCRYPTION_PREFIX,
      nonce.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      ciphertext.toString("base64"),
    ].join(":");
  }

  #decryptOutcome(row: JournalRow): HookJournalRecord["outcome"] {
    try {
      const parts = row.outcome_ciphertext!.split(":");
      if (
        parts.length !== 5 ||
        `${parts[0]}:${parts[1]}` !== ENCRYPTION_PREFIX
      ) {
        throw new Error("invalid envelope");
      }
      const nonce = Buffer.from(parts[2]!, "base64");
      const tag = Buffer.from(parts[3]!, "base64");
      const ciphertext = Buffer.from(parts[4]!, "base64");
      if (nonce.byteLength !== 12 || tag.byteLength !== 16) {
        throw new Error("invalid envelope");
      }
      const decipher = createDecipheriv("aes-256-gcm", this.#recordKey, nonce);
      decipher.setAAD(Buffer.from(aad(row), "utf8"));
      decipher.setAuthTag(tag);
      return JSON.parse(
        Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
          "utf8",
        ),
      ) as HookJournalRecord["outcome"];
    } catch {
      throw new Error("hook journal authentication failed");
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Hook journal is closed");
  }
}

export interface DurableHookSystemOptions extends Omit<
  HookSystemOptions,
  "journal"
> {
  readonly databasePath: string;
  readonly masterKey: Uint8Array;
  readonly ownerId: string;
  readonly leaseMs: number;
  readonly nowMs?: () => number;
  readonly registrations: readonly HookRegistration[];
}

export function createDurableHookSystem(options: DurableHookSystemOptions) {
  const journal = new SqliteHookJournal(options.databasePath, {
    masterKey: options.masterKey,
    ownerId: options.ownerId,
    leaseMs: options.leaseMs,
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
  });
  const hooks = new HookSystem(options.registrations, {
    journal,
    ...(options.audit === undefined ? {} : { audit: options.audit }),
    ...(options.attenuationPolicy === undefined
      ? {}
      : { attenuationPolicy: options.attenuationPolicy }),
    ...(options.executionPort === undefined
      ? {}
      : { executionPort: options.executionPort }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.monotonicNow === undefined
      ? {}
      : { monotonicNow: options.monotonicNow }),
  });
  return Object.freeze({
    hooks,
    journal,
    close: () => journal.close(),
  });
}
