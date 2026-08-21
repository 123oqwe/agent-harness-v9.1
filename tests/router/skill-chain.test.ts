import { describe, it, expect } from 'vitest';
import {
  buildSkillChain,
  discoverMcpSkills,
  runSkillChain,
  type MCPRegistry,
  type SkillCatalog,
  type SkillSpec,
  type CapabilityToken,
} from '../../router/skill-chain.js';

function skill(s: Partial<SkillSpec> & { skill_id: string }): SkillSpec {
  return { required_capability: 'skill:run', consumes: [], produces: [], ...s };
}

const extract = skill({ skill_id: 'extract', required_capability: 'skill:extract', produces: ['raw.txt'] });
const summarize = skill({
  skill_id: 'summarize',
  required_capability: 'skill:summarize',
  consumes: ['raw.txt'],
  produces: ['summary.txt'],
});
const catalog: SkillCatalog = { skills: [summarize, extract, skill({ skill_id: 'irrelevant', produces: ['other.txt'] })] };

const tokens: CapabilityToken[] = [
  { skill_id: 'extract', capability: 'skill:extract' },
  { skill_id: 'summarize', capability: 'skill:summarize' },
];

describe('AH-ROUTER-SKILL-CHAIN-001 chaining', () => {
  it('feeds the output of skill A into the input of skill B', () => {
    const r = buildSkillChain({ catalog, requirement: { goal_outputs: ['summary.txt'] } });
    expect(r.chain).toEqual(['extract', 'summarize']);
    expect(r.feeds).toContainEqual({ from: 'extract', output: 'raw.txt', to: 'summarize', input: 'raw.txt' });
  });

  it('excludes policy-denied skills (chain cannot bypass the policy engine)', () => {
    const r = buildSkillChain({
      catalog,
      requirement: { goal_outputs: ['summary.txt'] },
      policyOk: (id) => id !== 'extract',
    });
    // extract is denied -> summarize's input raw.txt is never produced -> chain cannot reach the goal
    expect(r.chain).not.toContain('extract');
    expect(r.chain).not.toContain('summarize');
  });

  it('is deterministic across repeated builds', () => {
    const requirement = { goal_outputs: ['summary.txt'] };
    const r1 = buildSkillChain({ catalog, requirement });
    const r2 = buildSkillChain({ catalog, requirement });
    expect(r1).toEqual(r2);
  });
});

describe('AH-ROUTER-SKILL-CHAIN-001 MCP discovery', () => {
  const registry: MCPRegistry = {
    servers: [
      {
        name: 'facts-mcp',
        endpoint: 'https://10.0.4.12:8443/mcp',
        skills: [extract, summarize],
      },
      { name: 'audit-mcp', skills: [skill({ skill_id: 'audit', required_capability: 'skill:audit' })] },
    ],
  };

  it('scans configured MCP servers for available skills', () => {
    const discovered = discoverMcpSkills(registry);
    expect(discovered.map((d) => d.skill_id)).toEqual(['audit', 'extract', 'summarize']);
    expect(discovered.find((d) => d.skill_id === 'extract')!.mcp_server).toBe('facts-mcp');
  });

  it('does not expose internal network topology — endpoints never surface', () => {
    const discovered = discoverMcpSkills(registry);
    for (const d of discovered) {
      expect(d.mcp_server).not.toMatch(/:\d{2,}/); // no port
      expect(JSON.stringify(d)).not.toContain('10.0.4.12');
      expect(JSON.stringify(d)).not.toContain('https://');
    }
  });
});

describe('AH-ROUTER-SKILL-CHAIN-001 execution', () => {
  const execute = async (skillId: string) => {
    if (skillId === 'extract') return { ok: true as const, outputs: { 'raw.txt': 'the raw text' } };
    return { ok: true as const, outputs: { 'summary.txt': 'a short summary' } };
  };

  it('requires a capability token for every skill in the chain', async () => {
    const r = await runSkillChain([extract, summarize], tokens, execute);
    expect(r.ok).toBe(true);
    expect(r.partial_outputs).toEqual({ 'raw.txt': 'the raw text', 'summary.txt': 'a short summary' });
    expect(r.log.every((l) => l.ok)).toBe(true);
  });

  it('a missing token stops the chain before the skill runs', async () => {
    const r = await runSkillChain([extract, summarize], [{ skill_id: 'extract', capability: 'skill:extract' }], execute);
    expect(r.ok).toBe(false);
    expect(r.failed_step!.skill_id).toBe('summarize');
    expect(r.failed_step!.error).toContain('capability token');
    // extract's output is preserved as a partial result
    expect(r.partial_outputs).toEqual({ 'raw.txt': 'the raw text' });
  });

  it('a wrong-capability token is treated as missing', async () => {
    const r = await runSkillChain(
      [extract],
      [{ skill_id: 'extract', capability: 'skill:WRONG' }],
      execute,
    );
    expect(r.ok).toBe(false);
    expect(r.failed_step!.skill_id).toBe('extract');
  });

  it('a failed step preserves partial results and logs the failure', async () => {
    const failing = async (skillId: string) => {
      if (skillId === 'summarize') return { ok: false as const, error: 'model rejected input' };
      return execute(skillId);
    };
    const r = await runSkillChain([extract, summarize], tokens, failing);
    expect(r.ok).toBe(false);
    expect(r.failed_step).toEqual({ skill_id: 'summarize', error: 'model rejected input' });
    expect(r.partial_outputs).toEqual({ 'raw.txt': 'the raw text' }); // preserved
    expect(r.log).toEqual([
      { skill_id: 'extract', ok: true },
      { skill_id: 'summarize', ok: false, error: 'model rejected input' },
    ]);
  });
});
