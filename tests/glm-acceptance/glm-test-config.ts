import { createGlmGateway } from '../../gateway/glm-gateway-bridge.js';

export function createLiveGlmGateway(allowRemote = true) {
  const secret = process.env.GLM_API_KEY;
  if (!secret) throw new Error('GLM_API_KEY is required for live acceptance');
  return createGlmGateway({
    model: process.env.GLM_MODEL ?? 'glm-5.2',
    reasoningEffort: process.env.GLM_REASONING_EFFORT ?? 'xhigh',
    secretsBroker: {
      async exchangeCredential(input) {
        return {
          lease_id: `live-${input.operation_id}`,
          audience: input.audience,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          secret,
        };
      },
    },
    egressPolicy: {
      async authorize() {
        return allowRemote ? { allowed: true } : { allowed: false, reason: 'test denial' };
      },
    },
  });
}
