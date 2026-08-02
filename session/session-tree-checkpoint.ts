import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import {
  encodeLengthPrefixedIdentifiers,
  validateDurableIdentifier,
} from "./sqlite-authority-internals.js";
import { launchTrustedPythonHost } from "./trusted-python-host.js";

export interface SessionTreeCheckpointScope {
  readonly tenant_id: string;
  readonly root_session_id: string;
}

export interface SessionTreeCheckpointHeads {
  readonly version: 1;
  readonly bound: boolean;
  readonly tree: Readonly<{ seq: number; hash: string }>;
  readonly session_count: number;
  readonly command_count: number;
  readonly sessions_hash: string;
  readonly security_hash: string;
  readonly snapshot_hash: string;
  readonly ownership_hash: string;
  readonly state_hash: string;
}

export interface SessionTreeCheckpointPrepare {
  readonly operation_id: string;
  readonly old_revision: number;
  readonly new_revision: number;
  readonly old_heads: SessionTreeCheckpointHeads;
  readonly new_heads: SessionTreeCheckpointHeads;
}

export interface SessionTreeCheckpointPort {
  reconcile(
    scope: SessionTreeCheckpointScope,
    current: SessionTreeCheckpointHeads,
  ): Readonly<{ revision: number }>;
  prepare(
    scope: SessionTreeCheckpointScope,
    value: SessionTreeCheckpointPrepare,
  ): void;
  commit(scope: SessionTreeCheckpointScope, operationId: string): void;
  transition?<T>(
    scope: SessionTreeCheckpointScope,
    current: SessionTreeCheckpointHeads,
    operationId: string,
    operation: (
      revision: number,
      stage: (newHeads: SessionTreeCheckpointHeads) => void,
    ) => T,
  ): T;
  close?(): void;
}

/**
 * The default local sidecar detects database-only rollback and truncated tail
 * transitions. It does not detect an OS-level rollback of both the database and this sidecar.
 * That stronger guarantee requires an independently administered external monotonic anchor.
 * Descriptor-relative I/O pins the checkpoint directory identity per operation; it does not
 * claim protection from an attacker who already controls an opened ancestor descriptor.
 */

interface CheckpointState {
  readonly version: 1;
  readonly scope: SessionTreeCheckpointScope;
  readonly committed: Readonly<{
    revision: number;
    heads: SessionTreeCheckpointHeads;
  }>;
  readonly pending: SessionTreeCheckpointPrepare | null;
}

const stable = (value: unknown): string => JSON.stringify(value);
const CHECKPOINT_MAX_BYTES = 1024 * 1024;
const CHECKPOINT_MAX_COUNT = 1_000_000;

type DirectoryIdentity = Readonly<{ dev: number; ino: number }>;

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    stable(Object.keys(value).sort()) === stable([...keys].sort())
  );
}

function safeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= CHECKPOINT_MAX_COUNT;
}

function hash(value: unknown, allowEmpty = false): value is string {
  return typeof value === "string" && ((allowEmpty && value === "") || /^[0-9a-f]{64}$/.test(value));
}

function validScope(value: unknown): value is SessionTreeCheckpointScope {
  if (!exactKeys(value, ["tenant_id", "root_session_id"])) return false;
  try {
    validateDurableIdentifier("tenant_id", value.tenant_id);
    validateDurableIdentifier("root_session_id", value.root_session_id);
    return true;
  } catch {
    return false;
  }
}

function validHeads(value: unknown): value is SessionTreeCheckpointHeads {
  if (!exactKeys(value, [
    "version", "bound", "tree", "session_count", "command_count",
    "sessions_hash", "security_hash", "snapshot_hash", "ownership_hash", "state_hash",
  ])) return false;
  if (!exactKeys(value.tree, ["seq", "hash"])) return false;
  return value.version === 1 && typeof value.bound === "boolean" &&
    safeCount(value.tree.seq) && hash(value.tree.hash, value.tree.seq === 0) &&
    safeCount(value.session_count) && safeCount(value.command_count) &&
    hash(value.sessions_hash) && hash(value.security_hash) &&
    hash(value.snapshot_hash) && hash(value.ownership_hash) && hash(value.state_hash);
}

function validPrepare(value: unknown): value is SessionTreeCheckpointPrepare {
  if (!exactKeys(value, [
    "operation_id", "old_revision", "new_revision", "old_heads", "new_heads",
  ])) return false;
  try {
    validateDurableIdentifier("operation_id", value.operation_id);
  } catch {
    return false;
  }
  return safeCount(value.old_revision) && safeCount(value.new_revision) &&
    value.new_revision === value.old_revision + 1 &&
    validHeads(value.old_heads) && validHeads(value.new_heads);
}

function validState(value: unknown, scope: SessionTreeCheckpointScope): value is CheckpointState {
  if (!exactKeys(value, ["version", "scope", "committed", "pending"]) ||
      value.version !== 1 || !validScope(value.scope) || !same(value.scope, scope) ||
      !exactKeys(value.committed, ["revision", "heads"]) ||
      !safeCount(value.committed.revision) || !validHeads(value.committed.heads)) return false;
  return value.pending === null || validPrepare(value.pending);
}

function checkpointHost(request: Record<string, unknown>): Record<string, unknown> {
  const command = request.command;
  const requestKeys =
    command === "ensure"
      ? ["command", "directory"]
      : command === "read"
        ? ["command", "directory", "identity", "name", "max_bytes"]
        : ["command", "directory", "identity", "name", "max_bytes", "content"];
  const responseKeys =
    command === "read"
      ? ["ok", "identity", "missing", "content"]
      : ["ok", "identity"];
  try {
    return launchTrustedPythonHost("checkpoint", {
      request,
      requestKeys,
      responseKeys,
      timeoutMs: 10_000,
      maxOutputBytes: 2 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `session tree checkpoint descriptor authority rejected: ${
        error instanceof Error ? error.message : "host failed"
      }`,
      { cause: error },
    );
  }
}

function same(left: unknown, right: unknown): boolean {
  return stable(left) === stable(right);
}

export class FileSessionTreeCheckpoint implements SessionTreeCheckpointPort {
  readonly #directory: string;
  readonly #identity: DirectoryIdentity;
  readonly #key: Buffer;
  #closed = false;

  constructor(directory: string, masterKey: Uint8Array) {
    if (masterKey.byteLength !== 32) {
      throw new Error("32-byte checkpoint masterKey is required");
    }
    this.#directory = directory;
    this.#key = createHmac("sha256", masterKey)
      .update("agent-harness/session-tree-checkpoint-key/v1")
      .digest();
    try {
      const initialized = checkpointHost({ command: "ensure", directory });
      this.#identity = initialized.identity as DirectoryIdentity;
    } catch (error) {
      this.#key.fill(0);
      throw error;
    }
  }

  reconcile(
    scope: SessionTreeCheckpointScope,
    current: SessionTreeCheckpointHeads,
  ): Readonly<{ revision: number }> {
    this.#assertOpen();
    const state = this.#read(scope);
    if (!state) {
      if (current.bound) {
        throw new Error("session tree checkpoint is missing for a bound scope");
      }
      return { revision: 0 };
    }
    if (state.pending) {
      if (
        state.pending.old_revision !== state.committed.revision ||
        !same(state.pending.old_heads, state.committed.heads) ||
        state.pending.new_revision !== state.committed.revision + 1
      ) {
        throw new Error("session tree checkpoint pending transition is malformed");
      }
      if (same(current, state.pending.old_heads)) {
        this.#write(scope, { ...state, pending: null });
        return { revision: state.committed.revision };
      }
      if (same(current, state.pending.new_heads)) {
        this.#write(scope, {
          version: 1,
          scope,
          committed: {
            revision: state.pending.new_revision,
            heads: state.pending.new_heads,
          },
          pending: null,
        });
        return { revision: state.pending.new_revision };
      }
      throw new Error("session tree checkpoint requires reconciliation");
    }
    if (!same(current, state.committed.heads)) {
      throw new Error("session tree checkpoint does not match durable state");
    }
    return { revision: state.committed.revision };
  }

  prepare(
    scope: SessionTreeCheckpointScope,
    value: SessionTreeCheckpointPrepare,
  ): void {
    this.#assertOpen();
    const state = this.#read(scope);
    if (!state) {
      if (value.old_revision !== 0 || value.old_heads.bound) {
        throw new Error("session tree checkpoint prepare has no trusted base");
      }
      this.#write(scope, {
        version: 1,
        scope,
        committed: { revision: 0, heads: value.old_heads },
        pending: value,
      });
      return;
    }
    if (
      state.pending !== null ||
      state.committed.revision !== value.old_revision ||
      value.new_revision !== value.old_revision + 1 ||
      !same(state.committed.heads, value.old_heads)
    ) {
      throw new Error("session tree checkpoint prepare conflicts");
    }
    this.#write(scope, { ...state, pending: value });
  }

  commit(scope: SessionTreeCheckpointScope, operationId: string): void {
    this.#assertOpen();
    const state = this.#read(scope);
    if (!state?.pending || state.pending.operation_id !== operationId) {
      throw new Error("session tree checkpoint commit is not prepared");
    }
    this.#write(scope, {
      version: 1,
      scope,
      committed: {
        revision: state.pending.new_revision,
        heads: state.pending.new_heads,
      },
      pending: null,
    });
  }

  transition<T>(
    scope: SessionTreeCheckpointScope,
    current: SessionTreeCheckpointHeads,
    operationId: string,
    operation: (
      revision: number,
      stage: (newHeads: SessionTreeCheckpointHeads) => void,
    ) => T,
  ): T {
    this.#assertOpen();
    validateDurableIdentifier("operation_id", operationId);
    let state = this.#read(scope);
    let revision = 0;
    if (state) {
      if (state.pending) {
        if (
          state.pending.old_revision !== state.committed.revision ||
          !same(state.pending.old_heads, state.committed.heads) ||
          state.pending.new_revision !== state.committed.revision + 1
        ) {
          throw new Error("session tree checkpoint pending transition is malformed");
        }
        if (same(current, state.pending.old_heads)) {
          state = { ...state, pending: null };
          this.#write(scope, state);
        } else if (same(current, state.pending.new_heads)) {
          state = {
            version: 1,
            scope,
            committed: {
              revision: state.pending.new_revision,
              heads: state.pending.new_heads,
            },
            pending: null,
          };
          this.#write(scope, state);
        } else {
          throw new Error("session tree checkpoint requires reconciliation");
        }
      }
      if (!same(current, state.committed.heads)) {
        throw new Error("session tree checkpoint does not match durable state");
      }
      revision = state.committed.revision;
    } else if (current.bound) {
      throw new Error("session tree checkpoint is missing for a bound scope");
    }

    const base: CheckpointState = state ?? {
      version: 1,
      scope,
      committed: { revision: 0, heads: current },
      pending: null,
    };
    let prepared: CheckpointState | undefined;
    const stage = (newHeads: SessionTreeCheckpointHeads): void => {
      if (prepared) throw new Error("session tree checkpoint transition staged twice");
      const pending: SessionTreeCheckpointPrepare = {
        operation_id: operationId,
        old_revision: revision,
        new_revision: revision + 1,
        old_heads: current,
        new_heads: newHeads,
      };
      if (!validPrepare(pending)) {
        throw new Error("session tree checkpoint prepare is malformed");
      }
      prepared = { ...base, pending };
      this.#write(scope, prepared);
    };

    let result: T;
    try {
      result = operation(revision, stage);
    } catch (error) {
      if (prepared) {
        try {
          this.#write(scope, base);
        } catch {
          // A durable pending record is intentionally reconciled on the next open.
        }
      }
      throw error;
    }
    if (!prepared?.pending) {
      throw new Error("session tree checkpoint transition was not staged");
    }
    this.#write(scope, {
      version: 1,
      scope,
      committed: {
        revision: prepared.pending.new_revision,
        heads: prepared.pending.new_heads,
      },
      pending: null,
    });
    return result;
  }

  close(): void {
    if (this.#closed) return;
    this.#key.fill(0);
    this.#closed = true;
  }

  #path(scope: SessionTreeCheckpointScope): string {
    validateDurableIdentifier("tenant_id", scope.tenant_id);
    validateDurableIdentifier("root_session_id", scope.root_session_id);
    const name = createHmac("sha256", this.#key)
      .update(
        encodeLengthPrefixedIdentifiers([
          scope.tenant_id,
          scope.root_session_id,
        ]),
      )
      .digest("hex");
    return `${name}.checkpoint`;
  }

  #aad(scope: SessionTreeCheckpointScope): string {
    return stable(["session_tree_checkpoint", scope.tenant_id, scope.root_session_id]);
  }

  #read(scope: SessionTreeCheckpointScope): CheckpointState | null {
    const response = checkpointHost({
      command: "read",
      directory: this.#directory,
      identity: this.#identity,
      name: this.#path(scope),
      max_bytes: CHECKPOINT_MAX_BYTES,
    });
    if (response.missing === true) return null;
    const envelope = Buffer.from(String(response.content), "base64").toString("utf8");
    try {
      const parts = envelope.split(":");
      if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== "ahcheckpoint:v1") {
        throw new Error("session tree checkpoint envelope is malformed");
      }
      const nonce = Buffer.from(parts[2]!, "base64");
      const tag = Buffer.from(parts[3]!, "base64");
      if (nonce.byteLength !== 12 || tag.byteLength !== 16) {
        throw new Error("session tree checkpoint envelope is malformed");
      }
      const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce);
      decipher.setAAD(Buffer.from(this.#aad(scope)));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(parts[4]!, "base64")),
        decipher.final(),
      ]).toString();
      if (Buffer.byteLength(plaintext) > CHECKPOINT_MAX_BYTES) {
        throw new Error("session tree checkpoint byte limit exceeded");
      }
      const state = JSON.parse(plaintext) as CheckpointState;
      if (!validState(state, scope)) {
        throw new Error("session tree checkpoint schema is malformed");
      }
      return state;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "session tree checkpoint schema is malformed" ||
          error.message === "session tree checkpoint byte limit exceeded")
      ) {
        throw error;
      }
      throw new Error("session tree checkpoint authentication failed", {
        cause: error,
      });
    }
  }

  #write(scope: SessionTreeCheckpointScope, state: CheckpointState): void {
    if (!validState(state, scope)) {
      throw new Error("session tree checkpoint schema is malformed");
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(Buffer.from(this.#aad(scope)));
    const ciphertext = Buffer.concat([cipher.update(stable(state)), cipher.final()]);
    const envelope = [
      "ahcheckpoint:v1",
      nonce.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      ciphertext.toString("base64"),
    ].join(":");
    checkpointHost({
      command: "write",
      directory: this.#directory,
      identity: this.#identity,
      name: this.#path(scope),
      max_bytes: CHECKPOINT_MAX_BYTES,
      content: Buffer.from(envelope).toString("base64"),
    });
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("session tree checkpoint is closed");
  }
}
