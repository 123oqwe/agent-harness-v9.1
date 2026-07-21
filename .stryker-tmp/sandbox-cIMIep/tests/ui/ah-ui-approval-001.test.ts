// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { ApprovalController } from '../../ui/ah_ui_approval_001.js';
describe('AH-UI-APPROVAL-001 approval', () => {
  it('submit returns approval state', () => { const c = new ApprovalController(); const r = c.submit({ id: 'a', tool: 'execute_command', reason: 'high risk', risk_tier: 3 }); expect(r.state).toBe('approval'); });
  it('list empty state', () => { const c = new ApprovalController(); expect(c.list().state).toBe('empty'); });
  it('decide approved/denied', () => { const c = new ApprovalController(); c.submit({ id: 'a', tool: 't', reason: 'r', risk_tier: 1 }); c.decide('a', 'approved'); expect(c.getDecision('a')).toBe('approved'); });
  it('decide not found error', () => { const c = new ApprovalController(); expect(c.decide('x', 'denied').state).toBe('error'); });
});
