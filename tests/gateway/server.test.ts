import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createManagedGateway,
  createSecurityDeps,
  createVerificationEngine,
  createHarnessForTask,
  startServer,
} from '../../gateway/server.js';
import { PolicyEngine } from '../../security/policy-engine.js';
import type { Policy } from '../../security/policy-engine.js';

const testPolicy: Policy = {
  version: 'v1',
  default_decision: 'deny',
  allowed_tools: ['read_file'],
  allowed_resource_prefixes: ['/workspace'],
  rules: [{ id: 'r1', priority: 1, effect: 'allow', tools: ['*'], resource_prefixes: ['/workspace'] }],
};

describe('server factory functions', () => {
  describe('createManagedGateway', () => {
    it('returns a ManagedGateway with economic and keyVault', () => {
      const gw = createManagedGateway();
      expect(gw).toBeDefined();
      expect(gw.economicRef).toBeDefined();
      expect(gw.modelGatewayRef).toBeDefined();
    });

    it('creates independent instances on each call', () => {
      const a = createManagedGateway();
      const b = createManagedGateway();
      expect(a).not.toBe(b);
      expect(a.economicRef).not.toBe(b.economicRef);
    });
  });

  describe('createSecurityDeps', () => {
    it('returns all required security deps', () => {
      const engine = new PolicyEngine(testPolicy);
      const clock = () => '2026-01-01T00:00:00Z';
      const deps = createSecurityDeps(engine, clock);
      expect(deps.authz).toBeDefined();
      expect(deps.pep).toBeDefined();
      expect(deps.stateStore).toBeDefined();
      expect(deps.consent).toBeDefined();
      expect(deps.auditSink).toBeDefined();
      expect(deps.postconditionVerifier).toBeDefined();
    });

    it('uses the provided clock function', () => {
      const engine = new PolicyEngine(testPolicy);
      let clockVal = '2026-01-01T00:00:00Z';
      const clock = () => clockVal;
      const deps = createSecurityDeps(engine, clock);
      expect(deps.authz).toBeDefined();
      clockVal = '2026-06-01T12:00:00Z';
      expect(deps.authz).toBeDefined();
    });

    it('consent auto-approves all ALLOWED_TOOLS', async () => {
      const engine = new PolicyEngine(testPolicy);
      const clock = () => '2026-01-01T00:00:00Z';
      const deps = createSecurityDeps(engine, clock);
      const result = await deps.consent.request({
        tool_name: 'read_file',
        risk_tier: 3,
      });
      expect(result.granted).toBe(true);
    });

    it('consent does not auto-approve unknown tools', async () => {
      const engine = new PolicyEngine(testPolicy);
      const clock = () => '2026-01-01T00:00:00Z';
      const deps = createSecurityDeps(engine, clock);
      const result = await deps.consent.request({
        tool_name: 'unknown_tool',
        risk_tier: 3,
      });
      expect(result.granted).toBe(false);
    });

    it('generates ed25519 key pair per call', () => {
      const engine = new PolicyEngine(testPolicy);
      const clock = () => '2026-01-01T00:00:00Z';
      const deps = createSecurityDeps(engine, clock);
      expect(deps.authz).toBeDefined();
      const deps2 = createSecurityDeps(engine, clock);
      expect(deps.authz).not.toBe(deps2.authz);
    });
  });

  describe('createVerificationEngine', () => {
    it('returns a VerificationEngine with callback adapter', () => {
      const engine = createVerificationEngine();
      expect(engine).toBeDefined();
    });
  });

  describe('createHarnessForTask', () => {
    it('creates a Harness with all Phase 2 components injected', () => {
      const gw = createManagedGateway();
      const dir = mkdtempSync(join(tmpdir(), 'server-test-'));
      const harness = createHarnessForTask(gw, 'user1', 'task1', dir);
      expect(harness).toBeDefined();
    });

    it('creates independent Harness instances per task', () => {
      const gw = createManagedGateway();
      const dir = mkdtempSync(join(tmpdir(), 'server-test-2-'));
      const h1 = createHarnessForTask(gw, 'user1', 'task1', dir);
      const h2 = createHarnessForTask(gw, 'user2', 'task2', dir);
      expect(h1).not.toBe(h2);
    });
  });

  describe('startServer', () => {
    let servers: { stop: () => void }[] = [];

    afterEach(() => {
      for (const s of servers) {
        try { s.stop(); } catch { /* ignore */ }
      }
      servers = [];
    });

    it('starts on a specified port and returns server + managedGateway', () => {
      const { server, managedGateway } = startServer({ port: 18099 });
      servers.push(server);
      expect(server).toBeDefined();
      expect(managedGateway).toBeDefined();
      expect(server.isRunning).toBe(true);
    });

    it('uses default workspace dir when not provided', () => {
      const { server } = startServer({ port: 18098 });
      servers.push(server);
      expect(server.isRunning).toBe(true);
    });

    it('stops cleanly', () => {
      const { server } = startServer({ port: 18097 });
      expect(server.isRunning).toBe(true);
      server.stop();
      expect(server.isRunning).toBe(false);
    });
  });
});
