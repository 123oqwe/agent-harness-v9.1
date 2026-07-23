import { describe, it, expect } from 'vitest';
import { DurableSession } from '../../session/durable-session.js';
import { SecretsBroker } from '../../security/secrets-broker.js';
import { getOnboardingUIState } from '../../ui/ah_ui_onboarding_001.js';
import { getSettingsUIState } from '../../ui/ah_ui_settings_001.js';
import { getApprovalUIState } from '../../ui/ah_ui_approval_001.js';
import { getChatUIState } from '../../ui/ah_ui_chat_001.js';
import { getCodingUIState } from '../../ui/ah_ui_coding_001.js';
import { getEvidenceUIState } from '../../ui/ah_ui_evidence_001.js';
import { getPrivacyUIState } from '../../ui/ah_ui_privacy_001.js';
import { getTaskUIState } from '../../ui/ah_ui_task_001.js';

describe('AH-UI-001: eight UI state adapters', () => {
  it('onboarding adapter shows loading for new session', () => {
    const session = new DurableSession('run-001');
    const state = getOnboardingUIState(session);
    expect(state.state).toBe('loading');
  });

  it('settings adapter redacts secrets', () => {
    const session = new DurableSession('run-001');
    session.append({ type: 'run_started', run_id: 'run-001', data: {} });
    const broker = new SecretsBroker({ encryptionKey: 'test-key-32-bytes-long!!!!!!!!' });
    broker.store('api-key', 'sk-secret-123');
    const state = getSettingsUIState(session, broker);
    expect(state.state).toBe('ready');
    expect(JSON.stringify(state.data)).not.toContain('sk-secret-123');
  });

  it('approval adapter shows error for failed run', () => {
    const session = new DurableSession('run-001');
    session.append({ type: 'run_failed', run_id: 'run-001', data: {} });
    const state = getApprovalUIState(session);
    expect(state.state).toBe('error');
  });

  it('chat adapter shows ready for running session', () => {
    const session = new DurableSession('run-001');
    session.append({ type: 'run_started', run_id: 'run-001', data: {} });
    const state = getChatUIState(session);
    expect(state.state).toBe('ready');
    expect(state.data.event_count).toBeGreaterThan(0);
  });

  it('coding adapter projects durable events', () => {
    const session = new DurableSession('run-001');
    session.append({ type: 'run_started', run_id: 'run-001', data: {} });
    const state = getCodingUIState(session);
    expect(state.data.event_count).toBeGreaterThan(0);
  });

  it('evidence adapter verifies state', () => {
    const session = new DurableSession('run-001');
    const state = getEvidenceUIState(session);
    expect(state.timestamp).toBeTruthy();
  });

  it('privacy adapter redacts secrets', () => {
    const session = new DurableSession('run-001');
    const broker = new SecretsBroker({ encryptionKey: 'test-key-32-bytes-long!!!!!!!!' });
    broker.store('token', 'secret-token-val');
    const state = getPrivacyUIState(session, broker);
    expect(JSON.stringify(state.data)).not.toContain('secret-token-val');
  });

  it('task adapter handles cancelled state', () => {
    const session = new DurableSession('run-001');
    session.append({ type: 'run_cancelled', run_id: 'run-001', data: {} });
    const state = getTaskUIState(session);
    expect(state.state).toBe('cancelled');
  });

  it('all adapters return timestamps', () => {
    const session = new DurableSession('run-001');
    expect(getOnboardingUIState(session).timestamp).toBeTruthy();
    expect(getSettingsUIState(session).timestamp).toBeTruthy();
    expect(getApprovalUIState(session).timestamp).toBeTruthy();
    expect(getChatUIState(session).timestamp).toBeTruthy();
    expect(getCodingUIState(session).timestamp).toBeTruthy();
    expect(getEvidenceUIState(session).timestamp).toBeTruthy();
    expect(getPrivacyUIState(session).timestamp).toBeTruthy();
    expect(getTaskUIState(session).timestamp).toBeTruthy();
  });
});
