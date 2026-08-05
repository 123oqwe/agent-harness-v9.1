/**
 * AH-CONTEXT-OFFLOAD-001: Mechanical Offloading (P2-05)
 * Tool results >20K chars are written to VFS, replaced with preview in context.
 */
import type { VirtualFilesystem } from '../vfs/virtual-filesystem.js';
import { createHash } from 'node:crypto';

export const DEFAULT_OFFLOAD_OPTIONS = { threshold: 20_000, previewLines: 10, scratchPrefix: '/scratch/tool_results' };

export interface OffloadResult { offloaded: boolean; contextContent: string; offloadedPath?: string; originalLength: number }

export function offloadToolResult(vfs: VirtualFilesystem, content: string, stepId: string, toolName: string, opts: Partial<typeof DEFAULT_OFFLOAD_OPTIONS> = {}): OffloadResult {
  const o = { ...DEFAULT_OFFLOAD_OPTIONS, ...opts };
  if (content.length <= o.threshold) return { offloaded: false, contextContent: content, originalLength: content.length };
  const hash = createHash('sha256').update(`${stepId}:${toolName}:${content.slice(0, 256)}`).digest('hex').slice(0, 16);
  const path = `${o.scratchPrefix}/${stepId}_${toolName}_${hash}.txt`;
  vfs.writeText(path, content);
  const lines = content.split('\n');
  const preview = lines.slice(0, o.previewLines).join('\n');
  return { offloaded: true, contextContent: `[offloaded to ${path}]\n${preview}\n... (${lines.length - o.previewLines} more lines)`, offloadedPath: path, originalLength: content.length };
}

export function contextPressure(used: number, window: number): number { return window <= 0 ? 0 : used / window; }
export function shouldOffload(used: number, window: number): boolean { return contextPressure(used, window) >= 0.40; }
export function shouldCompact(used: number, window: number): boolean { return contextPressure(used, window) >= 0.70; }
export function shouldReset(used: number, window: number): boolean { return contextPressure(used, window) >= 0.85; }
