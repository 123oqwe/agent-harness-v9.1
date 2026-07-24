/** AH-UI-APPROVAL-001: Approval center with real API dependencies (Policy + Capability). */
import type { UiResult } from './ui-state.js';

export interface ApprovalRequest { id: string; tool: string; reason: string; risk_tier: number }
export interface ApprovalAuthorityPort {
  listPending(): readonly ApprovalRequest[];
  decide(
    id: string,
    decision: 'approved' | 'denied',
  ): { accepted: boolean; reason?: string };
}

export class ApprovalController {
  constructor(private readonly authority: ApprovalAuthorityPort) {}

  list(): UiResult<ApprovalRequest[]> {
    const pending = [...this.authority.listPending()];
    return {
      state: pending.length === 0 ? 'empty' : 'approval',
      data: pending,
      approval_required: pending.length > 0,
    };
  }

  decide(id: string, decision: 'approved' | 'denied'): UiResult<string> {
    const result = this.authority.decide(id, decision);
    if (!result.accepted) {
      return { state: 'error', error: result.reason ?? 'decision rejected' };
    }
    return { state: 'success', data: decision };
  }
}
