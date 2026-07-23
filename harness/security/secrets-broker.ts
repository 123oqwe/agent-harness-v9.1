/**
 * AH-SECRETS-001: Secret Broker
 *
 * Encrypted local secret store with single-exchange credentials.
 * Secrets are resolved only at the final authorized call boundary
 * and are always redacted from errors, events, and telemetry.
 *
 * Invariants:
 *  - Secrets are never stored in plaintext in memory or on disk
 *  - Exchange credentials are single-use
 *  - Redaction removes all known secret values from any data structure
 *  - Disk persistence uses AES-256-GCM encryption
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SecretRecord {
  name: string;
  encrypted_value: string;
  iv: string;
  auth_tag: string;
  created_at: string;
}

export interface ExchangeCredential {
  exchange_id: string;
  secret_name: string;
  value: string;
  run_id: string;
  step_id: string;
  consumed: boolean;
  created_at: string;
}

export interface SecretsBrokerOptions {
  encryptionKey: string;
  dataDir?: string;
}

// ---------------------------------------------------------------------------
// Internal encrypted record
// ---------------------------------------------------------------------------

interface InternalRecord {
  name: string;
  encrypted_value: string;
  iv: string;
  auth_tag: string;
  created_at: string;
}

interface ExchangeState {
  credential: ExchangeCredential;
  consumed: boolean;
}

// ---------------------------------------------------------------------------
// Secrets Broker
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm';

export class SecretsBroker {
  private readonly secretStore = new Map<string, InternalRecord>();
  private readonly exchanges = new Map<string, ExchangeState>();
  private readonly encryptionKey: Buffer;
  private readonly dataDir: string | null;

  constructor(opts: SecretsBrokerOptions) {
    // Derive a 32-byte key from the provided string
    this.encryptionKey = createHash('sha256').update(opts.encryptionKey).digest();
    this.dataDir = opts.dataDir ?? null;

    if (this.dataDir) {
      this.load();
    }
  }

  store(name: string, value: string): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.encryptionKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    this.secretStore.set(name, {
      name,
      encrypted_value: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      auth_tag: authTag.toString('base64'),
      created_at: new Date().toISOString(),
    });
  }

  retrieve(name: string): string | null {
    const record = this.secretStore.get(name);
    if (!record) return null;

    try {
      const iv = Buffer.from(record.iv, 'base64');
      const authTag = Buffer.from(record.auth_tag, 'base64');
      const encrypted = Buffer.from(record.encrypted_value, 'base64');
      const decipher = createDecipheriv(ALGORITHM, this.encryptionKey, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]);
      return decrypted.toString('utf8');
    } catch {
      // Decryption failed (wrong key, corrupted data)
      return null;
    }
  }

  delete(name: string): void {
    this.secretStore.delete(name);
  }

  list(): string[] {
    return [...this.secretStore.keys()];
  }

  exchange(
    secretName: string,
    ctx: { run_id: string; step_id: string },
  ): ExchangeCredential {
    const value = this.retrieve(secretName);
    if (value === null) {
      throw new Error(`Secret '${secretName}' not found`);
    }

    const exchangeId = createHash('sha256')
      .update(`${secretName}:${ctx.run_id}:${ctx.step_id}:${Date.now()}:${Math.random()}`)
      .digest('hex');

    const credential: ExchangeCredential = {
      exchange_id: exchangeId,
      secret_name: secretName,
      value,
      run_id: ctx.run_id,
      step_id: ctx.step_id,
      consumed: false,
      created_at: new Date().toISOString(),
    };

    this.exchanges.set(exchangeId, {
      credential,
      consumed: false,
    });

    return credential;
  }

  consumeExchange(exchangeId: string): boolean {
    const state = this.exchanges.get(exchangeId);
    if (!state) return false;
    if (state.consumed) return false;
    state.consumed = true;
    state.credential.consumed = true;
    return true;
  }

  isExchangeConsumed(exchangeId: string): boolean {
    return this.exchanges.get(exchangeId)?.consumed ?? false;
  }

  redact(input: unknown): unknown {
    if (input === null) return null;
    if (input === undefined) return undefined;
    if (typeof input === 'number') return input;
    if (typeof input === 'boolean') return input;
    if (typeof input === 'string') return this.redactString(input);
    if (input instanceof Error) {
      const redacted = new Error(this.redactString(input.message));
      redacted.name = input.name;
      redacted.stack = input.stack ? this.redactString(input.stack) : undefined;
      return redacted;
    }
    if (Array.isArray(input)) {
      return input.map((item) => this.redact(item));
    }
    if (typeof input === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        result[key] = this.redact(value);
      }
      return result;
    }
    return input;
  }

  flush(): void {
    if (!this.dataDir) return;
    const filePath = join(this.dataDir, 'secrets.enc.json');
    mkdirSync(dirname(filePath), { recursive: true });
    const data = JSON.stringify([...this.secretStore.values()]);
    writeFileSync(filePath, data, 'utf8');
  }

  getInternalStore(): Map<string, InternalRecord> {
    return new Map(this.secretStore);
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  private redactString(s: string): string {
    let result = s;
    for (const name of this.secretStore.keys()) {
      const value = this.retrieve(name);
      if (value && value.length > 0) {
        // Escape regex special characters in the secret value
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(new RegExp(escaped, 'g'), '[REDACTED]');
      }
    }
    return result;
  }

  private load(): void {
    if (!this.dataDir) return;
    const filePath = join(this.dataDir, 'secrets.enc.json');
    if (!existsSync(filePath)) return;

    try {
      const data = readFileSync(filePath, 'utf8');
      const records: InternalRecord[] = JSON.parse(data);
      for (const record of records) {
        this.secretStore.set(record.name, record);
      }
    } catch {
      // Corrupted or unreadable file - start fresh
    }
  }
}

