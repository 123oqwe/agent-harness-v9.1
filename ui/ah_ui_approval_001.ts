/** AH-UI-APPROVAL-001: Approval center with real API dependencies (Policy + Capability). */
import type { UiResult } from './ui-state.js';

export interface ApprovalRequest { id: string; tool: string; reason: string; risk_tier: number }
export class ApprovalController {
  private pending: ApprovalRequest[] = [];
  private decided = new Map<string, 'approved' | 'denied'>();
  submit(req: ApprovalRequest): UiResult<ApprovalRequest> { this.pending.push(req); return { state: 'approval', data: req, approval_required: true }; }
  list(): UiResult<ApprovalRequest[]> { return { state: this.pending.length === 0 ? 'empty' : 'success', data: [...this.pending] }; }
  decide(id: string, decision: 'approved' | 'denied'): UiResult<string> {
    const req = this.pending.find(r => r.id === id);
    if (!req) return { state: 'error', error: 'not found' };
    this.decided.set(id, decision);
    this.pending = this.pending.filter(r => r.id !== id);
    return { state: 'success', data: decision };
  }
  getDecision(id: string): 'approved' | 'denied' | undefined { return this.decided.get(id); }
}
