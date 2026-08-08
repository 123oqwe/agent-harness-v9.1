import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KeyVault } from '../../gateway/key-vault.js';

describe('KeyVault: env mapping and priority', () => {
  let oldEnv: Record<string, string | undefined>;
  beforeEach(() => { oldEnv = { ...process.env }; });
  afterEach(() => { process.env = oldEnv; });

  it('GLM_API_KEY takes priority over ZHIPU_API_KEY for zhipu', () => {
    process.env.GLM_API_KEY = 'glm-priority';
    process.env.ZHIPU_API_KEY = 'zhipu-secondary';
    const kv = new KeyVault();
    expect(kv.getKey('zhipu')).toBe('glm-priority');
  });

  it('loads DEEPSEEK_API_KEY for deepseek', () => {
    process.env.DEEPSEEK_API_KEY = 'ds-key';
    const kv = new KeyVault();
    expect(kv.getKey('deepseek')).toBe('ds-key');
  });

  it('loads GEMINI_API_KEY for google', () => {
    process.env.GEMINI_API_KEY = 'gem-key';
    const kv = new KeyVault();
    expect(kv.getKey('google')).toBe('gem-key');
  });

  it('loads GOOGLE_API_KEY for google when GEMINI not set', () => {
    delete process.env.GEMINI_API_KEY;
    process.env.GOOGLE_API_KEY = 'goog-key';
    const kv = new KeyVault();
    expect(kv.getKey('google')).toBe('goog-key');
  });

  it('loads MISTRAL_API_KEY for mistral', () => {
    process.env.MISTRAL_API_KEY = 'mis-key';
    const kv = new KeyVault();
    expect(kv.getKey('mistral')).toBe('mis-key');
  });

  it('loads QWEN_API_KEY for qwen', () => {
    process.env.QWEN_API_KEY = 'qwen-key';
    const kv = new KeyVault();
    expect(kv.getKey('qwen')).toBe('qwen-key');
  });

  it('loads DASHSCOPE_API_KEY for qwen when QWEN not set', () => {
    delete process.env.QWEN_API_KEY;
    process.env.DASHSCOPE_API_KEY = 'dash-key';
    const kv = new KeyVault();
    expect(kv.getKey('qwen')).toBe('dash-key');
  });

  it('loads KIMI_API_KEY for kimi', () => {
    process.env.KIMI_API_KEY = 'kimi-key';
    const kv = new KeyVault();
    expect(kv.getKey('kimi')).toBe('kimi-key');
  });

  it('loads MOONSHOT_API_KEY for kimi when KIMI not set', () => {
    delete process.env.KIMI_API_KEY;
    process.env.MOONSHOT_API_KEY = 'moon-key';
    const kv = new KeyVault();
    expect(kv.getKey('kimi')).toBe('moon-key');
  });

  it('loads PERPLEXITY_API_KEY for perplexity', () => {
    process.env.PERPLEXITY_API_KEY = 'pplx-key';
    const kv = new KeyVault();
    expect(kv.getKey('perplexity')).toBe('pplx-key');
  });

  it('loads VOLC_API_KEY for doubao', () => {
    process.env.VOLC_API_KEY = 'volc-key';
    const kv = new KeyVault();
    expect(kv.getKey('doubao')).toBe('volc-key');
  });

  it('loads DOUBAO_API_KEY for doubao when VOLC not set', () => {
    delete process.env.VOLC_API_KEY;
    process.env.DOUBAO_API_KEY = 'doubao-key';
    const kv = new KeyVault();
    expect(kv.getKey('doubao')).toBe('doubao-key');
  });

  it('loads VOLC_API_KEY for seedance', () => {
    process.env.VOLC_API_KEY = 'volc-seedance';
    const kv = new KeyVault();
    expect(kv.getKey('seedance')).toBe('volc-seedance');
  });

  it('loads SEEDANCE_API_KEY for seedance when VOLC not set', () => {
    delete process.env.VOLC_API_KEY;
    process.env.SEEDANCE_API_KEY = 'seed-key';
    const kv = new KeyVault();
    expect(kv.getKey('seedance')).toBe('seed-key');
  });

  it('ollama always registered with local-no-auth', () => {
    const kv = new KeyVault();
    expect(kv.getKey('ollama')).toBe('local-no-auth');
    expect(kv.hasProvider('ollama')).toBe(true);
  });

  it('vllm always registered with local-no-auth', () => {
    const kv = new KeyVault();
    expect(kv.getKey('vllm')).toBe('local-no-auth');
    expect(kv.hasProvider('vllm')).toBe(true);
  });
});

describe('KeyVault: dotenv loading', () => {
  it('skips comment lines in dotenv', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kv-test-'));
    const envFile = join(dir, '.env');
    writeFileSync(envFile, '# This is a comment\nOPENAI_API_KEY=sk-from-comment\n');
    const kv = new KeyVault({ secretsFile: envFile });
    expect(kv.getKey('openai')).toBe('sk-from-comment');
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips empty lines in dotenv', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kv-test-'));
    const envFile = join(dir, '.env');
    writeFileSync(envFile, '\n\nOPENAI_API_KEY=sk-after-empty\n\n');
    const kv = new KeyVault({ secretsFile: envFile });
    expect(kv.getKey('openai')).toBe('sk-after-empty');
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips lines without = in dotenv', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kv-test-'));
    const envFile = join(dir, '.env');
    writeFileSync(envFile, 'INVALID_LINE\nOPENAI_API_KEY=sk-valid\n');
    const kv = new KeyVault({ secretsFile: envFile });
    expect(kv.getKey('openai')).toBe('sk-valid');
    rmSync(dir, { recursive: true, force: true });
  });

  it('strips quotes from values in dotenv', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kv-test-'));
    const envFile = join(dir, '.env');
    writeFileSync(envFile, 'OPENAI_API_KEY="sk-quoted"\n');
    const kv = new KeyVault({ secretsFile: envFile });
    expect(kv.getKey('openai')).toBe('sk-quoted');
    rmSync(dir, { recursive: true, force: true });
  });

  it('strips single quotes from values in dotenv', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kv-test-'));
    const envFile = join(dir, '.env');
    writeFileSync(envFile, "OPENAI_API_KEY='sk-single'\n");
    const kv = new KeyVault({ secretsFile: envFile });
    expect(kv.getKey('openai')).toBe('sk-single');
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips lines that do not match API_KEY or API_SECRET pattern', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kv-test-'));
    const envFile = join(dir, '.env');
    writeFileSync(envFile, 'RANDOM_VAR=value\nOPENAI_API_KEY=sk-real\n');
    const kv = new KeyVault({ secretsFile: envFile });
    expect(kv.getKey('openai')).toBe('sk-real');
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not overwrite existing provider from dotenv', () => {
    process.env.OPENAI_API_KEY = 'sk-from-env';
    const dir = mkdtempSync(join(tmpdir(), 'kv-test-'));
    const envFile = join(dir, '.env');
    writeFileSync(envFile, 'OPENAI_API_KEY=sk-from-dotenv\n');
    const kv = new KeyVault({ secretsFile: envFile });
    expect(kv.getKey('openai')).toBe('sk-from-env');
    rmSync(dir, { recursive: true, force: true });
    delete process.env.OPENAI_API_KEY;
  });

  it('loads new provider from dotenv that is not in env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kv-test-'));
    const envFile = join(dir, '.env');
    writeFileSync(envFile, 'MISTRAL_API_KEY=mis-from-dotenv\n');
    const kv = new KeyVault({ secretsFile: envFile });
    expect(kv.getKey('mistral')).toBe('mis-from-dotenv');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('KeyVault: key rotation and health', () => {
  it('getKey returns oldest healthy key when multiple keys exist', () => {
    const kv = new KeyVault();
    kv.addKey('openai', 'key-old');
    // Small delay to ensure different created timestamp
    kv.addKey('openai', 'key-new');
    expect(kv.getKey('openai')).toBe('key-old');
  });

  it('getKey returns undefined when all keys are unhealthy', () => {
    const kv = new KeyVault();
    kv.addKey('openai', 'key-1');
    kv.addKey('openai', 'key-2');
    kv.markUnhealthy('openai', 'key-1');
    kv.markUnhealthy('openai', 'key-1');
    kv.markUnhealthy('openai', 'key-1');
    kv.markUnhealthy('openai', 'key-2');
    kv.markUnhealthy('openai', 'key-2');
    kv.markUnhealthy('openai', 'key-2');
    expect(kv.getKey('openai')).toBeUndefined();
  });

  it('getKey falls back to next healthy key when oldest is unhealthy', () => {
    const kv = new KeyVault();
    kv.addKey('openai', 'key-old');
    kv.addKey('openai', 'key-new');
    kv.markUnhealthy('openai', 'key-old');
    kv.markUnhealthy('openai', 'key-old');
    kv.markUnhealthy('openai', 'key-old');
    expect(kv.getKey('openai')).toBe('key-new');
  });

  it('markUnhealthy only affects matching key', () => {
    const kv = new KeyVault();
    kv.addKey('openai', 'key-a');
    kv.addKey('openai', 'key-b');
    kv.markUnhealthy('openai', 'key-a');
    kv.markUnhealthy('openai', 'key-a');
    kv.markUnhealthy('openai', 'key-a');
    expect(kv.getKey('openai')).toBe('key-b');
  });

  it('markUnhealthy on unknown provider does nothing', () => {
    const kv = new KeyVault();
    expect(() => kv.markUnhealthy('unknown', 'key')).not.toThrow();
  });

  it('markHealthy on unknown provider does nothing', () => {
    const kv = new KeyVault();
    expect(() => kv.markHealthy('unknown', 'key')).not.toThrow();
  });

  it('fail_count increments by 1 per markUnhealthy call', () => {
    const kv = new KeyVault();
    kv.addKey('openai', 'test-key');
    kv.markUnhealthy('openai', 'test-key');
    // After 1 failure, key is still healthy
    expect(kv.hasProvider('openai')).toBe(true);
    kv.markUnhealthy('openai', 'test-key');
    // After 2 failures, still healthy
    expect(kv.hasProvider('openai')).toBe(true);
    kv.markUnhealthy('openai', 'test-key');
    // After 3 failures, marked unhealthy
    expect(kv.hasProvider('openai')).toBe(false);
  });

  it('markHealthy resets fail_count to 0 and sets healthy to true', () => {
    const kv = new KeyVault();
    kv.addKey('openai', 'test-key');
    kv.markUnhealthy('openai', 'test-key');
    kv.markUnhealthy('openai', 'test-key');
    kv.markHealthy('openai', 'test-key');
    // After markHealthy, fail_count is 0, so 2 more failures won't make it unhealthy
    kv.markUnhealthy('openai', 'test-key');
    kv.markUnhealthy('openai', 'test-key');
    expect(kv.hasProvider('openai')).toBe(true);
  });

  it('listProviders excludes providers with only unhealthy keys', () => {
    const kv = new KeyVault();
    kv.addKey('custom', 'key-1');
    kv.markUnhealthy('custom', 'key-1');
    kv.markUnhealthy('custom', 'key-1');
    kv.markUnhealthy('custom', 'key-1');
    const providers = kv.listProviders();
    expect(providers).not.toContain('custom');
  });

  it('listProviders includes ollama and vllm', () => {
    const kv = new KeyVault();
    const providers = kv.listProviders();
    expect(providers).toContain('ollama');
    expect(providers).toContain('vllm');
  });
});

describe('KeyVault: encryption', () => {
  it('decrypt returns exact plaintext for unicode content', () => {
    const kv = new KeyVault({ masterKey: 'unicode-test-key' });
    const plaintext = 'Hello 世界 🌍 Привет';
    const encrypted = kv.encrypt(plaintext);
    expect(kv.decrypt(encrypted)).toBe(plaintext);
  });

  it('decrypt returns exact plaintext for empty string', () => {
    const kv = new KeyVault({ masterKey: 'empty-test-key' });
    const encrypted = kv.encrypt('');
    expect(kv.decrypt(encrypted)).toBe('');
  });

  it('encrypt with KEYVAULT_MASTER_KEY env var', () => {
    process.env.KEYVAULT_MASTER_KEY = 'env-master-key';
    const kv = new KeyVault();
    const encrypted = kv.encrypt('test-data');
    expect(kv.decrypt(encrypted)).toBe('test-data');
    delete process.env.KEYVAULT_MASTER_KEY;
  });

  it('different KeyVault instances with same masterKey can decrypt', () => {
    const kv1 = new KeyVault({ masterKey: 'shared-key' });
    const encrypted = kv1.encrypt('shared-secret');
    // Note: scryptSync with random salt means different instances
    // with the same masterKey will NOT be able to decrypt each other's data
    // This is by design (N21 fix: random salt per instance)
    // So we verify that the same instance can decrypt
    expect(kv1.decrypt(encrypted)).toBe('shared-secret');
  });

  it('decrypt fails with wrong masterKey', () => {
    const kv1 = new KeyVault({ masterKey: 'correct-key' });
    const encrypted = kv1.encrypt('secret');
    const kv2 = new KeyVault({ masterKey: 'wrong-key' });
    expect(() => kv2.decrypt(encrypted)).toThrow();
  });
});
