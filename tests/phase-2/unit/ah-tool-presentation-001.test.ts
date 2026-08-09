import { describe, it, expect, vi } from 'vitest';
import { generatePresentation } from '../../../packages/tools/src/cli-tools.js';

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
  // --- AC7: Spawns python3 with JSON stdin, parses JSON stdout ---

  it('generates a presentation with valid input', async () => {
    mockSpawnSuccess(JSON.stringify({ created: true, path: 'output/slides.pptx', slides: 3 }));
    const result = await generatePresentation({
      output_path: 'output/slides.pptx',
      slides: [
        { title: 'Slide 1', content: ['Point A', 'Point B'] },
        { title: 'Slide 2', content: ['Point C'] },
        { title: 'Slide 3' },
      ],
    });
    expect(result.success).toBe(true);
    expect((result.output as Record<string, unknown>).created).toBe(true);
  });

  it('spawns python3 process with pipe stdio', async () => {
    mockSpawnSuccess(JSON.stringify({ created: true }));
    await generatePresentation({
      output_path: 'output/slides.pptx',
      slides: [{ title: 'Test' }],
    });
    expect(spawn).toHaveBeenCalledWith('python3', expect.any(Array), expect.objectContaining({
      stdio: ['pipe', 'pipe', 'pipe'],
    }));
  });

  it('passes JSON stdin with output_path and slides', async () => {
    const mockProc = mockSpawnSuccess(JSON.stringify({ created: true }));
    await generatePresentation({
      output_path: 'output/slides.pptx',
      slides: [{ title: 'Slide 1', content: ['A', 'B'] }],
    });
    const stdinData = (mockProc.stdin.write as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    const parsed = JSON.parse(stdinData);
    expect(parsed.output_path).toBe('output/slides.pptx');
    expect(parsed.slides).toHaveLength(1);
    expect(parsed.slides[0].title).toBe('Slide 1');
    expect(parsed.slides[0].content).toEqual(['A', 'B']);
  });

  it('parses JSON stdout into structured output', async () => {
    const mockOutput = { created: true, path: 'output/slides.pptx', slides: 5 };
    mockSpawnSuccess(JSON.stringify(mockOutput));
    const result = await generatePresentation({
      output_path: 'output/slides.pptx',
      slides: [{ title: 'S1' }, { title: 'S2' }, { title: 'S3' }, { title: 'S4' }, { title: 'S5' }],
    });
    expect(result.success).toBe(true);
    expect(result.output).toEqual(mockOutput);
  });

  // --- AC8: No CLI positional args ---

  it('uses only -c flag with inline script', async () => {
    mockSpawnSuccess(JSON.stringify({ created: true }));
    await generatePresentation({
      output_path: 'output/slides.pptx',
      slides: [{ title: 'Test' }],
    });
    const callArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
    const args = callArgs![1] as string[];
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('-c');
  });

  // --- AC9: add_slide creates slide using specified layout ---

  it('creates presentation with multiple slides', async () => {
    mockSpawnSuccess(JSON.stringify({ created: true, slides: 3 }));
    const result = await generatePresentation({
      output_path: 'output/multi.pptx',
      slides: [
        { title: 'First', content: ['Content 1'] },
        { title: 'Second', content: ['Content 2'] },
        { title: 'Third', content: ['Content 3'] },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('creates presentation with slides without content', async () => {
    mockSpawnSuccess(JSON.stringify({ created: true, slides: 2 }));
    const result = await generatePresentation({
      output_path: 'output/titles.pptx',
      slides: [{ title: 'Title 1' }, { title: 'Title 2' }],
    });
    expect(result.success).toBe(true);
  });

  // --- AC10: add_text adds text box with formatting ---

  it('passes content array for text formatting in stdin', async () => {
    const mockProc = mockSpawnSuccess(JSON.stringify({ created: true }));
    await generatePresentation({
      output_path: 'output/slides.pptx',
      slides: [{ title: 'Test', content: ['Line 1', 'Line 2', 'Line 3'] }],
    });
    const stdinData = (mockProc.stdin.write as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    const parsed = JSON.parse(stdinData);
    expect(parsed.slides[0].content).toHaveLength(3);
  });

  // --- Path validation ---

  it('rejects path traversal in output_path', async () => {
    await expect(generatePresentation({
      output_path: '../../../etc/passwd',
      slides: [{ title: 'Evil' }],
    })).rejects.toThrow();
  });

  it('rejects absolute paths', async () => {
    await expect(generatePresentation({
      output_path: '/etc/passwd',
      slides: [{ title: 'Evil' }],
    })).rejects.toThrow();
  });

  it('rejects paths outside allowed directories', async () => {
    await expect(generatePresentation({
      output_path: 'evil/path.pptx',
      slides: [{ title: 'Evil' }],
    })).rejects.toThrow();
  });

  it('accepts paths in workspace directory', async () => {
    mockSpawnSuccess(JSON.stringify({ created: true }));
    const result = await generatePresentation({
      output_path: 'workspace/slides.pptx',
      slides: [{ title: 'OK' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts paths in output directory', async () => {
    mockSpawnSuccess(JSON.stringify({ created: true }));
    const result = await generatePresentation({
      output_path: 'output/slides.pptx',
      slides: [{ title: 'OK' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts paths in artifacts directory', async () => {
    mockSpawnSuccess(JSON.stringify({ created: true }));
    const result = await generatePresentation({
      output_path: 'artifacts/slides.pptx',
      slides: [{ title: 'OK' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts paths in tmp directory', async () => {
    mockSpawnSuccess(JSON.stringify({ created: true }));
    const result = await generatePresentation({
      output_path: 'tmp/slides.pptx',
      slides: [{ title: 'OK' }],
    });
    expect(result.success).toBe(true);
  });

  // --- AC14: On missing python-pptx: returns structured error ---

  it('returns structured error when python-pptx is missing', async () => {
    mockSpawnFailure('ModuleNotFoundError: No module named pptx', 1);
    const result = await generatePresentation({
      output_path: 'output/slides.pptx',
      slides: [{ title: 'Test' }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('ModuleNotFoundError');
  });

  it('returns structured error for non-zero exit code', async () => {
    mockSpawnFailure('FileNotFoundError: template.pptx', 2);
    const result = await generatePresentation({
      output_path: 'output/slides.pptx',
      slides: [{ title: 'Test' }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('FileNotFoundError');
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
    const result = await generatePresentation({
      output_path: 'output/slides.pptx',
      slides: [{ title: 'Test' }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('ENOENT');
  });

  // --- Output parsing ---

  it('handles non-JSON stdout as plain string', async () => {
    mockSpawnSuccess('plain text');
    const result = await generatePresentation({
      output_path: 'output/slides.pptx',
      slides: [{ title: 'Test' }],
    });
    expect(result.success).toBe(true);
    expect(result.output).toBe('plain text');
  });

  it('returns output null on failure', async () => {
    mockSpawnFailure('error', 1);
    const result = await generatePresentation({
      output_path: 'output/slides.pptx',
      slides: [{ title: 'Test' }],
    });
    expect(result.output).toBeNull();
  });

  // --- Empty/edge cases ---

  it('handles empty slides array', async () => {
    mockSpawnSuccess(JSON.stringify({ created: true, slides: 0 }));
    const result = await generatePresentation({
      output_path: 'output/empty.pptx',
      slides: [],
    });
    expect(result.success).toBe(true);
  });

  it('handles slide with empty content array', async () => {
    mockSpawnSuccess(JSON.stringify({ created: true, slides: 1 }));
    const result = await generatePresentation({
      output_path: 'output/slides.pptx',
      slides: [{ title: 'Title Only', content: [] }],
    });
    expect(result.success).toBe(true);
  });
});
