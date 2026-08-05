/**
 * AH-CONTEXT-OFFLOAD-001: Mechanical Offloading (FG10 / P2-05)
 *
 * When a tool call input or result exceeds the offload threshold (default
 * 20000 chars ≈ 5000 tokens), it is written to the VFS and replaced in the
 * conversation layer by a file pointer plus a short preview (first 10 lines).
 * The full content is retrievable via read_file through VFS.
 *
 * Offloading is reversible and cache-friendlier than compaction: it trims
 * the conversation layer without rewriting the stable prefix, and the content
 * is not lost.
 */

import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';
import { createHash } from 'node:crypto';

export interface OffloadOptions {
  /** Character threshold above which content is offloaded (default 20000) */
  threshold: number;
  /** Number of preview lines to keep in context (default 10) */
  previewLines: number;
  /** VFS path prefix for offloaded files */
  scratchPrefix: string;
}

export const DEFAULT_OFFLOAD_OPTIONS: OffloadOptions = {
  threshold: 20_000,
  previewLines: 10,
  scratchPrefix: '/scratch/tool_results',
};

export interface OffloadResult {
  /** Whether the content was offloaded */
  offloaded: boolean;
  /** The content to place in the conversation (preview or original) */
  contextContent: string;
  /** VFS path where full content was stored (if offloaded) */
  offloadedPath?: string;
  /** Original content length */
  originalLength: number;
}

/**
 * Mechanically offloads large tool results to VFS.
 *
 * If the content exceeds the threshold, it is written to
 * /scratch/tool_results/{hash}.txt in the VFS, and a preview
 * (first N lines + file pointer) is returned for the conversation.
 *
 * If the content is below the threshold, it is returned unchanged.
 */
export function offloadToolResult(
  vfs: VirtualFilesystem,
  content: string,
  stepId: string,
  toolName: string,
  opts: Partial<OffloadOptions> = {},
): OffloadResult {
  const options = { ...DEFAULT_OFFLOAD_OPTIONS, ...opts };
  const originalLength = content.length;

  if (originalLength <= options.threshold) {
    return { offloaded: false, contextContent: content, originalLength };
  }

  // Generate a stable path for the offloaded content
  const hash = createHash('sha256')
    .update(`${stepId}:${toolName}:${content.slice(0, 256)}`)
    .digest('hex')
    .slice(0, 16);
  const offloadedPath = `${options.scratchPrefix}/${stepId}_${toolName}_${hash}.txt`;

 // Write full content to VFS
  vfs.write(offloadedPath, content);

  // Build preview: first N lines + file pointer
  const lines = content.split('\n');
  const preview = lines.slice(0, options.previewLines).join('\n');
  const contextContent =
    `[offloaded to ${offloadedPath}]\n` +
    `${preview}\n` +
    `... (${lines.length - options.previewLines} more lines, ${originalLength} chars total)\n` +
    `Use read_file("${offloadedPath}") to retrieve full content.`;

  return {
    offloaded: true,
    contextContent,
    offloadedPath,
    originalLength,
  };
}

/**
 * Context pressure calculator.
 * Returns the percentage of the context window currently in use.
 */
export function contextPressure(
  usedTokens: number,
  contextWindow: number,
): number {
  if (contextWindow <= 0) return 0;
  return usedTokens / contextWindow;
}

/**
 * Offload threshold check (40% pressure → offload).
 */
export function shouldOffload(usedTokens: number, contextWindow: number): boolean {
  return contextPressure(usedTokens, contextWindow) >= 0.40;
}

/**
 * Compaction threshold check (70% pressure after offload → compact).
 */
export function shouldCompact(usedTokens: number, contextWindow: number): boolean {
  return contextPressure(usedTokens, contextWindow) >= 0.70;
}

/**
 * Context reset threshold check (85% pressure → reset).
 */
export function shouldReset(usedTokens: number, contextWindow: number): boolean {
  return contextPressure(usedTokens, contextWindow) >= 0.85;
}
