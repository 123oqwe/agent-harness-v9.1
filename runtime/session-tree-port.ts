/**
 * N31: Thin adapter that records SessionTree branch events when a new
 * Harness run starts. The SessionTreeAuthorityPort requires a full
 * SessionTreeCommitRequest with security anchors and hash chains;
 * this adapter constructs a minimal valid request from the session state.
 */
import type {
  SessionTreeAuthorityPort,
  SessionTreeScope,
  SessionTreeSessionPoint,
} from '@agent-harness/runtime-core';
import { createHash } from 'node:crypto';

export interface SessionTreeBranchContext {
  readonly authority: SessionTreeAuthorityPort;
  readonly scope: SessionTreeScope;
  readonly rootSessionId: string;
  readonly childSessionId: string;
}

/**
 * Records a branch event in the SessionTree when a new run starts.
 * Returns silently if the authority rejects the request (e.g., duplicate).
 */
export async function recordSessionBranch(ctx: SessionTreeBranchContext): Promise<void> {
  const { authority, scope, rootSessionId, childSessionId } = ctx;
  const head = await authority.readSessionHead(scope, rootSessionId);
  if (!head) {
    return;
  }
  const commandId = `branch-${childSessionId}-${Date.now()}`;
  const securityAnchor = {
    state_hash: head.security?.state_hash ?? createHash('sha256').update(rootSessionId).digest('hex'),
    capability_ceiling_hash: head.security?.capability_ceiling_hash ?? createHash('sha256').update('ceiling').digest('hex'),
    authorization_epoch: head.security?.authorization_epoch ?? 1,
  };
  const sourcePoint: SessionTreeSessionPoint = {
    ...scope,
    session_id: rootSessionId,
    seq: head.seq,
    hash: head.hash,
    security: securityAnchor,
  };
  try {
    await authority.appendLineageEvent({
      scope,
      command_id: commandId,
      operation: 'branch',
      child_session_id: childSessionId,
      source: sourcePoint,
      source_head: sourcePoint,
      expected_tree_head: { seq: head.seq, hash: head.hash },
      event_type: 'branch',
      data: {
        version: 1 as const,
        command_id: commandId,
        operation: 'branch' as const,
        child_session_id: childSessionId,
        source: sourcePoint,
        source_head: sourcePoint,
        replay_policy: 'lineage_only_no_effect_replay' as const,
      },
    });
  } catch {
    // Branch recording is best-effort; the authority may reject
    // duplicates or stale heads. This does not block the run.
  }
}
