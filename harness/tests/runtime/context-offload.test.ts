import { describe, it, expect } from 'vitest';
import { VirtualFilesystem } from '../../vfs/virtual-filesystem.js';
import {
  offloadToolResult,
  contextPressure,
  shouldOffload,
  shouldCompact,
  shouldReset,
} from '../../runtime/context-offload.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeVfs(): VirtualFilesystem {
  return new VirtualFilesystem({
    root: mkdtempSync(join(tmpdir(), 'offload-test-')),
    permissions: [{ path_prefix: '/', read: true, write: true }],
  });
}

describe('AH-CONTEXT-OFFLOAD-001: Mechanical Offloading (P2-05)', () => {
  it('does not offload content below threshold', () => {
    const vfs = makeVfs();
    const result = offloadToolResult(vfs, 'short content', 'step-1', 'read_file');
    expect(result.offloaded).toBe(false);
    expect(result.contextContent).toBe('short content');
    expect(result.offloadedPath).toBeUndefined();
  });

  it('offloads content above threshold to VFS', () => {
    const vfs = makeVfs();
    const longContent = 'line\n'.repeat(5000); // 25000 chars > 20000 threshold
    const result = offloadToolResult(vfs, longContent, 'step-1', 'read_file');
    expect(result.offloaded).toBe(true);
    expect(result.offloadedPath).toBeDefined();
    expect(result.offloadedPath).toContain('/scratch/tool_results/');
    // Full content is retrievable from VFS
    const retrieved = vfs.read(result.offloadedPath!);
    expect(retrieved).toBe(longContent);
  });

  it('preview contains file pointer and first 10 lines', () => {
    const vfs = makeVfs();
    const longContent = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n') + '\n'.repeat(20000);
    const result = offloadToolResult(vfs, longContent, 'step-1', 'execute_command');
    expect(result.offloaded).toBe(true);
    expect(result.contextContent).toContain('[offloaded to');
    expect(result.contextContent).toContain('read_file(');
    expect(result.contextContent).toContain('line 0');
    expect(result.contextContent).toContain('line 9');
  });

  it('respects custom threshold', () => {
    const vfs = makeVfs();
    const result = offloadToolResult(vfs, 'medium content', 'step-1', 'read_file', { threshold: 5 });
    expect(result.offloaded).toBe(true);
  });
});

describe('AH-CONTEXT-OFFLOAD-001: Pressure thresholds (P2-05)', () => {
  it('contextPressure returns ratio', () => {
    expect(contextPressure(50000, 100000)).toBe(0.5);
    expect(contextPressure(0, 100000)).toBe(0);
  });

  it('shouldOffload triggers at 40%', () => {
    expect(shouldOffload(39000, 100000)).toBe(false);
    expect(shouldOffload(40000, 100000)).toBe(true);
    expect(shouldOffload(50000, 100000)).toBe(true);
  });

  it('shouldCompact triggers at 70%', () => {
    expect(shouldCompact(69000, 100000)).toBe(false);
    expect(shouldCompact(70000, 100000)).toBe(true);
  });

  it('shouldReset triggers at 85%', () => {
    expect(shouldReset(84000, 100000)).toBe(false);
    expect(shouldReset(85000, 100000)).toBe(true);
  });
});
