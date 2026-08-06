import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

export interface StoredKey {
  readonly key: string;
  readonly created: number;
  healthy: boolean;
  fail_count: number;
}

export interface KeyVaultOptions {
  masterKey?: string;
  secretsFile?: string;
}

const ENV_MAPPING: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['openai', ['OPENAI_API_KEY']],
  ['anthropic', ['ANTHROPIC_API_KEY']],
  ['zhipu', ['GLM_API_KEY', 'ZHIPU_API_KEY']],
  ['deepseek', ['DEEPSEEK_API_KEY']],
  ['google', ['GEMINI_API_KEY', 'GOOGLE_API_KEY']],
  ['mistral', ['MISTRAL_API_KEY']],
  ['qwen', ['QWEN_API_KEY', 'DASHSCOPE_API_KEY']],
  ['kimi', ['KIMI_API_KEY', 'MOONSHOT_API_KEY']],
  ['perplexity', ['PERPLEXITY_API_KEY']],
  ['doubao', ['VOLC_API_KEY', 'DOUBAO_API_KEY']],
  ['ollama', []],
  ['vllm', []],
];

export class KeyVault {
  private readonly keys = new Map<string, StoredKey[]>();
  private readonly encKey: Buffer;

  constructor(opts: KeyVaultOptions = {}) {
    // N21 fix: do not use a hardcoded default key. If no master key is provided,
    // generate a random ephemeral one (lost on process exit) and warn.
    const masterRaw = opts.masterKey ?? process.env.KEYVAULT_MASTER_KEY;
    if (!masterRaw) {
      // Ephemeral random key — encryption works but is non-persistent.
      // This is safe for in-memory key management but cannot decrypt across restarts.
      const ephemeral = randomBytes(32).toString('hex');
      this.encKey = scryptSync(ephemeral, randomBytes(16), 32);
    } else {
      // N21 fix: use a random salt per KeyVault instance instead of hardcoded salt.
      this.encKey = scryptSync(masterRaw, randomBytes(16), 32);
    }
    this.loadFromEnv();
    if (opts.secretsFile && existsSync(opts.secretsFile)) this.loadDotenv(opts.secretsFile);
    // N22 fix: do not auto-read HOME/.env without explicit consent.
    // Callers must explicitly pass secretsFile if they want dotenv loading.
  }

  private loadFromEnv(): void {
    for (const [provider, vars] of ENV_MAPPING) {
      // Local providers with no env vars always register as available
      if (vars.length === 0) { this.addKey(provider, 'local-no-auth'); continue; }
      for (const v of vars) {
        const key = process.env[v];
        if (key) { this.addKey(provider, key); break; }
      }
    }
  }

  private loadDotenv(path: string): void {
    try {
      const content = readFileSync(path, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
        const eq = trimmed.indexOf('=');
        const keyName = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (!val || !/API_KEY|API_SECRET/i.test(keyName)) continue;
        const lower = keyName.toLowerCase();
        for (const [provider] of ENV_MAPPING) {
          if (lower.includes(provider) && !this.hasProvider(provider)) {
            this.addKey(provider, val);
            break;
          }
        }
      }
    } catch { /* ignore */ }
  }

  addKey(provider: string, apiKey: string): void {
    const list = this.keys.get(provider) ?? [];
    list.push({ key: apiKey, created: Date.now(), healthy: true, fail_count: 0 });
    this.keys.set(provider, list);
  }

  getKey(provider: string): string | undefined {
    const list = this.keys.get(provider);
    if (!list) return undefined;
    const healthy = list.filter(k => k.healthy);
    if (healthy.length === 0) return undefined;
    healthy.sort((a, b) => a.created - b.created);
    return healthy[0]!.key;
  }

  markUnhealthy(provider: string, apiKey: string): void {
    const list = this.keys.get(provider);
    if (!list) return;
    for (const k of list) {
      if (k.key === apiKey) {
        k.fail_count += 1;
        if (k.fail_count >= 3) k.healthy = false;
        break;
      }
    }
  }

  markHealthy(provider: string, apiKey: string): void {
    const list = this.keys.get(provider);
    if (!list) return;
    for (const k of list) {
      if (k.key === apiKey) { k.fail_count = 0; k.healthy = true; break; }
    }
  }

  hasProvider(provider: string): boolean {
    const list = this.keys.get(provider);
    return !!list && list.some(k => k.healthy);
  }

  listProviders(): string[] {
    return [...this.keys.keys()].filter(p => this.hasProvider(p));
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
  }

  decrypt(ciphertext: string): string {
    const buf = Buffer.from(ciphertext, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.encKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf-8');
  }
}
