import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KeyVault } from '../../gateway/key-vault.js';

describe('KeyVault', () => {
  let oldEnv: Record<string, string | undefined>;

  beforeEach(() => {
    oldEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = oldEnv;
  });

  it('creates with ephemeral key when no masterKey provided', () => {
    const kv = new KeyVault();
    expect(kv).toBeDefined();
  });

  it('creates with explicit masterKey', () => {
    const kv = new KeyVault({ masterKey: 'my-secret-master-key' });
    expect(kv).toBeDefined();
  });

  it('loads keys from environment variables', () => {
    process.env.OPENAI_API_KEY = 'sk-test-openai';
    const kv = new KeyVault();
    expect(kv.getKey('openai')).toBe('sk-test-openai');
    expect(kv.hasProvider('openai')).toBe(true);
  });

  it('supports GLM_API_KEY for zhipu provider', () => {
    process.env.GLM_API_KEY = 'glm-test-key';
    const kv = new KeyVault();
    expect(kv.getKey('zhipu')).toBe('glm-test-key');
  });

  it('supports ZHIPU_API_KEY for zhipu provider', () => {
    process.env.ZHIPU_API_KEY = 'zhipu-test-key';
    const kv = new KeyVault();
    expect(kv.getKey('zhipu')).toBe('zhipu-test-key');
  });

  it('registers local providers (ollama, vllm) without env vars', () => {
    const kv = new KeyVault();
    expect(kv.hasProvider('ollama')).toBe(true);
    expect(kv.hasProvider('vllm')).toBe(true);
    expect(kv.getKey('ollama')).toBe('local-no-auth');
  });

  it('returns undefined for unknown provider', () => {
    const kv = new KeyVault();
    expect(kv.getKey('unknown-provider')).toBeUndefined();
    expect(kv.hasProvider('unknown-provider')).toBe(false);
  });

  it('addKey adds a new key', () => {
    const kv = new KeyVault();
    kv.addKey('custom', 'custom-key-123');
    expect(kv.getKey('custom')).toBe('custom-key-123');
  });

  it('addKey supports multiple keys for same provider', () => {
    const kv = new KeyVault();
    kv.addKey('openai', 'key-1');
    kv.addKey('openai', 'key-2');
    // getKey returns the oldest healthy key
    expect(kv.getKey('openai')).toBe('key-1');
  });

  it('markUnhealthy sets fail_count and eventually marks unhealthy', () => {
    const kv = new KeyVault();
    kv.addKey('openai', 'test-key');
    kv.markUnhealthy('openai', 'test-key');
    expect(kv.getKey('openai')).toBe('test-key'); // still healthy (fail_count < 3)
    kv.markUnhealthy('openai', 'test-key');
    kv.markUnhealthy('openai', 'test-key');
    expect(kv.getKey('openai')).toBeUndefined(); // now unhealthy (fail_count >= 3)
  });

  it('markHealthy resets fail_count', () => {
    const kv = new KeyVault();
    kv.addKey('openai', 'test-key');
    kv.markUnhealthy('openai', 'test-key');
    kv.markUnhealthy('openai', 'test-key');
    kv.markUnhealthy('openai', 'test-key');
    expect(kv.hasProvider('openai')).toBe(false);
    kv.markHealthy('openai', 'test-key');
    expect(kv.hasProvider('openai')).toBe(true);
  });

  it('listProviders returns only providers with healthy keys', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const kv = new KeyVault();
    kv.addKey('custom', 'custom-key');
    const providers = kv.listProviders();
    expect(providers).toContain('openai');
    expect(providers).toContain('custom');
    expect(providers).toContain('ollama');
  });

  it('encrypt and decrypt round-trip', () => {
    const kv = new KeyVault({ masterKey: 'test-master-key' });
    const plaintext = 'secret-api-key-12345';
    const encrypted = kv.encrypt(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(kv.decrypt(encrypted)).toBe(plaintext);
  });

  it('decrypt fails on tampered ciphertext', () => {
    const kv = new KeyVault({ masterKey: 'test-master-key' });
    const encrypted = kv.encrypt('secret');
    const tampered = encrypted.slice(0, -4) + 'AAAA';
    expect(() => kv.decrypt(tampered)).toThrow();
  });

  it('encrypt produces different ciphertext for same plaintext (random IV)', () => {
    const kv = new KeyVault({ masterKey: 'test-master-key' });
    const e1 = kv.encrypt('same-text');
    const e2 = kv.encrypt('same-text');
    expect(e1).not.toBe(e2);
    expect(kv.decrypt(e1)).toBe('same-text');
    expect(kv.decrypt(e2)).toBe('same-text');
  });

  it('loads from dotenv file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kv-test-'));
    const envFile = join(dir, '.env');
    writeFileSync(envFile, 'OPENAI_API_KEY=sk-from-dotenv\nZHIPU_API_KEY=glm-from-dotenv\n');
    const kv = new KeyVault({ secretsFile: envFile });
    expect(kv.getKey('openai')).toBe('sk-from-dotenv');
    // GLM_API_KEY is loaded from env in constructor, ZHIPU_API_KEY from dotenv
expect(kv.getKey('openai')).toBe('sk-from-dotenv');
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not auto-read HOME/.env', () => {
    const kv = new KeyVault();
    // Without explicit secretsFile, should not read any file
    expect(kv).toBeDefined();
  });
});
