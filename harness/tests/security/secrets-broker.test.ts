import { describe, it, expect, beforeEach } from 'vitest';
import { SecretsBroker } from '../../security/secrets-broker.js';

describe('AH-SECRETS-001: secrets broker', () => {
  let broker: SecretsBroker;

  beforeEach(() => {
    broker = new SecretsBroker({ encryptionKey: 'test-encryption-key-32-bytes-long!' });
  });

  it('stores and retrieves a secret', () => {
    broker.store('api-key', 'sk-test-12345');
    const val = broker.retrieve('api-key');
    expect(val).toBe('sk-test-12345');
  });

  it('returns null for non-existent secret', () => {
    expect(broker.retrieve('nonexistent')).toBeNull();
  });

  it('stored secret is encrypted (not plaintext in memory)', () => {
    broker.store('api-key', 'sk-secret-value');
    const internal = broker.getInternalStore();
    // The internal store should NOT contain the plaintext value
    const allValues = JSON.stringify(internal);
    expect(allValues).not.toContain('sk-secret-value');
  });

  it('deletes a secret', () => {
    broker.store('api-key', 'sk-test-12345');
    broker.delete('api-key');
    expect(broker.retrieve('api-key')).toBeNull();
  });

  it('list returns secret names without values', () => {
    broker.store('api-key', 'sk-test-12345');
    broker.store('db-password', 'p@ssw0rd');
    const names = broker.list();
    expect(names).toContain('api-key');
    expect(names).toContain('db-password');
    expect(names.length).toBe(2);
  });

  it('exchange returns a single-use credential', () => {
    broker.store('api-key', 'sk-test-12345');
    const cred = broker.exchange('api-key', { run_id: 'run-001', step_id: 'step-001' });
    expect(cred.value).toBe('sk-test-12345');
    expect(cred.run_id).toBe('run-001');
    expect(cred.step_id).toBe('step-001');
    expect(cred.consumed).toBe(false);
  });

  it('exchange marks credential as consumed after first use', () => {
    broker.store('api-key', 'sk-test-12345');
    const cred = broker.exchange('api-key', { run_id: 'run-001', step_id: 'step-001' });
    broker.consumeExchange(cred.exchange_id);
    expect(broker.isExchangeConsumed(cred.exchange_id)).toBe(true);
  });

  it('cannot consume same exchange twice', () => {
    broker.store('api-key', 'sk-test-12345');
    const cred = broker.exchange('api-key', { run_id: 'run-001', step_id: 'step-001' });
    expect(broker.consumeExchange(cred.exchange_id)).toBe(true);
    expect(broker.consumeExchange(cred.exchange_id)).toBe(false);
  });

  it('redactSecrets removes known secret values from a string', () => {
    broker.store('api-key', 'sk-secret-to-redact');
    const input = 'Error: failed with key sk-secret-to-redact in request';
    const redacted = broker.redact(input);
    expect(redacted).not.toContain('sk-secret-to-redact');
    expect(redacted).toContain('[REDACTED]');
  });

  it('redactSecrets handles objects recursively', () => {
    broker.store('api-key', 'sk-secret-123');
    const input = {
      message: 'ok',
      detail: { key: 'sk-secret-123', nested: { deep: 'sk-secret-123' } },
    };
    const redacted = broker.redact(input) as Record<string, unknown>;
    expect(JSON.stringify(redacted)).not.toContain('sk-secret-123');
  });

  it('redactSecrets handles arrays', () => {
    broker.store('api-key', 'secret-val');
    const input = ['normal', 'secret-val', 'other'];
    const redacted = broker.redact(input) as string[];
    expect(redacted).not.toContain('secret-val');
    expect(redacted[1]).toContain('[REDACTED]');
  });

  it('redactSecrets handles Error objects', () => {
    broker.store('api-key', 'secret-in-error');
    const err = new Error('failed with key secret-in-error');
    const redacted = broker.redact(err) as Error;
    expect(redacted.message).not.toContain('secret-in-error');
    expect(redacted.message).toContain('[REDACTED]');
  });

  it('redactSecrets handles null and undefined', () => {
    expect(broker.redact(null)).toBeNull();
    expect(broker.redact(undefined)).toBeUndefined();
  });

  it('redactSecrets handles numbers and booleans', () => {
    expect(broker.redact(42)).toBe(42);
    expect(broker.redact(true)).toBe(true);
  });

  it('persists to encrypted file and reloads', () => {
    const tmpDir = `/tmp/secrets-test-${Date.now()}`;
    const b1 = new SecretsBroker({ encryptionKey: 'test-key-32-bytes-long!!!!!!!!', dataDir: tmpDir });
    b1.store('api-key', 'sk-persisted-123');
    b1.flush();

    const b2 = new SecretsBroker({ encryptionKey: 'test-key-32-bytes-long!!!!!!!!', dataDir: tmpDir });
    expect(b2.retrieve('api-key')).toBe('sk-persisted-123');
  });

  it('different encryption key cannot decrypt', () => {
    const tmpDir = `/tmp/secrets-test-${Date.now()}`;
    const b1 = new SecretsBroker({ encryptionKey: 'key-one-32-bytes-long!!!!!!!!!!', dataDir: tmpDir });
    b1.store('api-key', 'sk-secret-123');
    b1.flush();

    const b2 = new SecretsBroker({ encryptionKey: 'key-two-32-bytes-long!!!!!!!!!!', dataDir: tmpDir });
    expect(b2.retrieve('api-key')).toBeNull();
  });
});
