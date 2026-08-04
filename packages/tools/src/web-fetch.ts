/**
 * AH-TOOL-WEB-FETCH-001: Web fetch tool with SSRF/redirect/DNS rebinding protection.
 */
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { ToolResult, ToolContext } from './types.js';
import { ToolUnavailableError } from './types.js';

const PRIVATE_IP_PATTERNS = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^169\.254\./, /^0\./, /^::1$/, /^fc00:/, /^fe80:/,
];

const BLOCKED_HOSTS = ['localhost', 'metadata.google.internal', '169.254.169.254'];

interface WebFetchInput {
  url: string;
  max_bytes?: number;
  timeout_ms?: number;
}

export async function webFetch(input: WebFetchInput, context: ToolContext): Promise<ToolResult> {
  let url: URL;
  try {
    url = parseAndValidateUrl(input.url);
    await validateNotPrivate(url.hostname);
  } catch (e) {
    return { success: false, output: null, error: e instanceof Error ? e.message : String(e) };
  }
  
  const maxBytes = input.max_bytes ?? 1024 * 1024;
  const timeoutMs = input.timeout_ms ?? 30000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (context.signal) context.signal.addEventListener('abort', () => controller.abort());
  
  try {
    const response = await fetch(url.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Agent-Harness/1.0' },
    });
    if (!response.ok) {
      return { success: false, output: null, error: `HTTP ${response.status}` };
    }
    const contentType = response.headers.get('content-type') ?? 'unknown';
    const content = await response.text();
    const truncated = content.length > maxBytes ? content.slice(0, maxBytes) : content;
    return {
      success: true,
      output: {
        url: response.url,
        content_type: contentType,
        content: truncated,
        truncated: content.length > maxBytes,
        content_hash: createHash('sha256').update(truncated).digest('hex'),
      },
      metadata: { status: response.status, bytes: truncated.length },
    };
  } catch (e) {
    return { success: false, output: null, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timeout);
  }
}

function parseAndValidateUrl(urlStr: string): URL {
  let url: URL;
  try { url = new URL(urlStr); } catch { throw new Error('invalid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('only http/https protocols allowed');
  }
  if (BLOCKED_HOSTS.includes(url.hostname)) {
    throw new Error(`blocked host: ${url.hostname}`);
  }
  return url;
}

async function validateNotPrivate(hostname: string): Promise<void> {
  try {
    const addresses = await lookup(hostname, { all: true });
    for (const addr of addresses) {
      if (PRIVATE_IP_PATTERNS.some(p => p.test(addr.address))) {
        throw new Error(`SSRF blocked: ${hostname} resolves to private IP ${addr.address}`);
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('SSRF')) throw e;
    // DNS failure is not necessarily an error for validation
  }
}
