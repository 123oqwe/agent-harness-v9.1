import { describe, it, expect } from 'vitest';
import { manipulateSpreadsheet } from '../../../packages/tools/src/cli-tools.js';
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

describe('AH-TOOL-SPREADSHEET-001: manipulate_spreadsheet tool (cli_wrapper, openpyxl)', () => {
  it('creates a spreadsheet', async () => {
    mockSpawnSuccess(JSON.stringify({ created: true, path: 'output/data.xlsx' }));
    const result = await manipulateSpreadsheet({
      action: 'create',
      file_path: 'output/data.xlsx',
    });
    expect(result.success).toBe(true);
    expect((result.output as Record<string, unknown>).created).toBe(true);
  });

  it('reads a spreadsheet', async () => {
    const mockOutput = { sheets: { Sheet1: [['Name', 'Age'], ['Alice', 30]] } };
    mockSpawnSuccess(JSON.stringify(mockOutput));
    const result = await manipulateSpreadsheet({
      action: 'read',
      file_path: 'workspace/data.xlsx',
    });
    expect(result.success).toBe(true);
    expect((result.output as Record<string, unknown>).sheets).toBeDefined();
  });

  it('rejects path traversal', async () => {
    await expect(manipulateSpreadsheet({
      action: 'read',
      file_path: '../../../etc/passwd',
    })).rejects.toThrow();
  });

  it('rejects paths outside allowed directories', async () => {
    await expect(manipulateSpreadsheet({
      action: 'create',
      file_path: 'evil/path.xlsx',
    })).rejects.toThrow();
  });

  it('returns error when openpyxl is not installed', async () => {
    mockSpawnFailure('ModuleNotFoundError: No module named openpyxl', 1);
    const result = await manipulateSpreadsheet({
      action: 'create',
      file_path: 'output/data.xlsx',
    });
    expect(result.success).toBe(false);
  });
});
