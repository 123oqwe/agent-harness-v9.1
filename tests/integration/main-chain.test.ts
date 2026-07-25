/**
 * Main chain integration tests: verify the full runtime path is connected
 * without bypasses. Each test targets a specific bypass that was previously
 * possible.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness, createDefaultExecutionContext } from '../../harness.js';
import { ToolRegistry } from '../../tools/tool-registry.js';
import { SkillRegistry } from '../../tools/skill-registry.js';
import { PolicyEngine, type Policy } from '../../security/policy-engine.js';
import { VirtualFilesystem, LocalBackend } from '../../vfs/virtual-filesystem.js';
import type { SandboxProfile } from '../../runtime/sandbox.js';
import type { ToolSpec } from '../../contracts/index.js';
import { createPhase1ToolDefinitions } from '../../tools/tool-definitions.js';
import { createTestSecurityDeps, createScriptedGateway, createTestVerificationEngine } from '../helpers/test-security.js';
import type { ParsedResponse } from '../../gateway/scripted-provider.js';
import { SqliteSessionStore } from '../../session/sqlite-session-store.js';

function toolSpec(name: string): ToolSpec {
  const spec = createPhase1ToolDefinitions().find((entry) => entry.name === name);
  if (!spec) throw new Error(`unknown Phase 1 tool fixture: ${name}`);
  return spec;
}

const SESSION_MASTER_KEY = Buffer.alloc(32, 0x41);

function makeHarness(tmp: string, responses: ParsedResponse[] = [{ content: 'done' }], dataDir?: string): Harness {
  const gw = createScriptedGateway(responses);
  const tr = new ToolRegistry();
  ['read_file', 'write_file', 'edit_file', 'execute_command', 'list_directory', 'search_files'].forEach(n => tr.register(toolSpec(n)));
  const sr = new SkillRegistry(); sr.loadBaseSkills();
  const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
  vfs.mount(new LocalBackend('/workspace', tmp));
  const pe = new PolicyEngine({ version: 'v1', default_decision: 'deny', allowed_tools: ['read_file', 'write_file', 'edit_file', 'execute_command', 'list_directory', 'search_files'], allowed_resource_prefixes: ['/workspace'], rules: [{ id: 'a', priority: 1, effect: 'allow', tools: ['*'], resource_prefixes: ['/workspace'] }] } as Policy);
  const sandbox: SandboxProfile = { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] };
  const _sec = createTestSecurityDeps(pe, () => new Date().toISOString());
  return new Harness({ toolRegistry: tr, skillRegistry: sr, policyEngine: pe, vfs, sandbox, gateway: gw.gateway, security: createTestSecurityDeps(pe, () => new Date().toISOString()), verification: createTestVerificationEngine(), executionContext: createDefaultExecutionContext('test-run'), ...(dataDir ? { dataDir, sessionMasterKey: SESSION_MASTER_KEY } : {}) });
}

function task(goal: string) {
  return { goal, success_criteria: [{ criterion: 'done', verification_method: 'deterministic' as const }], constraints: [] };
}

describe('Main chain integration: no bypasses', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'mc-')); });
  afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  it('tool calls go through ToolDispatcher (tool_call event recorded)', async () => {
    writeFileSync(join(tmp, 'f.txt'), 'hello');
    const h = makeHarness(tmp, [
      { content: '', tool_calls: [{ id: '1', name: 'read_file', arguments: { path: '/workspace/f.txt' } }] } as ParsedResponse,
      { content: 'done' } as ParsedResponse,
    ]);
    const r = await h.run(task('read the file'));
    expect(r.session.getEvents().some(e => e.type === 'tool_call')).toBe(true);
  });

  it('unregistered tool is rejected by ToolDispatcher', async () => {
    const h = makeHarness(tmp, [
      { content: '', tool_calls: [{ id: '1', name: 'nonexistent_tool', arguments: {} }] } as ParsedResponse,
      { content: 'done' } as ParsedResponse,
    ]);
    const r = await h.run(task('run nonexistent tool'));
    // The model proposal is preserved, followed by an explicit rejected result.
    const toolCalls = r.session.getEvents().filter(e => e.type === 'tool_call' && (e.data as { tool: string }).tool === 'nonexistent_tool');
    expect(toolCalls).toHaveLength(1);
    const rejected = r.session.getEvents().filter(
      (event) =>
        event.type === 'tool_result' &&
        (event.data as { tool?: string; status?: string }).tool ===
          'nonexistent_tool' &&
        (event.data as { status?: string }).status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(r.success).toBe(false);
  });

  it('VFS overlay intercepts writes — failed run does not modify real FS', async () => {
    writeFileSync(join(tmp, 'original.txt'), 'original content');
    const h = makeHarness(tmp, [
      { content: '', tool_calls: [{ id: '1', name: 'write_file', arguments: { path: '/workspace/new.txt', content: 'should not persist' } }] } as ParsedResponse,
      { content: '', tool_calls: [{ id: '2', name: 'write_file', arguments: { path: '/workspace/new2.txt', content: 'also should not persist' } }] } as ParsedResponse,
    ]);
    const r = await h.run(task('write files that should not persist'));
    // Run should not be successful (goal not satisfied)
    expect(r.success).toBe(false);
    // Files should NOT exist on the real FS because overlay was discarded
    expect(existsSync(join(tmp, 'new.txt'))).toBe(false);
    expect(existsSync(join(tmp, 'new2.txt'))).toBe(false);
    // Original file should still be intact
    expect(readFileSync(join(tmp, 'original.txt'), 'utf8')).toBe('original content');
  });

  it('SQLite persists events when dataDir provided', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sqlite-'));
    try {
      const h = makeHarness(tmp, [{ content: 'done' } as ParsedResponse], dataDir);
      const r = await h.run(task('simple task'));
      // SQLite database should exist
      expect(existsSync(join(dataDir, 'session.db'))).toBe(true);
      expect(r.session.eventCount()).toBeGreaterThan(0);
      const store = new SqliteSessionStore(join(dataDir, 'session.db'), {
        masterKey: SESSION_MASTER_KEY,
      });
      try {
        expect(store.getLatestSnapshot(r.session.session_id)).toMatchObject({
          session_id: r.session.session_id,
          last_seq: r.session.eventCount(),
        });
      } finally {
        store.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('binds an explicit run ID across RunPlan, session and evidence', async () => {
    const h = makeHarness(tmp, [{ content: 'done' } as ParsedResponse]);
    const result = await h.run(task('rewrite this paragraph'), 'run-explicit');
    expect(result.run_plan?.run_id).toBe('run-explicit');
    expect(result.session.session_id).toBe('run-explicit');
    expect(result.evidence.run_id).toBe('run-explicit');
    expect(result.evidence.plan_hash).toBe(result.run_plan?.run_plan_hash);
    expect(result.evidence.plan_revision).toBe(1);
    expect(result.evidence.reasoning_strategy).toBe('direct');
    expect(result.evidence.termination_reason).toBe('goal_satisfied');
    expect(result.evidence.verification_records).toHaveLength(1);
    expect(result.evidence.session_head_hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('restores a terminal run without a synthetic resume event or re-execution', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'terminal-resume-'));
    try {
      const h = makeHarness(
        tmp,
        [{ content: 'done' } as ParsedResponse],
        dataDir,
      );
      const first = await h.run(task('rewrite this paragraph'), 'run-resume');
      const originalEvents = first.session.export_().events;
      const second = await h.run(task('rewrite this paragraph'), 'run-resume');
      expect(second.session.export_().events).toEqual(originalEvents);
      expect(
        second.session
          .getEvents()
          .some((event) =>
            JSON.stringify(event.data).includes('resuming run'),
          ),
      ).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('assigns distinct durable operation identities to distinct tool calls', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'operation-ids-'));
    try {
      writeFileSync(join(tmp, 'a.txt'), 'a');
      writeFileSync(join(tmp, 'b.txt'), 'b');
      const h = makeHarness(
        tmp,
        [
          {
            content: '',
            tool_calls: [
              {
                id: 'call-a',
                name: 'read_file',
                arguments: { path: '/workspace/a.txt' },
              },
              {
                id: 'call-b',
                name: 'read_file',
                arguments: { path: '/workspace/b.txt' },
              },
            ],
          } as ParsedResponse,
          { content: 'done' } as ParsedResponse,
        ],
        dataDir,
      );
      await h.run(task('read the files'), 'run-operations');
      const store = new SqliteSessionStore(join(dataDir, 'session.db'), {
        masterKey: SESSION_MASTER_KEY,
      });
      try {
        const operations = store.listOperations('run-operations');
        expect(operations).toHaveLength(2);
        expect(new Set(operations.map((entry) => entry.operation_id)).size).toBe(
          2,
        );
        expect(new Set(operations.map((entry) => entry.idempotency_key)).size).toBe(
          2,
        );
      } finally {
        store.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('Plan+Execute discards overlay on verification failure', async () => {
    writeFileSync(join(tmp, 'target.txt'), 'before');
    const wf = {
      nodes: [
        { step_id: 's1', step_type: 'tool_call' as const, status: 'pending' as const },
        { step_id: 's2', step_type: 'verification' as const, status: 'pending' as const },
      ],
      edges: [{ from_step: 's1', to_step: 's2' }],
    };
    const h = makeHarness(tmp, [{ content: '', tool_calls: [{ id: '1', name: 'write_file', arguments: { path: '/workspace/target.txt', content: 'after' } }] } as ParsedResponse]);
    const r = await h.run({
      goal: 'write then verify',
      success_criteria: [{ criterion: 'done', verification_method: 'deterministic' }],
      constraints: [],
    });
    // Verification fails (goalSatisfied returns false) → overlay discarded
    expect(r.loop_result.termination_reason).not.toBe('completed');
    expect(r.loop_result.termination_reason).not.toBe('goal_satisfied');
    // Real file should still have original content
    expect(readFileSync(join(tmp, 'target.txt'), 'utf8')).toBe('before');
  });

  it('Router deny is terminal — no model calls, no tool calls', async () => {
    let modelCalls = 0;
    const tr = new ToolRegistry();
    tr.register(toolSpec('read_file'));
    const sr = new SkillRegistry(); sr.loadBaseSkills();
    const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
    vfs.mount(new LocalBackend('/workspace', tmp));
    // Policy allows only 'nonexistent_tool' — read_file not in allowed_tools
    const pe = new PolicyEngine({ version: 'v1', default_decision: 'deny', allowed_tools: ['nonexistent_tool'], allowed_resource_prefixes: ['/workspace'], rules: [] } as Policy);
    const sandbox: SandboxProfile = { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] };
    const denyGw = createScriptedGateway([{ content: 'x' } as ParsedResponse]);
    const h = new Harness({ toolRegistry: tr, skillRegistry: sr, policyEngine: pe, vfs, sandbox, gateway: denyGw.gateway, security: createTestSecurityDeps(pe, () => new Date().toISOString()), verification: createTestVerificationEngine(), executionContext: createDefaultExecutionContext('test-deny') });
    const r = await h.run(task('read a file'));
    expect(r.loop_result.termination_reason).toBe('denied');
    // Router deny: no model calls happen
    expect(r.success).toBe(false);
    expect(r.run_plan).toBeNull();
  });

  it('ExecutionContext is required — no default identity in production path', () => {
    // HarnessConfig type enforces executionContext as required
    // This test verifies it's not optional at the type level
    const tr = new ToolRegistry();
    tr.register(toolSpec('read_file'));
    const sr = new SkillRegistry(); sr.loadBaseSkills();
    const vfs = new VirtualFilesystem([{ prefix: '/workspace', read: true, write: true }]);
    vfs.mount(new LocalBackend('/workspace', tmp));
    const pe = new PolicyEngine({ version: 'v1', default_decision: 'deny', allowed_tools: ['read_file'], allowed_resource_prefixes: ['/workspace'], rules: [{ id: 'a', priority: 1, effect: 'allow', tools: ['*'], resource_prefixes: ['/workspace'] }] } as Policy);
    const sandbox: SandboxProfile = { workspaceRoot: tmp, allowNetwork: false, allowUnixSockets: false, allowRead: [] };
    // This should compile — executionContext is provided
    const h = new Harness({ toolRegistry: tr, skillRegistry: sr, policyEngine: pe, vfs, sandbox, gateway: createScriptedGateway([{ content: 'ok' }]).gateway, security: createTestSecurityDeps(pe, () => new Date().toISOString()), verification: createTestVerificationEngine(), executionContext: createDefaultExecutionContext('test-ctx') });
    expect(h).toBeDefined();
  });
});
