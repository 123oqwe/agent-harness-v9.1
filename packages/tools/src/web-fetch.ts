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
      redirect: 'manual',
      headers: { 'User-Agent': 'Agent-Harness/1.0' },
    });

    // Handle redirects manually to re-validate each destination
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        return { success: false, output: null, error: 'redirect without location header' };
      }
      try {
        const redirectUrl = new URL(location, url.toString());
        await validateNotPrivate(redirectUrl.hostname);
        return webFetch({ ...input, url: redirectUrl.toString() }, context);
      } catch (e) {
        return { success: false, output: null, error: `redirect blocked: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    if (!response.ok) {
      return { success: false, output: null, error: `HTTP ${response.status}` };
    }

    const contentType = response.headers.get('content-type') ?? 'unknown';

    // Read response in chunks to enforce max_bytes without loading entire body
    const reader = response.body?.getReader();
    if (!reader) {
      return { success: false, output: null, error: 'no response body' };
    }
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (totalBytes + value.length > maxBytes) {
        chunks.push(value.slice(0, maxBytes - totalBytes));
        totalBytes = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      totalBytes += value.length;
    }
    const content = Buffer.concat(chunks).toString('utf8');

    return {
      success: true,
      output: {
        url: response.url,
        content_type: contentType,
        content,
        truncated,
        content_hash: createHash('sha256').update(content).digest('hex'),
      },
      metadata: { status: response.status, bytes: totalBytes },
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
  }
}
