import { describe, it, expect, vi } from 'vitest';
import { manipulateSpreadsheet } from '../../../packages/tools/src/cli-tools.js';

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
  // --- AC7: Spawns python3 with JSON stdin, parses JSON stdout ---

  it('creates a spreadsheet with valid input', async () => {
    mockSpawnSuccess(JSON.stringify({ created: true, path: 'output/data.xlsx' }));
    const result = await manipulateSpreadsheet({
      action: 'create',
      file_path: 'output/data.xlsx',
    });
    expect(result.success).toBe(true);
    expect((result.output as Record<string, unknown>).created).toBe(true);
  });

  it('spawns python3 process with pipe stdio', async () => {
    mockSpawnSuccess(JSON.stringify({ created: true }));
    await manipulateSpreadsheet({ action: 'create', file_path: 'output/data.xlsx' });
    expect(spawn).toHaveBeenCalledWith('python3', expect.any(Array), expect.objectContaining({
      stdio: ['pipe', 'pipe', 'pipe'],
    }));
  });

  it('passes JSON stdin with action and file_path', async () => {
    const mockProc = mockSpawnSuccess(JSON.stringify({ created: true }));
    await manipulateSpreadsheet({ action: 'create', file_path: 'output/data.xlsx' });
    const stdinData = (mockProc.stdin.write as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    const parsed = JSON.parse(stdinData);
    expect(parsed.action).toBe('create');
    expect(parsed.file_path).toBe('output/data.xlsx');
  });

  it('parses JSON stdout into structured output', async () => {
    const mockOutput = { sheets: { Sheet1: [['A', 'B'], ['1', '2']] } };
    mockSpawnSuccess(JSON.stringify(mockOutput));
    const result = await manipulateSpreadsheet({ action: 'read', file_path: 'workspace/data.xlsx' });
    expect(result.success).toBe(true);
    expect(result.output).toEqual(mockOutput);
  });

  // --- AC8: No CLI positional args (JSON stdin protocol only) ---

  it('uses only -c flag with inline script (no positional file args)', async () => {
    mockSpawnSuccess(JSON.stringify({ created: true }));
    await manipulateSpreadsheet({ action: 'create', file_path: 'output/data.xlsx' });
    const callArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
    const args = callArgs![1] as string[];
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('-c');
  });

  // --- AC9: read_range returns cell values as 2D array ---

  it('reads spreadsheet and returns 2D array of cell values', async () => {
    const mockOutput = {
      sheets: {
        Sheet1: [['Name', 'Age'], ['Alice', 30], ['Bob', 25]],
      },
    };
    mockSpawnSuccess(JSON.stringify(mockOutput));
    const result = await manipulateSpreadsheet({ action: 'read', file_path: 'workspace/data.xlsx' });
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    const sheets = output.sheets as Record<string, unknown[][]>;
    expect(sheets.Sheet1!).toHaveLength(3);
    expect(sheets.Sheet1![0]).toEqual(['Name', 'Age']);
    expect(sheets.Sheet1![1]).toEqual(['Alice', 30]);
  });

  it('reads spreadsheet with multiple sheets', async () => {
    const mockOutput = {
      sheets: {
        Sheet1: [['A', 'B'], ['1', '2']],
        Sheet2: [['C', 'D'], ['3', '4']],
      },
    };
    mockSpawnSuccess(JSON.stringify(mockOutput));
    const result = await manipulateSpreadsheet({ action: 'read', file_path: 'workspace/multi.xlsx' });
    expect(result.success).toBe(true);
    const output = result.output as Record<string, unknown>;
    expect(Object.keys(output.sheets as object)).toHaveLength(2);
  });

  // --- AC10: write_range writes 2D array ---

  it('modifies spreadsheet with data', async () => {
    mockSpawnSuccess(JSON.stringify({ updated: true, path: 'workspace/data.xlsx' }));
    const result = await manipulateSpreadsheet({
      action: 'modify',
      file_path: 'workspace/data.xlsx',
      data: { Sheet1: [['new', 'data']] },
    });
    expect(result.success).toBe(true);
  });

  it('passes data field in stdin for modify action', async () => {
    const mockProc = mockSpawnSuccess(JSON.stringify({ updated: true }));
    await manipulateSpreadsheet({
      action: 'modify',
      file_path: 'workspace/data.xlsx',
      data: { Sheet1: [['val1', 'val2']] },
    });
    const stdinData = (mockProc.stdin.write as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    const parsed = JSON.parse(stdinData);
    expect(parsed.data).toBeDefined();
    expect(parsed.data.Sheet1).toBeDefined();
  });

  // --- AC13: Path traversal blocked (VFS enforced) ---

  it('rejects path traversal in file_path', async () => {
    await expect(manipulateSpreadsheet({
      action: 'read',
      file_path: '../../../etc/passwd',
    })).rejects.toThrow();
  });

  it('rejects absolute paths', async () => {
    await expect(manipulateSpreadsheet({
      action: 'read',
      file_path: '/etc/passwd',
    })).rejects.toThrow();
  });

  it('rejects paths outside allowed directories', async () => {
    await expect(manipulateSpreadsheet({
      action: 'create',
      file_path: 'evil/path.xlsx',
    })).rejects.toThrow();
  });

  it('accepts paths in workspace directory', async () => {
    mockSpawnSuccess(JSON.stringify({ sheets: {} }));
    const result = await manipulateSpreadsheet({ action: 'read', file_path: 'workspace/data.xlsx' });
    expect(result.success).toBe(true);
  });

  it('accepts paths in output directory', async () => {
    mockSpawnSuccess(JSON.stringify({ created: true }));
    const result = await manipulateSpreadsheet({ action: 'create', file_path: 'output/data.xlsx' });
    expect(result.success).toBe(true);
  });

  it('accepts paths in tmp directory', async () => {
    mockSpawnSuccess(JSON.stringify({ created: true }));
    const result = await manipulateSpreadsheet({ action: 'create', file_path: 'tmp/data.xlsx' });
    expect(result.success).toBe(true);
  });

  it('accepts paths in artifacts directory', async () => {
    mockSpawnSuccess(JSON.stringify({ created: true }));
    const result = await manipulateSpreadsheet({ action: 'create', file_path: 'artifacts/data.xlsx' });
    expect(result.success).toBe(true);
  });

  // --- AC15: On missing openpyxl: returns structured error ---

  it('returns structured error when openpyxl is not installed', async () => {
    mockSpawnFailure('ModuleNotFoundError: No module named openpyxl', 1);
    const result = await manipulateSpreadsheet({
      action: 'create',
      file_path: 'output/data.xlsx',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('ModuleNotFoundError');
  });

  it('returns structured error for non-zero exit code', async () => {
    mockSpawnFailure('PermissionError: cannot write', 2);
    const result = await manipulateSpreadsheet({
      action: 'create',
      file_path: 'output/data.xlsx',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('PermissionError');
  });

  it('returns structured error when spawn fails', async () => {
    const mockProc = {
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, cb: (err: Error) => void) => {
        if (event === 'error') cb(new Error('spawn python3 ENOENT'));
      }),
      kill: vi.fn(),
    };
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockProc);
    const result = await manipulateSpreadsheet({
      action: 'create',
      file_path: 'output/data.xlsx',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('ENOENT');
  });

  // --- Output parsing ---

  it('handles non-JSON stdout as plain string', async () => {
    mockSpawnSuccess('plain text');
    const result = await manipulateSpreadsheet({ action: 'read', file_path: 'workspace/data.xlsx' });
    expect(result.success).toBe(true);
    expect(result.output).toBe('plain text');
  });

  it('returns output null on failure', async () => {
    mockSpawnFailure('error', 1);
    const result = await manipulateSpreadsheet({ action: 'create', file_path: 'output/data.xlsx' });
    expect(result.output).toBeNull();
  });

  // --- All actions ---

  it('handles create action', async () => {
    mockSpawnSuccess(JSON.stringify({ created: true }));
    const result = await manipulateSpreadsheet({ action: 'create', file_path: 'output/new.xlsx' });
    expect(result.success).toBe(true);
  });

  it('handles read action', async () => {
    mockSpawnSuccess(JSON.stringify({ sheets: { Sheet1: [] } }));
    const result = await manipulateSpreadsheet({ action: 'read', file_path: 'workspace/data.xlsx' });
    expect(result.success).toBe(true);
  });

  it('handles modify action', async () => {
    mockSpawnSuccess(JSON.stringify({ updated: true }));
    const result = await manipulateSpreadsheet({ action: 'modify', file_path: 'workspace/data.xlsx' });
    expect(result.success).toBe(true);
  });
});
