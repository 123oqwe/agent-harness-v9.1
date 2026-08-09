import { describe, it, expect, vi } from 'vitest';
import { ocrDocument } from '../../../packages/tools/src/cli-tools.js';

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

describe('AH-TOOL-OCR-001: ocr_document tool (cli_wrapper, tesseract)', () => {
  // --- AC6: Spawns python3 with JSON stdin, parses JSON stdout ---

  it('runs OCR on a valid image path', async () => {
    mockSpawnSuccess(JSON.stringify({ text: 'Hello World', language: 'eng' }));
    const result = await ocrDocument({ image_path: 'workspace/test.png' });
    expect(result.success).toBe(true);
    expect((result.output as Record<string, unknown>).text).toBe('Hello World');
  });

  it('spawns python3 process with pipe stdio', async () => {
    mockSpawnSuccess(JSON.stringify({ text: 'test', language: 'eng' }));
    await ocrDocument({ image_path: 'workspace/test.png' });
    expect(spawn).toHaveBeenCalledWith('python3', expect.any(Array), expect.objectContaining({
      stdio: ['pipe', 'pipe', 'pipe'],
    }));
  });

  it('passes JSON stdin with image_path and language', async () => {
    const mockProc = mockSpawnSuccess(JSON.stringify({ text: 'test', language: 'eng' }));
    await ocrDocument({ image_path: 'workspace/test.png', language: 'chi_sim' });
    const stdinData = (mockProc.stdin.write as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    const parsed = JSON.parse(stdinData);
    expect(parsed.image_path).toBe('workspace/test.png');
    expect(parsed.language).toBe('chi_sim');
  });

  it('parses JSON stdout into structured output', async () => {
    const mockOutput = { text: 'Recognized text content', language: 'eng' };
    mockSpawnSuccess(JSON.stringify(mockOutput));
    const result = await ocrDocument({ image_path: 'workspace/doc.png' });
    expect(result.success).toBe(true);
    expect(result.output).toEqual(mockOutput);
  });

  // --- AC8: No CLI positional args ---

  it('uses only -c flag with inline script', async () => {
    mockSpawnSuccess(JSON.stringify({ text: '', language: 'eng' }));
    await ocrDocument({ image_path: 'workspace/test.png' });
    const callArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
    const args = callArgs![1] as string[];
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('-c');
  });

  // --- AC9: Language parameter maps to tesseract language codes ---

  it('defaults language to eng when not specified', async () => {
    const mockProc = mockSpawnSuccess(JSON.stringify({ text: 'test', language: 'eng' }));
    await ocrDocument({ image_path: 'workspace/test.png' });
    const stdinData = (mockProc.stdin.write as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    const parsed = JSON.parse(stdinData);
    expect(parsed.language).toBeUndefined(); // Not sent when undefined
  });

  it('accepts chi_sim language code', async () => {
    const mockProc = mockSpawnSuccess(JSON.stringify({ text: '中文', language: 'chi_sim' }));
    await ocrDocument({ image_path: 'workspace/chinese.png', language: 'chi_sim' });
    const stdinData = (mockProc.stdin.write as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    const parsed = JSON.parse(stdinData);
    expect(parsed.language).toBe('chi_sim');
  });

  it('accepts chi_tra language code', async () => {
    mockSpawnSuccess(JSON.stringify({ text: '繁體', language: 'chi_tra' }));
    const result = await ocrDocument({ image_path: 'workspace/traditional.png', language: 'chi_tra' });
    expect(result.success).toBe(true);
  });

  it('accepts jpn language code', async () => {
    mockSpawnSuccess(JSON.stringify({ text: '日本語', language: 'jpn' }));
    const result = await ocrDocument({ image_path: 'workspace/japanese.png', language: 'jpn' });
    expect(result.success).toBe(true);
  });

  it('accepts kor language code', async () => {
    mockSpawnSuccess(JSON.stringify({ text: '한국어', language: 'kor' }));
    const result = await ocrDocument({ image_path: 'workspace/korean.png', language: 'kor' });
    expect(result.success).toBe(true);
  });

  // --- AC10: Returns recognized text as string ---

  it('returns recognized text as string in output', async () => {
    mockSpawnSuccess(JSON.stringify({ text: 'Line 1\nLine 2\nLine 3', language: 'eng' }));
    const result = await ocrDocument({ image_path: 'workspace/multi.png' });
    expect(result.success).toBe(true);
    expect((result.output as Record<string, unknown>).text).toBe('Line 1\nLine 2\nLine 3');
    expect(typeof (result.output as Record<string, unknown>).text).toBe('string');
  });

  it('returns empty text for blank image', async () => {
    mockSpawnSuccess(JSON.stringify({ text: '', language: 'eng' }));
    const result = await ocrDocument({ image_path: 'workspace/blank.png' });
    expect(result.success).toBe(true);
    expect((result.output as Record<string, unknown>).text).toBe('');
  });

  // --- AC11: Path traversal blocked ---

  it('rejects path traversal in image_path', async () => {
    await expect(ocrDocument({ image_path: '../../../etc/passwd' })).rejects.toThrow();
  });

  it('rejects absolute paths', async () => {
    await expect(ocrDocument({ image_path: '/etc/passwd' })).rejects.toThrow();
  });

  it('rejects paths outside allowed directories', async () => {
    await expect(ocrDocument({ image_path: 'evil/image.png' })).rejects.toThrow();
  });

  it('accepts paths in workspace directory', async () => {
    mockSpawnSuccess(JSON.stringify({ text: 'ok', language: 'eng' }));
    const result = await ocrDocument({ image_path: 'workspace/image.png' });
    expect(result.success).toBe(true);
  });

  it('accepts paths in output directory', async () => {
    mockSpawnSuccess(JSON.stringify({ text: 'ok', language: 'eng' }));
    const result = await ocrDocument({ image_path: 'output/image.png' });
    expect(result.success).toBe(true);
  });

  it('accepts paths in artifacts directory', async () => {
    mockSpawnSuccess(JSON.stringify({ text: 'ok', language: 'eng' }));
    const result = await ocrDocument({ image_path: 'artifacts/image.png' });
    expect(result.success).toBe(true);
  });

  it('accepts paths in tmp directory', async () => {
    mockSpawnSuccess(JSON.stringify({ text: 'ok', language: 'eng' }));
    const result = await ocrDocument({ image_path: 'tmp/image.png' });
    expect(result.success).toBe(true);
  });

  // --- AC13: On missing tesseract: returns structured error ---

  it('returns structured error when pytesseract/PIL is missing', async () => {
    mockSpawnFailure('ModuleNotFoundError: No module named pytesseract', 1);
    const result = await ocrDocument({ image_path: 'workspace/test.png' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('ModuleNotFoundError');
  });

  it('returns structured error when tesseract binary is missing', async () => {
    mockSpawnFailure('pytesseract.pytesseract.TesseractNotFoundError: tesseract is not installed', 1);
    const result = await ocrDocument({ image_path: 'workspace/test.png' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('TesseractNotFoundError');
  });

  it('returns structured error for non-zero exit code', async () => {
    mockSpawnFailure('OSError: cannot open image', 2);
    const result = await ocrDocument({ image_path: 'workspace/corrupt.png' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('OSError');
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
    const result = await ocrDocument({ image_path: 'workspace/test.png' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('ENOENT');
  });

  // --- Output parsing ---

  it('handles non-JSON stdout as plain string', async () => {
    mockSpawnSuccess('plain text output');
    const result = await ocrDocument({ image_path: 'workspace/test.png' });
    expect(result.success).toBe(true);
    expect(result.output).toBe('plain text output');
  });

  it('returns output null on failure', async () => {
    mockSpawnFailure('error', 1);
    const result = await ocrDocument({ image_path: 'workspace/test.png' });
    expect(result.output).toBeNull();
  });

  // --- File format support ---

  it('accepts .png file path', async () => {
    mockSpawnSuccess(JSON.stringify({ text: 'png content', language: 'eng' }));
    const result = await ocrDocument({ image_path: 'workspace/scan.png' });
    expect(result.success).toBe(true);
  });

  it('accepts .jpeg file path', async () => {
    mockSpawnSuccess(JSON.stringify({ text: 'jpeg content', language: 'eng' }));
    const result = await ocrDocument({ image_path: 'workspace/photo.jpeg' });
    expect(result.success).toBe(true);
  });

  it('accepts .tiff file path', async () => {
    mockSpawnSuccess(JSON.stringify({ text: 'tiff content', language: 'eng' }));
    const result = await ocrDocument({ image_path: 'workspace/scan.tiff' });
    expect(result.success).toBe(true);
  });
});
