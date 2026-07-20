import { createHash, sign, verify, type KeyObject } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

import type { CapabilityToken } from '../../spec/types/capability-token.js';

export type CapabilityStatus = 'issued' | 'used' | 'revoked';

export interface SignedCapabilityToken {
  readonly algorithm: 'Ed25519';
  readonly claims: CapabilityToken;
  readonly signature: string;
}

export interface CapabilityStateRecord {
  readonly token_hash: string;
  readonly signature: string;
  readonly status: CapabilityStatus;
}

export interface CapabilityStateStore {
  register(tokenId: string, record: CapabilityStateRecord): Promise<void>;
  read(tokenId: string): Promise<CapabilityStateRecord | undefined>;
  consume(tokenId: string, tokenHash: string): Promise<'consumed' | 'used' | 'revoked' | 'missing' | 'mismatch'>;
  revoke(tokenId: string): Promise<boolean>;
}

export class CapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class CapabilityInvalidError extends CapabilityError {}
export class CapabilityExpiredError extends CapabilityError {}
export class CapabilityNotYetValidError extends CapabilityError {}
export class CapabilityUsedError extends CapabilityError {}
export class CapabilityRevokedError extends CapabilityError {}
export class CapabilityDelegationError extends CapabilityError {}
export class CredentialDispatchError extends CapabilityError {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function canonicalizeCapabilityValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeCapabilityValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalizeCapabilityValue(value[key])]),
  );
}

export function hashCapabilityValue(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeCapabilityValue(value)))
    .digest('hex');
}

export function signCapabilityClaims(claims: CapabilityToken, privateKey: KeyObject): string {
  return sign(null, Buffer.from(JSON.stringify(canonicalizeCapabilityValue(claims))), privateKey).toString(
    'base64url',
  );
}

export function verifyCapabilityClaims(
  claims: CapabilityToken,
  signature: string,
  publicKey: KeyObject,
): boolean {
  if (!/^[A-Za-z0-9_-]+$/u.test(signature)) return false;
  try {
    return verify(
      null,
      Buffer.from(JSON.stringify(canonicalizeCapabilityValue(claims))),
      publicKey,
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}

function cloneRecord(record: CapabilityStateRecord): CapabilityStateRecord {
  return Object.freeze({ ...record });
}

class SerialExecutor {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export class InMemoryCapabilityStateStore implements CapabilityStateStore {
  readonly #records = new Map<string, CapabilityStateRecord>();
  readonly #serial = new SerialExecutor();

  async register(tokenId: string, record: CapabilityStateRecord): Promise<void> {
    await this.#serial.run(() => {
      if (this.#records.has(tokenId)) throw new CapabilityInvalidError('duplicate capability token id');
      this.#records.set(tokenId, cloneRecord(record));
    });
  }

  async read(tokenId: string): Promise<CapabilityStateRecord | undefined> {
    return this.#serial.run(() => {
      const record = this.#records.get(tokenId);
      return record === undefined ? undefined : cloneRecord(record);
    });
  }

  async consume(
    tokenId: string,
    tokenHash: string,
  ): Promise<'consumed' | 'used' | 'revoked' | 'missing' | 'mismatch'> {
    return this.#serial.run(() => {
      const record = this.#records.get(tokenId);
      if (record === undefined) return 'missing';
      if (record.token_hash !== tokenHash) return 'mismatch';
      if (record.status === 'used') return 'used';
      if (record.status === 'revoked') return 'revoked';
      this.#records.set(tokenId, cloneRecord({ ...record, status: 'used' }));
      return 'consumed';
    });
  }

  async revoke(tokenId: string): Promise<boolean> {
    return this.#serial.run(() => {
      const record = this.#records.get(tokenId);
      if (record === undefined || record.status === 'revoked') return false;
      this.#records.set(tokenId, cloneRecord({ ...record, status: 'revoked' }));
      return true;
    });
  }
}

interface PersistedCapabilityState {
  version: 1;
  records: Record<string, CapabilityStateRecord>;
}

function validateStateRecord(value: unknown): asserts value is CapabilityStateRecord {
  if (!isRecord(value)) throw new CapabilityInvalidError('invalid capability state record');
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'signature,status,token_hash') {
    throw new CapabilityInvalidError('invalid capability state record fields');
  }
  if (!/^[0-9a-f]{64}$/u.test(String(value.token_hash))) {
    throw new CapabilityInvalidError('invalid capability state token hash');
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(String(value.signature))) {
    throw new CapabilityInvalidError('invalid capability state signature');
  }
  if (!['issued', 'used', 'revoked'].includes(String(value.status))) {
    throw new CapabilityInvalidError('invalid capability state status');
  }
}

function parseState(serialized: string): PersistedCapabilityState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new CapabilityInvalidError('invalid capability state JSON');
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.records)) {
    throw new CapabilityInvalidError('invalid capability state document');
  }
  if (Object.keys(parsed).sort().join(',') !== 'records,version') {
    throw new CapabilityInvalidError('invalid capability state fields');
  }
  for (const [tokenId, record] of Object.entries(parsed.records)) {
    if (!isUuid(tokenId)) throw new CapabilityInvalidError('invalid capability state token id');
    validateStateRecord(record);
  }
  return parsed as unknown as PersistedCapabilityState;
}

async function wait(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

export class FileCapabilityStateStore implements CapabilityStateStore {
  readonly #path: string;
  readonly #lockPath: string;
  readonly #lockTimeoutMs: number;

  constructor(path: string, options: { lock_timeout_ms?: number } = {}) {
    if (!isAbsolute(path)) throw new CapabilityInvalidError('capability state path must be absolute');
    this.#path = path;
    this.#lockPath = `${path}.lock`;
    this.#lockTimeoutMs = options.lock_timeout_ms ?? 5_000;
    if (!Number.isSafeInteger(this.#lockTimeoutMs) || this.#lockTimeoutMs <= 0) {
      throw new CapabilityInvalidError('lock_timeout_ms must be a positive safe integer');
    }
  }

  async register(tokenId: string, record: CapabilityStateRecord): Promise<void> {
    await this.#mutate((state) => {
      if (state.records[tokenId] !== undefined) {
        throw new CapabilityInvalidError('duplicate capability token id');
      }
      state.records[tokenId] = cloneRecord(record);
    });
  }

  async read(tokenId: string): Promise<CapabilityStateRecord | undefined> {
    return this.#withLock(async () => {
      const state = await this.#load();
      const record = state.records[tokenId];
      return record === undefined ? undefined : cloneRecord(record);
    });
  }

  async consume(
    tokenId: string,
    tokenHash: string,
  ): Promise<'consumed' | 'used' | 'revoked' | 'missing' | 'mismatch'> {
    let outcome: 'consumed' | 'used' | 'revoked' | 'missing' | 'mismatch' = 'missing';
    await this.#mutate((state) => {
      const record = state.records[tokenId];
      if (record === undefined) return;
      if (record.token_hash !== tokenHash) {
        outcome = 'mismatch';
        return;
      }
      if (record.status === 'used' || record.status === 'revoked') {
        outcome = record.status;
        return;
      }
      state.records[tokenId] = cloneRecord({ ...record, status: 'used' });
      outcome = 'consumed';
    });
    return outcome;
  }

  async revoke(tokenId: string): Promise<boolean> {
    let changed = false;
    await this.#mutate((state) => {
      const record = state.records[tokenId];
      if (record === undefined || record.status === 'revoked') return;
      state.records[tokenId] = cloneRecord({ ...record, status: 'revoked' });
      changed = true;
    });
    return changed;
  }

  async #mutate(operation: (state: PersistedCapabilityState) => void): Promise<void> {
    await this.#withLock(async () => {
      const state = await this.#load();
      operation(state);
      await this.#save(state);
    });
  }

  async #load(): Promise<PersistedCapabilityState> {
    try {
      return parseState(await readFile(this.#path, 'utf8'));
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') return { version: 1, records: {} };
      throw error;
    }
  }

  async #save(state: PersistedCapabilityState): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#path}.tmp-${process.pid}-${Date.now()}`;
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(canonicalizeCapabilityValue(state)));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, this.#path);
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + this.#lockTimeoutMs;
    while (true) {
      try {
        await mkdir(this.#lockPath, { mode: 0o700 });
        break;
      } catch (error) {
        if (!isRecord(error) || error.code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw new CapabilityInvalidError('capability state lock timeout');
        await wait(2);
      }
    }
    try {
      return await operation();
    } finally {
      await rm(this.#lockPath, { recursive: true, force: true });
    }
  }
}

export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}
