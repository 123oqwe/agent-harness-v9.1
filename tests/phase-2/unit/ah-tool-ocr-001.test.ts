import { describe, it, expect } from 'vitest';
import { ocrDocument } from '../../../packages/tools/src/cli-tools.js';
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

describe('AH-TOOL-OCR-001: ocr_document tool (cli_wrapper, tesseract)', () => {
  it('runs OCR on a valid image path', async () => {
    const mockOutput = { text: 'Recognized text', language: 'eng', confidence: 0.92 };
    mockSpawnSuccess(JSON.stringify(mockOutput));
    const result = await ocrDocument({
      image_path: 'workspace/scan.png',
      language: 'eng',
    });
    expect(result.success).toBe(true);
    expect(result.output).toEqual(mockOutput);
  });

  it('supports multiple languages', async () => {
    mockSpawnSuccess(JSON.stringify({ text: 'Hello world', language: 'chi_sim', confidence: 0.88 }));
    const result = await ocrDocument({
      image_path: 'workspace/doc.png',
      language: 'chi_sim',
    });
    expect(result.success).toBe(true);
    expect((result.output as Record<string, unknown>).language).toBe('chi_sim');
  });

  it('rejects path traversal', async () => {
    await expect(ocrDocument({
      image_path: '../../../etc/passwd',
      language: 'eng',
    })).rejects.toThrow();
  });

  it('returns structured error when tesseract is missing', async () => {
    mockSpawnFailure('tesseract: command not found', 127);
    const result = await ocrDocument({
      image_path: 'workspace/scan.png',
      language: 'eng',
    });
    expect(result.success).toBe(false);
  });

  it('handles multiple languages', async () => {
    mockSpawnSuccess(JSON.stringify({ text: 'Hello world', language: 'eng+chi_sim', confidence: 0.85 }));
    const result = await ocrDocument({
      image_path: 'workspace/multi.png',
      language: 'eng+chi_sim',
    });
    expect(result.success).toBe(true);
    expect((result.output as Record<string, unknown>).language).toBe('eng+chi_sim');
  });

  it('handles empty OCR output', async () => {
    mockSpawnSuccess(JSON.stringify({ text: '', language: 'eng', confidence: 0 }));
    const result = await ocrDocument({
      image_path: 'workspace/blank.png',
      language: 'eng',
    });
    expect(result.success).toBe(true);
    expect((result.output as Record<string, unknown>).text).toBe('');
  });

  it('handles non-zero exit code with stderr', async () => {
    mockSpawnFailure('Error: invalid image format', 1);
    const result = await ocrDocument({
      image_path: 'workspace/bad.png',
      language: 'eng',
    });
    expect(result.success).toBe(false);
  });

  it('passes language option to spawn process', async () => {
    const mockProc = mockSpawnSuccess(JSON.stringify({ text: 'text', language: 'fra', confidence: 0.9 }));
    await ocrDocument({
      image_path: 'workspace/french.png',
      language: 'fra',
    });
    expect(mockProc.stdin.write).toHaveBeenCalledWith(expect.stringContaining('fra'));
  });
});
