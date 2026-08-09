import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateDocument, type DocumentInput } from '../../../packages/tools/src/cli-tools.js';

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

function mockSpawnTimeout() {
  const mockProc = {
    stdin: { write: vi.fn(), end: vi.fn() },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'timeout') cb();
    }),
    kill: vi.fn(),
  };
  (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockProc);
  return mockProc;
}

describe('AH-TOOL-DOCUMENT-001: generate_document tool (cli_wrapper, python-docx)', () => {
  // --- AC7: Spawns python3 with JSON stdin, parses JSON stdout ---

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

  it('spawns python3 process (not shell)', async () => {
    mockSpawnSuccess(JSON.stringify({ path: 'output/doc.docx' }));
    await generateDocument({
      output_path: 'output/doc.docx',
      content: { title: 'Test' },
    });
    expect(spawn).toHaveBeenCalledWith('python3', expect.any(Array), expect.objectContaining({
      stdio: ['pipe', 'pipe', 'pipe'],
    }));
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
    const stdinData = (mockProc.stdin.write as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    const parsed = JSON.parse(stdinData);
    expect(parsed.output_path).toBe('output/doc.docx');
    expect(parsed.template_path).toBe('workspace/template.docx');
  });

  it('parses JSON stdout into structured output', async () => {
    const mockOutput = { created: true, path: 'output/report.docx', pages: 5 };
    mockSpawnSuccess(JSON.stringify(mockOutput));
    const result = await generateDocument({
      output_path: 'output/report.docx',
      content: { title: 'Report' },
    });
    expect(result.success).toBe(true);
    expect(result.output).toEqual(mockOutput);
  });

  it('handles non-JSON stdout as plain string output', async () => {
    mockSpawnSuccess('plain text output');
    const result = await generateDocument({
      output_path: 'output/doc.docx',
      content: { title: 'Test' },
    });
    expect(result.success).toBe(true);
    expect(result.output).toBe('plain text output');
  });

  // --- AC8: create starts a new .docx with optional template ---

  it('creates document without template_path', async () => {
    mockSpawnSuccess(JSON.stringify({ created: true, path: 'output/new.docx' }));
    const result = await generateDocument({
      output_path: 'output/new.docx',
      content: { title: 'New Doc' },
    });
    expect(result.success).toBe(true);
    const stdinData = (spawn as ReturnType<typeof vi.fn>).mock.calls[0]![2] as string;
    expect(stdinData).not.toContain('template_path');
  });

  it('creates document with template_path', async () => {
    mockSpawnSuccess(JSON.stringify({ created: true, path: 'output/from_template.docx' }));
    const result = await generateDocument({
      template_path: 'workspace/template.docx',
      output_path: 'output/from_template.docx',
      content: { title: 'From Template' },
    });
    expect(result.success).toBe(true);
  });

  // --- AC9: add_heading adds heading with level ---

  it('passes headings array with levels to stdin', async () => {
    const mockProc = mockSpawnSuccess(JSON.stringify({ path: 'output/headings.docx' }));
    await generateDocument({
      output_path: 'output/headings.docx',
      headings: [
        { text: 'Chapter 1', level: 1 },
        { text: 'Section 1.1', level: 2 },
        { text: 'Section 1.1.1', level: 3 },
      ],
    });
    const stdinData = (mockProc.stdin.write as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    const parsed = JSON.parse(stdinData);
    expect(parsed.headings).toHaveLength(3);
    expect(parsed.headings[0]).toEqual({ text: 'Chapter 1', level: 1 });
  });

  // --- AC10: add_paragraph adds formatted paragraph ---

  it('passes paragraphs array to stdin', async () => {
    const mockProc = mockSpawnSuccess(JSON.stringify({ path: 'output/paras.docx' }));
    await generateDocument({
      output_path: 'output/paras.docx',
      paragraphs: ['First paragraph', 'Second paragraph', 'Third paragraph'],
    });
    const stdinData = (mockProc.stdin.write as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    const parsed = JSON.parse(stdinData);
    expect(parsed.paragraphs).toHaveLength(3);
    expect(parsed.paragraphs[0]).toBe('First paragraph');
  });

  // --- AC11: add_table creates table from 2D data (via content.sections) ---

  it('handles content with multiple sections', async () => {
    mockSpawnSuccess(JSON.stringify({ path: 'output/multi.docx', pages: 5 }));
    const result = await generateDocument({
      output_path: 'output/multi.docx',
      content: {
        title: 'Multi',
        sections: [
          { heading: 'Section 1', body: 'Content 1' },
          { heading: 'Section 2', body: 'Content 2' },
          { heading: 'Section 3', body: 'Content 3' },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it('handles empty content object', async () => {
    mockSpawnSuccess(JSON.stringify({ path: 'output/empty.docx', pages: 0 }));
    const result = await generateDocument({
      output_path: 'output/empty.docx',
      content: {},
    });
    expect(result.success).toBe(true);
  });

  it('handles content with only title', async () => {
    mockSpawnSuccess(JSON.stringify({ path: 'output/title.docx' }));
    const result = await generateDocument({
      output_path: 'output/title.docx',
      content: { title: 'Only Title' },
    });
    expect(result.success).toBe(true);
  });

  // --- Path validation ---

  it('rejects path traversal in output_path', async () => {
    await expect(generateDocument({
      output_path: '../../../etc/passwd',
      content: { title: 'Evil' },
    })).rejects.toThrow();
  });

  it('rejects path traversal in template_path', async () => {
    await expect(generateDocument({
      template_path: '../../../etc/passwd',
      output_path: 'output/report.docx',
      content: { title: 'Evil' },
    })).rejects.toThrow();
  });

  it('rejects absolute paths in output_path', async () => {
    await expect(generateDocument({
      output_path: '/etc/passwd',
      content: { title: 'Evil' },
    })).rejects.toThrow();
  });

  it('rejects absolute paths in template_path', async () => {
    await expect(generateDocument({
      template_path: '/etc/passwd',
      output_path: 'output/report.docx',
      content: { title: 'Evil' },
    })).rejects.toThrow();
  });

  it('rejects paths outside allowed directories', async () => {
    await expect(generateDocument({
      output_path: 'evil/path.docx',
      content: { title: 'Evil' },
    })).rejects.toThrow();
  });

  it('accepts paths in workspace directory', async () => {
    mockSpawnSuccess(JSON.stringify({ path: 'workspace/doc.docx' }));
    const result = await generateDocument({
      output_path: 'workspace/doc.docx',
      content: { title: 'OK' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts paths in output directory', async () => {
    mockSpawnSuccess(JSON.stringify({ path: 'output/doc.docx' }));
    const result = await generateDocument({
      output_path: 'output/doc.docx',
      content: { title: 'OK' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts paths in artifacts directory', async () => {
    mockSpawnSuccess(JSON.stringify({ path: 'artifacts/doc.docx' }));
    const result = await generateDocument({
      output_path: 'artifacts/doc.docx',
      content: { title: 'OK' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts paths in tmp directory', async () => {
    mockSpawnSuccess(JSON.stringify({ path: 'tmp/doc.docx' }));
    const result = await generateDocument({
      output_path: 'tmp/doc.docx',
      content: { title: 'OK' },
    });
    expect(result.success).toBe(true);
  });

  // --- AC16: On missing python-docx: returns structured error ---

  it('returns structured error when python-docx is missing', async () => {
    mockSpawnFailure('ModuleNotFoundError: No module named docx', 1);
    const result = await generateDocument({
      output_path: 'output/report.docx',
      content: { title: 'Test' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('ModuleNotFoundError');
  });

  it('returns structured error for non-zero exit code', async () => {
    mockSpawnFailure('Error: template not found', 2);
    const result = await generateDocument({
      output_path: 'output/report.docx',
      content: { title: 'Test' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('template not found');
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
    const result = await generateDocument({
      output_path: 'output/doc.docx',
      content: { title: 'Test' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('ENOENT');
  });

  it('returns structured error on timeout', async () => {
    mockSpawnTimeout();
    const result = await generateDocument({
      output_path: 'output/doc.docx',
      content: { title: 'Test' },
    });
    expect(result.success).toBe(false);
  });

  // --- Stdin protocol verification ---

  it('stdin data is valid JSON with correct structure', async () => {
    const mockProc = mockSpawnSuccess(JSON.stringify({ path: 'output/doc.docx' }));
    await generateDocument({
      output_path: 'output/doc.docx',
      content: { title: 'Test', sections: [{ heading: 'H1', body: 'B1' }] },
      headings: [{ text: 'H', level: 1 }],
      paragraphs: ['P1'],
      template_path: 'workspace/tpl.docx',
    });
    const stdinData = (mockProc.stdin.write as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    const parsed = JSON.parse(stdinData);
    expect(parsed).toHaveProperty('output_path');
    expect(parsed).toHaveProperty('template_path');
    expect(parsed).toHaveProperty('content');
    expect(parsed).toHaveProperty('headings');
    expect(parsed).toHaveProperty('paragraphs');
  });

  it('stdin does not use positional args (JSON stdin only)', async () => {
    mockSpawnSuccess(JSON.stringify({ path: 'output/doc.docx' }));
    await generateDocument({
      output_path: 'output/doc.docx',
      content: { title: 'Test' },
    });
    const callArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
    const args = callArgs![1] as string[];
    // Args should be ['-c', pythonScript] - no file paths as positional args
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('-c');
  });

  // --- Multiple field combinations ---

  it('handles all input fields together', async () => {
    mockSpawnSuccess(JSON.stringify({ path: 'output/full.docx', pages: 10 }));
    const result = await generateDocument({
      output_path: 'output/full.docx',
      template_path: 'workspace/tpl.docx',
      title: 'Full Doc',
      paragraphs: ['Para 1', 'Para 2'],
      headings: [{ text: 'H1', level: 1 }, { text: 'H2', level: 2 }],
      content: { title: 'Content Title', sections: [{ heading: 'S1', body: 'B1' }] },
    });
    expect(result.success).toBe(true);
  });

  it('uses title field when content.title is absent', async () => {
    const mockProc = mockSpawnSuccess(JSON.stringify({ path: 'output/doc.docx' }));
    await generateDocument({
      output_path: 'output/doc.docx',
      title: 'Direct Title',
    });
    const stdinData = (mockProc.stdin.write as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    const parsed = JSON.parse(stdinData);
    expect(parsed.title).toBe('Direct Title');
  });
});
