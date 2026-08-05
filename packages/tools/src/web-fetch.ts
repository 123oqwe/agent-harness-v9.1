/**
 * AH-TOOL-WEB-FETCH-001: Web fetch tool with SSRF/redirect/DNS rebinding protection.
 *
 * SSRF protection:
 * - Private IP ranges blocked by hostname check
 * - DNS resolution validated before fetch; DNS failures block the request
 * - DNS pinning: resolved IP is pinned via custom agent lookup to prevent
 *   DNS rebinding TOCTOU attacks
 * - Redirects handled manually with re-validation of each destination
 * - Redirect depth limited to prevent loops
 * - Response body read in chunks to enforce max_bytes
 */
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
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
    // Pin the resolved IP to prevent DNS rebinding TOCTOU: connect to the
    // pre-validated IP directly instead of letting fetch re-resolve DNS.
    const pinnedIp = resolvedIps[0]!;
    const isHttps = url.protocol === 'https:';
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const reqFn = isHttps ? request : httpRequest;
      const req = reqFn({
        method: 'GET',
        hostname: pinnedIp,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          Host: url.hostname,
          'User-Agent': 'Agent-Harness/1.0',
        },
        signal: controller.signal,
      }, (res: IncomingMessage) => resolve(res));
      req.on('error', reject);
      req.end();
    });

    // Handle redirects manually to re-validate each destination
    if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400) {
      const location = response.headers.location;
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

    if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
      return { success: false, output: null, error: `HTTP ${response.statusCode}` };
    }

    const contentType = response.headers['content-type'] ?? 'unknown';

    // Read response stream in chunks to enforce max_bytes
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let truncated = false;
    await new Promise<void>((resolve, reject) => {
      response.on('data', (chunk: Buffer) => {
        if (totalBytes + chunk.length > maxBytes) {
          chunks.push(chunk.slice(0, maxBytes - totalBytes));
          totalBytes = maxBytes;
          truncated = true;
          response.destroy();
          resolve();
        } else {
          chunks.push(chunk);
          totalBytes += chunk.length;
        }
      });
      response.on('end', resolve);
      response.on('error', reject);
    });
    if (truncated) {
      response.destroy();
    }
    const content = Buffer.concat(chunks).toString('utf8');

    return {
      success: true,
      output: {
        url: url.toString(),
        content_type: contentType,
        content,
        truncated,
        content_hash: createHash('sha256').update(content).digest('hex'),
        resolved_ips: resolvedIps,
      },
      metadata: { status: response.statusCode ?? 0, bytes: totalBytes, redirect_depth: redirectDepth },
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
