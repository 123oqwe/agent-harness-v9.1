/**
 * AH-TOOL-WEB-FETCH-001: Web fetch tool with SSRF/redirect/DNS rebinding protection.
 *
 * SSRF protection:
 * - Private IP ranges blocked by hostname check
 * - DNS resolution validated before fetch; DNS failures block the request
 * - Redirects handled manually with re-validation of each destination
 * - Redirect depth limited to prevent loops
 * - Response body read in chunks to enforce max_bytes
 *
 * Known limitation: fetch() re-resolves DNS independently, creating a TOCTOU
 * window for DNS rebinding attacks. Production deployments should use a custom
 * HTTP agent that pins the resolved IP address. This implementation provides
 * defense-in-depth but is not a complete DNS rebinding mitigation.
 */
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { ToolResult, ToolContext } from './types.js';

const PRIVATE_IP_PATTERNS = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^169\.254\./, /^0\./, /^::1$/, /^fc[0-9a-f]{2}:/i, /^fd[0-9a-f]{2}:/i,
  /^fe[89ab][0-9a-f]:/i, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^198\.1[89]\./, /^255\.255\.255\.255$/,
  /^::ffff:127\./, /^::ffff:10\./, /^::ffff:172\.(1[6-9]|2\d|3[01])\./,
  /^::ffff:192\.168\./, /^::ffff:169\.254\./, /^::ffff:0\./,
];

/** Extract IPv4 from IPv4-mapped IPv6 address (::ffff:a.b.c.d) */
function extractIPv4FromMapped(ip: string): string | null {
  const match = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return match?.[1] ?? null;
}

/** Check if an IP address is private, including IPv4-mapped IPv6 */
function isPrivateIp(ip: string): boolean {
  if (PRIVATE_IP_PATTERNS.some(p => p.test(ip))) return true;
  const ipv4 = extractIPv4FromMapped(ip);
  if (ipv4 && PRIVATE_IP_PATTERNS.some(p => p.test(ipv4))) return true;
  return false;
}

const BLOCKED_HOSTS = ['localhost', 'metadata.google.internal', '169.254.169.254'];
const MAX_REDIRECT_DEPTH = 5;

interface WebFetchInput {
  url: string;
  max_bytes?: number;
  timeout_ms?: number;
}

export async function webFetch(input: WebFetchInput, context: ToolContext): Promise<ToolResult> {
  return webFetchInternal(input, context, 0);
}

async function webFetchInternal(
  input: WebFetchInput,
  context: ToolContext,
  redirectDepth: number,
): Promise<ToolResult> {
  if (redirectDepth > MAX_REDIRECT_DEPTH) {
    return { success: false, output: null, error: `redirect depth exceeded (${MAX_REDIRECT_DEPTH})` };
  }

  let url: URL;
  let resolvedIps: string[];
  try {
    url = parseAndValidateUrl(input.url);
    resolvedIps = await validateNotPrivate(url.hostname);
  } catch (e) {
    return { success: false, output: null, error: e instanceof Error ? e.message : String(e) };
  }

  const maxBytes = input.max_bytes ?? 1024 * 1024;
  const timeoutMs = input.timeout_ms ?? 30000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (context.signal) {
    context.signal.addEventListener('abort', onAbort, { once: true });
  }

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
        return webFetchInternal({ ...input, url: redirectUrl.toString() }, context, redirectDepth + 1);
      } catch (e) {
        return { success: false, output: null, error: `redirect URL parse error: ${e instanceof Error ? e.message : String(e)}` };
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
    // Cancel the reader if we stopped early
    if (truncated) {
      await reader.cancel().catch(() => {});
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
        resolved_ips: resolvedIps,
      },
      metadata: { status: response.status, bytes: totalBytes, redirect_depth: redirectDepth },
    };
  } catch (e) {
    return { success: false, output: null, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timeout);
    if (context.signal) {
      context.signal.removeEventListener('abort', onAbort);
    }
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
  // Block obfuscated IP formats (decimal, hex, octal)
  const hostname = url.hostname;
  if (/^\d+$/.test(hostname)) {
    const ip = longToIp(parseInt(hostname, 10));
    if (isPrivateIp(ip)) {
      throw new Error(`SSRF blocked: obfuscated IP ${hostname} -> ${ip}`);
    }
  }
  return url;
}

async function validateNotPrivate(hostname: string): Promise<string[]> {
  const addresses = await lookup(hostname, { all: true });
  if (addresses.length === 0) {
    throw new Error(`DNS resolution failed: no addresses for ${hostname}`);
  }
  const resolvedIps: string[] = [];
  for (const addr of addresses) {
    resolvedIps.push(addr.address);
    if (isPrivateIp(addr.address)) {
      throw new Error(`SSRF blocked: ${hostname} resolves to private IP ${addr.address}`);
    }
  }
  return resolvedIps;
}

function longToIp(long: number): string {
  return `${(long >>> 24) & 255}.${(long >>> 16) & 255}.${(long >>> 8) & 255}.${long & 255}`;
}
