import type { RagChunk } from './types.js';
import { RagError } from './types.js';

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions?/gi,
  /disregard\s+(all\s+)?prior\s+(instructions|context)/gi,
  /you\s+are\s+now\s+(a|an)\s+/gi,
  /system\s*:\s*/gi,
  /<\s*script\b/gi,
  /javascript:\s*/gi,
  /on\w+\s*=\s*["']/gi,
  /\bexec\s*\(/gi,
  /\beval\s*\(/gi,
  /data:text\/html/gi,
];

const SANITIZE_PATTERNS: Array<[RegExp, string]> = [
  [/<\s*script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '[REMOVED:script]'],
  [/<\s*script\b[^>]*\/>/gi, '[REMOVED:script]'],
  [/javascript:\s*/gi, '[REMOVED:js-uri]'],
  [/on\w+\s*=\s*["'][^"']*["']/gi, '[REMOVED:event-handler]'],
];

// Prompt injection patterns that must be neutralized in retrieved text
const INJECTION_SANITIZE_PATTERNS: Array<[RegExp, string]> = [
  [/ignore\s+(all\s+)?previous\s+instructions?/gi, '[NEUTRALIZED:injection]'],
  [/disregard\s+(all\s+)?prior\s+(instructions|context)/gi, '[NEUTRALIZED:injection]'],
  [/you\s+are\s+now\s+(a|an)\s+/gi, '[NEUTRALIZED:role-override] '],
  [/system\s*:\s*/gi, '[NEUTRALIZED:system-prefix]'],
  [/\bexec\s*\(/gi, '[NEUTRALIZED:exec]('],
  [/\beval\s*\(/gi, '[NEUTRALIZED:eval]('],
  [/data:text\/html/gi, '[NEUTRALIZED:data-uri]'],
];

export function detectInjection(text: string): string[] {
  const matches: string[] = [];
  for (const pattern of INJECTION_PATTERNS) {
    const found = text.match(pattern);
    if (found) {
      matches.push(...found);
    }
  }
  return matches;
}

export function sanitizeChunkText(text: string): string {
  let sanitized = text;
  // First neutralize prompt injection patterns
  for (const [pattern, replacement] of INJECTION_SANITIZE_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  // Then strip HTML/JS patterns
  for (const [pattern, replacement] of SANITIZE_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized;
}

export function safeChunkForRetrieval(chunk: RagChunk): RagChunk {
  const injections = detectInjection(chunk.text);
  if (injections.length > 0) {
    // Sanitize rather than block — the content is still retrievable
    // but injection payloads are neutralized
    const sanitizedText = sanitizeChunkText(chunk.text);
    return { ...chunk, text: sanitizedText };
  }
  return chunk;
}
