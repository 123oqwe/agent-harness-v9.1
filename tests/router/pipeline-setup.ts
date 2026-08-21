/**
 * Shared fixtures for the AH-ROUTER-DAG-001 pipeline tests. Mirrors the mock
 * setup of tests/router/static-router.test.ts (deterministic ToolRegistry,
 * base SkillRegistry, PolicyEngine, scripted gateway) but returns the
 * RouterDeps shape the pipeline consumes.
 */
import { ToolRegistry } from '../../tools/tool-registry.js';
import { SkillRegistry } from '../../skills/skill-registry.js';
import { PolicyEngine, type Policy } from '../../security/policy-engine.js';
import type { ToolSpec } from '../../contracts/index.js';
import type { TaskContract } from '../../contracts/index.js';
import type { ModelGateway } from '../../gateway/model-gateway.js';
import { createScriptedGateway } from '../helpers/test-security.js';
import { createPhase1ToolDefinitions } from '../../tools/tool-definitions.js';
import type { RouterDeps } from '../../router/static-router.js';
import type { IdentityContext } from '../../router/pipeline.js';

export const PHASE1_TOOLS = [
  'read_file',
  'write_file',
  'edit_file',
  'execute_command',
  'list_directory',
  'search_files',
  'parse_document',
];

export function toolSpec(name: string): ToolSpec {
  const spec = createPhase1ToolDefinitions().find((entry) => entry.name === name);
  if (!spec) throw new Error(`unknown Phase 1 tool fixture: ${name}`);
  return spec;
}

export function task(goal: string, over: Partial<TaskContract> = {}): TaskContract {
  return {
    goal,
    success_criteria: [{ criterion: 'done', verification_method: 'deterministic' }],
    constraints: [],
    ...over,
  } as TaskContract;
}

export function setupDeps(options: { gateway?: ModelGateway; policy?: Policy } = {}): RouterDeps {
  const tr = new ToolRegistry();
  PHASE1_TOOLS.forEach((name) => tr.register(toolSpec(name)));
  const sr = new SkillRegistry();
  sr.loadBaseSkills();
  const tsnap = tr.freezeSnapshot();
  const ssnap = sr.freezeSnapshot();
  const pe = new PolicyEngine(
    options.policy ??
      ({
        version: 'policy-v1',
        default_decision: 'deny',
        allowed_tools: PHASE1_TOOLS,
        allowed_resource_prefixes: ['workspace://'],
        rules: [],
      } as Policy),
  );
  const gateway = options.gateway ?? createScriptedGateway([{ content: 'unused' }]).gateway;
  return {
    toolRegistry: tr,
    skillRegistry: sr,
    toolSnapshot: tsnap,
    skillSnapshot: ssnap,
    policyEngine: pe,
    policySnapshotRef: 'policy-v1',
    gateway,
  };
}

export const DEFAULT_IDENTITY: IdentityContext = {
  principal: 'test-user',
  delegation_depth: 0,
  role: 'root',
  authorization_scope: 'test',
};

export function gatewayProxy(
  gateway: ModelGateway,
  overrides: Partial<Pick<ModelGateway, 'resolve' | 'describeResolved'>>,
): ModelGateway {
  return new Proxy(gateway, {
    get(target, property) {
      const override = overrides[property as keyof typeof overrides];
      if (override !== undefined) return override;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
