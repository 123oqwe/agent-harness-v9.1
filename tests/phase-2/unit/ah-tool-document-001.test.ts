import { describe, it, expect } from 'vitest';
import { generateDocument } from '../../../packages/tools/src/cli-tools.js';
import { vi } from 'vitest';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));
import { spawn } from 'node:child_process';

function mockSpawnSuccess(stdout: string) {
  const mockProc = {
    stdin: { write: vi.fn(), end: vi.fn() },
    stdout: { on: vi.fn((event: string, cb: (d: Buffer) => void) => {
      if (event === 'data') cb(Buffer.from(stdout));
    }) },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, cb: (code: number) => void) => {
      if (event === 'close') cb(0);
    }),
    kill: vi.fn(),
  };
  (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockProc);
  return mockProc;
}

function mockSpawnFailure(stderr: string, code = 1) {
  const mockProc = {
    stdin: { write: vi.fn(), end: vi.fn() },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn((event: string, cb: (d: Buffer) => void) => {
      if (event === 'data') cb(Buffer.from(stderr));
    }) },
    on: vi.fn((event: string, cb: (code: number) => void) => {
      if (event === 'close') cb(code);
    }),
    kill: vi.fn(),
  };
  (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockProc);
  return mockProc;
}

describe('AH-TOOL-DOCUMENT-001: generate_document tool (cli_wrapper, python-docx)', () => {
  it('generates a document with valid input', async () => {
    const mockOutput = { path: 'output/report.docx', pages: 3 };
    mockSpawnSuccess(JSON.stringify(mockOutput));
    const result = await generateDocument({
      template_path: 'workspace/template.docx',
      output_path: 'output/report.docx',
      content: { title: 'Test Report', sections: [{ heading: 'Intro', body: 'Hello' }] },
    });
    expect(result.success).toBe(true);
    expect(result.output).toEqual(mockOutput);
    expect(spawn).toHaveBeenCalledWith('python3', expect.arrayContaining(['-c']), expect.any(Object));
  });

  it('rejects path traversal in output_path', async () => {
    await expect(generateDocument({
      template_path: 'workspace/template.docx',
      output_path: '../../../etc/passwd',
      content: { title: 'Evil' },
    })).rejects.toThrow();
  });

  it('rejects absolute paths', async () => {
    await expect(generateDocument({
      template_path: '/etc/passwd',
      output_path: 'output/report.docx',
      content: { title: 'Evil' },
    })).rejects.toThrow();
  });

  it('returns structured error when python-docx is missing', async () => {
    mockSpawnFailure('ModuleNotFoundError: No module named docx', 1);
    const result = await generateDocument({
      template_path: 'workspace/template.docx',
      output_path: 'output/report.docx',
      content: { title: 'Test' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('ModuleNotFoundError');
  });

  it('passes JSON stdin to the spawned process', async () => {
    const mockProc = mockSpawnSuccess(JSON.stringify({ path: 'output/doc.docx' }));
    await generateDocument({
      template_path: 'workspace/template.docx',
      output_path: 'output/doc.docx',
      content: { title: 'Test' },
    });
    expect(mockProc.stdin.write).toHaveBeenCalledWith(expect.stringContaining('template_path'));
    expect(mockProc.stdin.write).toHaveBeenCalledWith(expect.stringContaining('output_path'));
  });
});
