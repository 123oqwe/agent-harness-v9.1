/**
 * AH-AGENT-AUTHORING-001: agent Markdown authoring format with a frontmatter
 * compiler.
 *
 * Agents are authored as Markdown files with YAML frontmatter:
 *
 *   ---
 *   name: researcher
 *   description: Research and summarize topics
 *   tool_grant_refs: [search_files, read_file]
 *   disallowed_tool_refs: [execute_command]
 *   isolation: worktree
 *   effort: high
 *   memory_scope: workspace
 *   ---
 *   You are a research agent...
 *
 * The compiler maps frontmatter to AgentGraph node fields (G-PI1), the body to
 * system_prompt, validates the node (required fields, tool_grant_refs against
 * the ToolGrant registry, G-CC1 values), and applies the security invariant:
 * disallowed_tool_refs DENY WINS over tool_grant_refs (the compiled
 * effective_tool_refs excludes any denied grant).
 *
 * Privacy: the compiler only reads local files (project agents/ + global
 * ~/.harness/agents/) and never sends agent Markdown to any external service.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentConfig } from '../router/multiagent-dag.js';

/** Frontmatter surface the compiler understands (G-CC1 included). */
export interface AgentFrontmatter {
  name: string;
  description: string;
  tool_grant_refs?: string[];
  disallowed_tool_refs?: string[];
  isolation?: 'worktree' | 'none';
  hooks_ref?: string;
  memory_scope?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
}

/** Spec output: a compiled AgentGraph node. */
export interface AgentGraphNode {
  node_id: string;
  name: string;
  description: string;
  /** The Markdown body. */
  system_prompt: string;
  tool_grant_refs: string[];
  disallowed_tool_refs: string[];
  /** tool_grant_refs minus disallowed_tool_refs — deny wins. */
  effective_tool_refs: string[];
  /** G-CC1 per-agent config. */
  agent_config: AgentConfig;
  source: string;
}

export class AgentAuthoringError extends Error {
  readonly name = 'AgentAuthoringError';
  constructor(message: string) {
    super(message);
  }
}

/** Split `---`-delimited YAML frontmatter from the Markdown body. */
export function splitFrontmatter(md: string): { frontmatter: string; body: string } {
  const text = md.replace(/^\uFEFF/u, '');
  const lines = text.split('\n');
  if (lines[0]!.trim() !== '---') {
    throw new AgentAuthoringError('agent file must start with a --- frontmatter delimiter');
  }
  const closeIndex = lines.findIndex((line, idx) => idx > 0 && line.trim() === '---');
  if (closeIndex === -1) throw new AgentAuthoringError('unterminated frontmatter block');
  return {
    frontmatter: lines.slice(1, closeIndex).join('\n'),
    body: lines.slice(closeIndex + 1).join('\n'),
  };
}

function parseScalar(raw: string): unknown {
  const trimmed = raw.trim();
  // Comments are stripped from unquoted values only — a quoted string may
  // legitimately contain `#`.
  const quoted =
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")));
  const value = quoted ? trimmed.slice(1, -1) : trimmed.split(/\s+#/u)[0]!.trim();
  if (quoted) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/u.test(value)) return Number(value);
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((item) => parseScalar(item.trim()));
  }
  return value;
}

/**
 * Minimal YAML-subset parser for the documented frontmatter fields: scalar
 * keys, quoted strings, inline flow lists, and indented block lists. Anything
 * else (multiline scalars, nested mappings) is rejected with a clear error.
 */
export function parseFrontmatter(yamlText: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yamlText.split(/\r?\n/u);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    i += 1;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/u.exec(line);
    if (!match) throw new AgentAuthoringError(`unsupported frontmatter line: ${trimmed}`);
    const key = match[1]!;
    const rest = match[2]!.trim();
    if (rest === '') {
      const values: unknown[] = [];
      let j = i;
      while (j < lines.length) {
        const itemMatch = /^\s*-\s+(.*)$/u.exec(lines[j]!);
        if (!itemMatch) break;
        values.push(parseScalar(itemMatch[1]!));
        j += 1;
      }
      if (values.length > 0) {
        result[key] = values;
        i = j;
        continue;
      }
      result[key] = '';
      continue;
    }
    if (rest === '|' || rest === '>') {
      throw new AgentAuthoringError(`multiline scalar not supported: ${key}`);
    }
    result[key] = parseScalar(rest);
  }
  return result;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new AgentAuthoringError(`${label} must be a string`);
  return value;
}

function asStringList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new AgentAuthoringError(`${label} must be a list of strings`);
  }
  return value;
}

function buildNode(raw: Record<string, unknown>, body: string, registry: string[], source: string): AgentGraphNode {
  // A missing field is treated as empty so validateAgentNode reports it as a
  // required-field error; a wrong-typed value still fails here as a type error.
  const name = asString(raw.name ?? '', 'name');
  const description = asString(raw.description ?? '', 'description');
  const toolGrants = asStringList(raw.tool_grant_refs, 'tool_grant_refs');
  const disallowed = asStringList(raw.disallowed_tool_refs, 'disallowed_tool_refs');
  const denied = new Set(disallowed);

  const agentConfig: AgentConfig = {};
  // The guards prove undefined, but indexed access under
  // exactOptionalPropertyTypes still widens to `| undefined` — strip it.
  if (raw.isolation !== undefined) {
    agentConfig.isolation = raw.isolation as Exclude<AgentConfig['isolation'], undefined>;
  }
  if (raw.hooks_ref !== undefined) agentConfig.hooks_ref = asString(raw.hooks_ref, 'hooks_ref');
  if (raw.memory_scope !== undefined) agentConfig.memory_scope = asString(raw.memory_scope, 'memory_scope');
  if (raw.effort !== undefined) {
    agentConfig.effort = raw.effort as Exclude<AgentConfig['effort'], undefined>;
  }
  agentConfig.disallowed_tool_refs = disallowed;

  return {
    node_id: name,
    name,
    description,
    system_prompt: body.trim(),
    tool_grant_refs: toolGrants,
    disallowed_tool_refs: disallowed,
    effective_tool_refs: toolGrants.filter((ref) => !denied.has(ref)),
    agent_config: agentConfig,
    source,
  };
}

/** Compile frontmatter text (already parsed) into a node; validation errors throw. */
export function compileAgentText(
  md: string,
  options: { tool_grant_registry: string[]; source?: string },
): AgentGraphNode {
  const { frontmatter, body } = splitFrontmatter(md);
  const raw = parseFrontmatter(frontmatter);
  const node = buildNode(raw, body, options.tool_grant_registry, options.source ?? '<inline>');
  const errors = validateAgentNode(node, options.tool_grant_registry);
  if (errors.length > 0) throw new AgentAuthoringError(errors.join('; '));
  return node;
}

/** Spec API: compileAgent(md_path) reads the Markdown file and compiles it. */
export function compileAgent(mdPath: string, options: { tool_grant_registry: string[] }): AgentGraphNode {
  return compileAgentText(readFileSync(mdPath, 'utf8'), { ...options, source: mdPath });
}

/** Validation: required fields, registry membership, and G-CC1 values. */
export function validateAgentNode(node: AgentGraphNode, toolGrantRegistry: string[]): string[] {
  const errors: string[] = [];
  if (node.name.trim().length === 0) errors.push('name is required');
  if (node.description.trim().length === 0) errors.push('description is required');
  for (const ref of node.tool_grant_refs) {
    if (!toolGrantRegistry.includes(ref)) errors.push(`tool_grant_refs contains unregistered tool: ${ref}`);
  }
  for (const ref of [...node.tool_grant_refs, ...node.disallowed_tool_refs]) {
    if (ref.trim().length === 0) errors.push('tool refs must be non-empty');
  }
  const cfg = node.agent_config;
  if (cfg.isolation !== undefined && !['worktree', 'none'].includes(cfg.isolation)) {
    errors.push(`invalid isolation: ${cfg.isolation}`);
  }
  if (cfg.effort !== undefined && !['low', 'medium', 'high', 'xhigh'].includes(cfg.effort)) {
    errors.push(`invalid effort: ${cfg.effort}`);
  }
  if (cfg.hooks_ref !== undefined && cfg.hooks_ref.trim().length === 0) errors.push('hooks_ref must be non-empty');
  if (cfg.memory_scope !== undefined && cfg.memory_scope.trim().length === 0) errors.push('memory_scope must be non-empty');
  return errors;
}

/**
 * Discover agents by scanning the project agents/ directory and the global
 * ~/.harness/agents/ directory (project first, then global, both sorted and
 * de-duplicated by path). Local files only — never sent to external services.
 */
export function discoverAgents(
  directories: { project_dir: string; global_dir: string },
  options: { tool_grant_registry: string[] },
): AgentGraphNode[] {
  const nodes: AgentGraphNode[] = [];
  const visited = new Set<string>();
  for (const directory of [directories.project_dir, directories.global_dir]) {
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const path = join(directory, entry.name);
      if (visited.has(path)) continue;
      visited.add(path);
      nodes.push(compileAgent(path, { tool_grant_registry: options.tool_grant_registry }));
    }
  }
  return nodes;
}
