import { describe, expect, it, vi } from 'vitest';
import {
  ApprovalController,
  type ApprovalAuthorityPort,
  type ApprovalRequest,
} from '../../ui/ah_ui_approval_001.js';

function authority(pending: ApprovalRequest[] = []): ApprovalAuthorityPort {
  return {
    listPending: () => pending,
    decide: vi.fn((id) =>
      pending.some((request) => request.id === id)
        ? { accepted: true }
        : { accepted: false, reason: 'not found' },
    ),
  };
}

describe('AH-UI-APPROVAL-001 authority-backed approval UI', () => {
  it('lists only authority-owned pending requests', () => {
    const request = {
      id: 'a',
      tool: 'execute_command',
      reason: 'high risk',
      risk_tier: 3,
    };
    const controller = new ApprovalController(authority([request]));
    expect(controller.list()).toMatchObject({
      state: 'approval',
      approval_required: true,
      data: [request],
    });
    expect('submit' in controller).toBe(false);
  });

  it('delegates decisions without issuing a capability or grant', () => {
    const port = authority([
      { id: 'a', tool: 'edit_file', reason: 'write', risk_tier: 2 },
    ]);
    const controller = new ApprovalController(port);
    expect(controller.decide('a', 'approved')).toMatchObject({
      state: 'success',
      data: 'approved',
    });
    expect(port.decide).toHaveBeenCalledWith('a', 'approved');
  });

  it('fails closed when the authority rejects the decision', () => {
    const controller = new ApprovalController(authority());
    expect(controller.decide('missing', 'denied')).toMatchObject({
      state: 'error',
      error: 'not found',
    });
  });
});
