/**
 * Helper functions and default data for RuntimeLoop.
 * Kept separate from loop.ts to avoid data-literal mutation noise.
 */

import type { EffectRisk } from '../security/policy-engine.js';
import type { Policy } from '../security/policy-engine.js';
import { createHash } from 'node:crypto';

export function defaultReadRisk(): EffectRisk {
  return {
    locality: 'local',
    operation: 'read',
    reversibility: 'guaranteed',
    data_egress: 'none',
    network_access: false,
    credential_access: false,
    blast_radius: 'self',
    financial_impact_usd_micros: 0,
    human_impact: 'none',
    external_visibility: 'none',
    regulatory_sensitivity: 'none',
  };
}

export function defaultWriteRisk(): EffectRisk {
  return { ...defaultReadRisk(), operation: 'write' };
}

export function riskForTool(toolName: string): EffectRisk {
  if (toolName.includes('write') || toolName.includes('edit') || toolName.includes('create')) {
    return defaultWriteRisk();
  }
  if (toolName.includes('execute') || toolName.includes('command')) {
    return { ...defaultReadRisk(), operation: 'execute', reversibility: 'best_effort' };
  }
  if (toolName.includes('delete') || toolName.includes('remove')) {
    return { ...defaultReadRisk(), operation: 'delete', reversibility: 'none' };
  }
  return defaultReadRisk();
}

export function computeManifestHash(toolName: string, args: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify({ toolName, args })).digest('hex');
}

export function createDefaultPolicy(): Policy {
  return {
    rules: [
      { tool: 'read_file', allow: true },
      { tool: 'write_file', allow: true },
      { tool: 'edit_file', allow: true },
      { tool: 'search_files', allow: true },
      { tool: 'list_directory', allow: true },
      { tool: 'create_artifact', allow: true },
      { tool: 'execute_command', allow: true },
      { tool: 'parse_document', allow: true },
      { tool: 'ask_user', allow: true },
      { tool: 'direct_response', allow: true },
    ],
    default_decision: 'deny',
  };
}
