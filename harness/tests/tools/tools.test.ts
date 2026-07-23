import { describe, it, expect } from 'vitest';
import { VirtualFilesystem } from '../../vfs/virtual-filesystem.js';
import { Sandbox, type SandboxConfig } from '../../runtime/sandbox.js';
import { createArtifact } from '../../tools/create-artifact.js';
import { createAskUserTool } from '../../tools/ask-user.js';
import { listDirectory } from '../../tools/list-directory.js';
import { readFile } from '../../tools/read-file.js';
import { writeFile } from '../../tools/write-file.js';
import { editFile } from '../../tools/edit-file.js';
import { searchFiles } from '../../tools/search-files.js';
import { executeCommand } from '../../tools/execute-command.js';
import { parseDocument } from '../../ingestion/parse-document.js';
import { ToolRegistry, type ToolSpec } from '../../tools/tool-registry.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function vfs(): VirtualFilesystem {
  return new VirtualFilesystem({ root: '/workspace' });
}

function sandboxCfg(): SandboxConfig {
  return {
    allowedExecutables: ['/bin/echo', '/bin/cat'],
    workingDirectory: mkdtempSync(join(tmpdir(), 'tool-test-')),
    envAllowlist: ['PATH'],
    timeoutMs: 5000,
    maxOutputBytes: 1024 * 1024,
    networkDenied: true,
  };
}

function toolSpec(name: string): ToolSpec {
  return {
    name, summary: `${name} tool`, tags: ['tool'], version: '1.0.0',
    domains: ['general'], implementation_status: 'implemented',
    input_schema_ref: 'schemas/input.json', output_schema_ref: 'schemas/output.json',
    effect_model: {}, risk_feature_extractor: 'extractor',
    preconditions: [], postconditions: [], timeout_policy: {}, cancellation_policy: {},
    retry_policy: {}, idempotency_policy: {}, sandbox_policy: {}, network_policy: {},
    credential_requirements: [], data_egress_policy: {},
    receipt_schema_ref: 'schemas/receipt.json', verification_adapter: 'adapter',
    maturity: 'sandbox_verified',
  };
}

describe('AH-TOOLS-001: all nine tools through VFS/Sandbox', () => {
  it('create_artifact writes through VFS and returns digest', () => {
    const v = vfs();
    const result = createArtifact(v, { path: '/scratch/artifact.txt', content: 'test content', artifact_type: 'text' });
    expect(result.digest).toBeTruthy();
    expect(result.size).toBe(12);
    expect(v.read('/scratch/artifact.txt')).toBe('test content');
  });

  it('ask_user creates cancellable prompt', async () => {
    const tool = createAskUserTool(async () => 'user answer');
    const result = await tool.execute({ question: 'What?' });
    expect(result.answer).toBe('user answer');
    expect(result.cancelled).toBe(false);
  });

  it('ask_user times out without handler', async () => {
    const tool = createAskUserTool();
    const result = await tool.execute({ question: 'What?' });
    expect(result.answer).toBeNull();
    expect(result.timed_out).toBe(true);
  });

  it('list_directory lists VFS entries with pagination', () => {
    const v = vfs();
    v.write('/scratch/a.txt', 'a');
    v.write('/scratch/b.txt', 'b');
    v.write('/scratch/c.txt', 'c');
    const result = listDirectory(v, { path: '/scratch/', limit: 2, offset: 0 });
    expect(result.entries.length).toBe(2);
    expect(result.has_more).toBe(true);
    expect(result.total).toBe(3);
  });

  it('read_file reads through VFS with offset and limit', () => {
    const v = vfs();
    v.write('/scratch/test.txt', 'Hello World');
    const result = readFile(v, { path: '/scratch/test.txt', offset: 0, limit: 5 });
    expect(result.content).toBe('Hello');
    expect(result.truncated).toBe(true);
  });

  it('read_file rejects binary encoding', () => {
    const v = vfs();
    expect(() => readFile(v, { path: '/scratch/test.txt', encoding: 'binary' })).toThrow(/binary/i);
  });

  it('write_file writes through VFS with version', () => {
    const v = vfs();
    const result = writeFile(v, { path: '/scratch/test.txt', content: 'hello' });
    expect(result.version).toBeTruthy();
    expect(v.read('/scratch/test.txt')).toBe('hello');
  });

  it('write_file enforces expected version', () => {
    const v = vfs();
    v.write('/scratch/test.txt', 'v1');
    const version = v.getVersion('/scratch/test.txt');
    v.write('/scratch/test.txt', 'v2');
    expect(() => writeFile(v, { path: '/scratch/test.txt', content: 'v3', expected_version: version })).toThrow(/conflict/i);
  });

  it('edit_file applies exact patch', () => {
    const v = vfs();
    v.write('/scratch/test.txt', 'Hello World');
    const result = editFile(v, { path: '/scratch/test.txt', old_text: 'World', new_text: 'Universe' });
    expect(v.read('/scratch/test.txt')).toBe('Hello Universe');
    expect(result.edits_applied).toBe(1);
  });

  it('edit_file detects stale content', () => {
    const v = vfs();
    v.write('/scratch/test.txt', 'Hello World');
    expect(() => editFile(v, { path: '/scratch/test.txt', old_text: 'nonexistent', new_text: 'x' })).toThrow(/stale|conflict/i);
  });

  it('search_files searches VFS content', () => {
    const v = vfs();
    v.write('/scratch/a.txt', 'hello world\nfoo bar');
    v.write('/scratch/b.txt', 'hello again');
    const result = searchFiles(v, { directory: '/scratch/', pattern: 'hello' });
    expect(result.matches.length).toBe(2);
    expect(result.matches[0].line).toContain('hello');
  });

  it('search_files respects limit', () => {
    const v = vfs();
    v.write('/scratch/a.txt', 'match\nmatch');
    v.write('/scratch/b.txt', 'match');
    const result = searchFiles(v, { directory: '/scratch/', pattern: 'match', limit: 2 });
    expect(result.matches.length).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('execute_command runs through Sandbox', () => {
    const s = new Sandbox(sandboxCfg());
    const result = executeCommand(s, { executable: '/bin/echo', args: ['hello'] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('execute_command rejects non-allowlisted executable', () => {
    const s = new Sandbox(sandboxCfg());
    expect(() => executeCommand(s, { executable: '/bin/rm', args: ['-rf', '/'] })).toThrow(/allowlist/i);
  });

  it('parse_document parses text', () => {
    const result = parseDocument('Hello\fWorld', { path: 'test.txt', format: 'txt' });
    expect(result.sections.length).toBe(2);
    expect(result.sections[0].page).toBe(1);
    expect(result.total_pages).toBe(2);
  });

  it('parse_document parses markdown', () => {
    const md = '# Title\n## Section 1\nContent 1\n## Section 2\nContent 2';
    const result = parseDocument(md, { path: 'test.md', format: 'md' });
    expect(result.sections.length).toBe(3);
    expect(result.format).toBe('md');
  });

  it('parse_document parses JSON', () => {
    const result = parseDocument('{"key":"value"}', { path: 'test.json', format: 'json' });
    expect(result.sections.length).toBe(1);
    expect(result.format).toBe('json');
  });

  it('parse_document parses CSV', () => {
    const result = parseDocument('a,b,c\n1,2,3', { path: 'test.csv', format: 'csv' });
    expect(result.sections.length).toBe(2);
    expect(result.format).toBe('csv');
  });
});

describe('AH-TOOLS-001: register all nine in ToolRegistry', () => {
  it('all nine tools register successfully', () => {
    const reg = new ToolRegistry();
    const toolNames = [
      'create_artifact', 'ask_user', 'list_directory', 'read_file',
      'write_file', 'edit_file', 'search_files', 'execute_command',
      'parse_document',
    ];
    for (const name of toolNames) {
      reg.register(toolSpec(name));
    }
    expect(reg.count()).toBe(9);
    for (const name of toolNames) {
      expect(reg.has(name)).toBe(true);
    }
  });

  it('tool_search discovers all nine', () => {
    const reg = new ToolRegistry();
    const toolNames = [
      'create_artifact', 'ask_user', 'list_directory', 'read_file',
      'write_file', 'edit_file', 'search_files', 'execute_command',
      'parse_document',
    ];
    for (const name of toolNames) {
      reg.register(toolSpec(name));
    }
    const results = reg.search({});
    expect(results.length).toBe(9);
  });
});
