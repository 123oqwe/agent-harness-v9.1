import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentAuthoringError,
  compileAgent,
  compileAgentText,
  discoverAgents,
  parseFrontmatter,
  splitFrontmatter,
  validateAgentNode,
  type AgentGraphNode,
} from '../../tools/agent-authoring.js';

const REGISTRY = ['read_file', 'search_files', 'execute_command', 'write_file'];

const VALID_MD = `---
name: researcher
description: Research and summarize topics
tool_grant_refs: [search_files, read_file]
disallowed_tool_refs: [execute_command]
isolation: worktree
effort: high
memory_scope: workspace
---
You are a research agent.
Return structured findings.
`;

function mdFor(name: string, extraFrontmatter = ''): string {
  return `---
name: ${name}
description: ${name} agent
${extraFrontmatter}---
You are ${name}.
`;
}

describe('AH-AGENT-AUTHORING-001 frontmatter splitting', () => {
  it('extracts the frontmatter block and the body', () => {
    const { frontmatter, body } = splitFrontmatter(VALID_MD);
    expect(frontmatter).toContain('name: researcher');
    expect(frontmatter).toContain('effort: high');
    expect(body).toContain('You are a research agent.');
  });

  it('requires the opening --- delimiter', () => {
    expect(() => splitFrontmatter('no frontmatter here')).toThrow(AgentAuthoringError);
  });

  it('rejects an unterminated frontmatter block', () => {
    expect(() => splitFrontmatter('---\nname: x\n')).toThrow(AgentAuthoringError);
  });

  it('tolerates a byte-order mark before the opener', () => {
    const { frontmatter } = splitFrontmatter('﻿---\nname: x\n---\nbody');
    expect(frontmatter).toContain('name: x');
  });
});

describe('AH-AGENT-AUTHORING-001 frontmatter parsing (minimal YAML subset)', () => {
  it('parses scalars, quoted values, numbers, booleans, and inline lists', () => {
    const parsed = parseFrontmatter(
      [
        'name: researcher',
        'description: "has a # in the middle"',
        'quoted: \'single quotes\'',
        'count: 3',
        'enabled: true',
        'tool_grant_refs: [read_file, search_files]',
      ].join('\n'),
    );
    expect(parsed.name).toBe('researcher');
    expect(parsed.description).toBe('has a # in the middle');
    expect(parsed.quoted).toBe('single quotes');
    expect(parsed.count).toBe(3);
    expect(parsed.enabled).toBe(true);
    expect(parsed.tool_grant_refs).toEqual(['read_file', 'search_files']);
  });

  it('parses indented block lists', () => {
    const parsed = parseFrontmatter(
      ['tool_grant_refs:', '  - read_file', '  - search_files', 'disallowed_tool_refs:', '  - execute_command'].join('\n'),
    );
    expect(parsed.tool_grant_refs).toEqual(['read_file', 'search_files']);
    expect(parsed.disallowed_tool_refs).toEqual(['execute_command']);
  });

  it('skips blank lines and comments', () => {
    const parsed = parseFrontmatter(['# header comment', '', 'name: researcher # trailing', ''].join('\n'));
    expect(parsed.name).toBe('researcher');
  });

  it('rejects unsupported frontmatter (nested mappings, multiline scalars)', () => {
    expect(() => parseFrontmatter('hooks:\n  ref: x')).toThrow(AgentAuthoringError);
    expect(() => parseFrontmatter('prompt: |\n  line one')).toThrow(AgentAuthoringError);
  });
});

describe('AH-AGENT-AUTHORING-001 compileAgent', () => {
  it('maps frontmatter to AgentGraph node fields and body to system_prompt', () => {
    const node = compileAgentText(VALID_MD, { tool_grant_registry: REGISTRY });
    expect(node.node_id).toBe('researcher');
    expect(node.name).toBe('researcher');
    expect(node.description).toBe('Research and summarize topics');
    expect(node.system_prompt).toBe('You are a research agent.\nReturn structured findings.');
    expect(node.tool_grant_refs).toEqual(['search_files', 'read_file']);
    expect(node.source).toBe('<inline>');
    // G-CC1 fields pass through.
    expect(node.agent_config).toMatchObject({
      isolation: 'worktree',
      effort: 'high',
      memory_scope: 'workspace',
      disallowed_tool_refs: ['execute_command'],
    });
  });

  it('compileAgent(md_path) reads the Markdown file from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-authoring-'));
    try {
      const path = join(dir, 'researcher.md');
      writeFileSync(path, VALID_MD);
      const node = compileAgent(path, { tool_grant_registry: REGISTRY });
      expect(node.name).toBe('researcher');
      expect(node.source).toBe(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('block-list frontmatter compiles identically to inline lists', () => {
    const node = compileAgentText(
      `---
name: helper
description: helper agent
tool_grant_refs:
  - read_file
  - search_files
---
Body
`,
      { tool_grant_registry: REGISTRY },
    );
    expect(node.tool_grant_refs).toEqual(['read_file', 'search_files']);
  });
});

describe('AH-AGENT-AUTHORING-001 validation', () => {
  it('requires name and description', () => {
    expect(() => compileAgentText('---\ndescription: x\n---\n', { tool_grant_registry: REGISTRY })).toThrow(
      'name is required',
    );
    expect(() => compileAgentText('---\nname: x\n---\n', { tool_grant_registry: REGISTRY })).toThrow(
      'description is required',
    );
  });

  it('compiler cannot grant a tool that is not in the ToolGrant registry', () => {
    expect(() =>
      compileAgentText(mdFor('rogue', 'tool_grant_refs: [rm_rf]\n'), { tool_grant_registry: REGISTRY }),
    ).toThrow('tool_grant_refs contains unregistered tool: rm_rf');
  });

  it('validateAgentNode reports registry and G-CC1 violations as errors', () => {
    const good = compileAgentText(VALID_MD, { tool_grant_registry: REGISTRY });
    expect(validateAgentNode(good, REGISTRY)).toEqual([]);

    const bad: AgentGraphNode = {
      ...good,
      tool_grant_refs: ['rm_rf'],
      agent_config: {
        isolation: 'sandbox' as unknown as Exclude<AgentGraphNode['agent_config']['isolation'], undefined>,
        effort: 'turbo' as never,
      },
    };
    const errors = validateAgentNode(bad, REGISTRY);
    expect(errors).toContain('tool_grant_refs contains unregistered tool: rm_rf');
    expect(errors).toContain('invalid isolation: sandbox');
    expect(errors).toContain('invalid effort: turbo');
  });

  it('rejects empty hooks_ref and empty memory_scope', () => {
    const base = compileAgentText(VALID_MD, { tool_grant_registry: REGISTRY });
    const errors = validateAgentNode(
      { ...base, agent_config: { hooks_ref: '  ', memory_scope: '' } },
      REGISTRY,
    );
    expect(errors).toContain('hooks_ref must be non-empty');
    expect(errors).toContain('memory_scope must be non-empty');
  });

  it('rejects non-string name', () => {
    expect(() => compileAgentText('---\nname: 42\ndescription: x\n---\n', { tool_grant_registry: REGISTRY })).toThrow(
      AgentAuthoringError,
    );
  });
});

describe('AH-AGENT-AUTHORING-001 security invariant: deny wins', () => {
  it('a denied grant is excluded from effective_tool_refs, not silently granted', () => {
    const node = compileAgentText(
      mdFor('restricted', 'tool_grant_refs: [read_file, execute_command]\ndisallowed_tool_refs: [execute_command]\n'),
      { tool_grant_registry: REGISTRY },
    );
    expect(node.tool_grant_refs).toEqual(['read_file', 'execute_command']);
    expect(node.disallowed_tool_refs).toEqual(['execute_command']);
    expect(node.effective_tool_refs).toEqual(['read_file']);
  });

  it('deny-wins is a derivation, not a hard error — the effective set carries it', () => {
    // Granting a tool that is also disallowed compiles fine; the compiled node
    // never grants it (deny wins over grant).
    const node = compileAgentText(
      mdFor('overlap', 'tool_grant_refs: [write_file]\ndisallowed_tool_refs: [write_file]\n'),
      { tool_grant_registry: REGISTRY },
    );
    expect(node.effective_tool_refs).toEqual([]);
  });

  it('disallowed refs do not need to be in the registry — they only ever deny', () => {
    const node = compileAgentText(
      mdFor('blocked', 'tool_grant_refs: [read_file]\ndisallowed_tool_refs: [unknown_tool]\n'),
      { tool_grant_registry: REGISTRY },
    );
    expect(node.effective_tool_refs).toEqual(['read_file']);
  });
});

describe('AH-AGENT-AUTHORING-001 discoverAgents', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-authoring-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeAgent(subPath: string, content: string): string {
    const path = join(dir, subPath);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
    return path;
  }

  it('scans project agents/ and global agents/, project first, sorted', () => {
    writeAgent('agents/a.md', mdFor('alpha', 'tool_grant_refs: [read_file]\n'));
    writeAgent('agents/b.md', mdFor('bravo', 'tool_grant_refs: [read_file]\n'));
    writeAgent('agents/notes.txt', 'not an agent');
    writeAgent('global/c.md', mdFor('charlie', 'tool_grant_refs: [read_file]\n'));

    const nodes = discoverAgents(
      { project_dir: join(dir, 'agents'), global_dir: join(dir, 'global') },
      { tool_grant_registry: REGISTRY },
    );
    expect(nodes.map((n) => n.name)).toEqual(['alpha', 'bravo', 'charlie']);
    expect(nodes.map((n) => n.source)).toEqual([
      join(dir, 'agents/a.md'),
      join(dir, 'agents/b.md'),
      join(dir, 'global/c.md'),
    ]);
  });

  it('de-duplicates by path when project and global directories overlap', () => {
    writeAgent('agents/a.md', mdFor('alpha', 'tool_grant_refs: [read_file]\n'));
    const nodes = discoverAgents(
      { project_dir: join(dir, 'agents'), global_dir: join(dir, 'agents') },
      { tool_grant_registry: REGISTRY },
    );
    expect(nodes).toHaveLength(1);
  });

  it('skips missing directories', () => {
    const nodes = discoverAgents(
      { project_dir: join(dir, 'does-not-exist'), global_dir: join(dir, 'also-missing') },
      { tool_grant_registry: REGISTRY },
    );
    expect(nodes).toEqual([]);
  });

  it('propagates compile errors for malformed agent files', () => {
    writeAgent('agents/broken.md', 'no frontmatter at all');
    expect(() =>
      discoverAgents({ project_dir: join(dir, 'agents'), global_dir: join(dir, 'global') }, { tool_grant_registry: REGISTRY }),
    ).toThrow(AgentAuthoringError);
  });
});

describe('AH-AGENT-AUTHORING-001 privacy', () => {
  it('the compiler has no network surface — agent files never leave the machine', () => {
    const source = readFileSync(new URL('../../tools/agent-authoring.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from 'node:(http|https|net|tls|dgram)'/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/new WebSocket/);
    // Local reads only: fs and path are the sole external modules.
    expect(source).toMatch(/from 'node:fs'/);
  });
});
