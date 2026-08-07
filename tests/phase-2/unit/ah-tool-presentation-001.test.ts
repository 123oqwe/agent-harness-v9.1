import { describe, it, expect } from 'vitest';
import { generatePresentation } from '../../../packages/tools/src/cli-tools.js';
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

describe('AH-TOOL-PRESENTATION-001: generate_presentation tool (cli_wrapper, python-pptx)', () => {
  it('creates a presentation with slides', async () => {
    const mockOutput = { created: true, path: 'output/slides.pptx', slides: 3 };
    mockSpawnSuccess(JSON.stringify(mockOutput));
    const result = await generatePresentation({
      output_path: 'output/slides.pptx',
      slides: [
        { title: 'Intro' },
        { title: 'Details', content: ['Point 1', 'Point 2'] },
        { title: 'Summary' },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.output).toEqual(mockOutput);
  });

  it('rejects path traversal in output_path', async () => {
    await expect(generatePresentation({
      output_path: '../../../tmp/evil.pptx',
      slides: [{ title: 'Evil' }],
    })).rejects.toThrow();
  });

  it('returns error when python-pptx is not installed', async () => {
    mockSpawnFailure('ModuleNotFoundError: No module named pptx', 1);
    const result = await generatePresentation({
      output_path: 'output/slides.pptx',
      slides: [{ title: 'Test' }],
    });
    expect(result.success).toBe(false);
  });

  it('passes slide data via JSON stdin', async () => {
    const mockProc = mockSpawnSuccess(JSON.stringify({ created: true, path: 'output/slides.pptx', slides: 1 }));
    await generatePresentation({
      output_path: 'output/slides.pptx',
      slides: [{ title: 'Test Slide' }],
    });
    const writtenArg = mockProc.stdin.write.mock.calls[0]?.[0] as string;
    expect(writtenArg).toContain('output_path');
    expect(writtenArg).toContain('Test Slide');
  });

  it('calls python3 with correct arguments', async () => {
    mockSpawnSuccess(JSON.stringify({ created: true, path: 'output/slides.pptx', slides: 1 }));
    await generatePresentation({
      output_path: 'output/slides.pptx',
      slides: [{ title: 'Test' }],
    });
    expect(spawn).toHaveBeenCalledWith('python3', expect.arrayContaining(['-c']), expect.any(Object));
  });

  it('handles non-zero exit code with error', async () => {
    mockSpawnFailure('Error: invalid template', 2);
    const result = await generatePresentation({
      output_path: 'output/slides.pptx',
      slides: [{ title: 'Test' }],
    });
    expect(result.success).toBe(false);
  });

  it('handles single slide', async () => {
    mockSpawnSuccess(JSON.stringify({ created: true, path: 'output/single.pptx', slides: 1 }));
    const result = await generatePresentation({
      output_path: 'output/single.pptx',
      slides: [{ title: 'Only Slide' }],
    });
    expect(result.success).toBe(true);
    expect((result.output as Record<string, unknown>).slides).toBe(1);
  });

  it('handles slides with content', async () => {
    mockSpawnSuccess(JSON.stringify({ created: true, path: 'output/content.pptx', slides: 2 }));
    const result = await generatePresentation({
      output_path: 'output/content.pptx',
      slides: [
        { title: 'Title Slide' },
        { title: 'Content Slide', content: ['Point A', 'Point B', 'Point C'] },
      ],
    });
    expect(result.success).toBe(true);
  });
});
