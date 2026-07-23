/**
 * AH-CONSENT-001: Consent Service
 *
 * Derives consent requirements from DerivedRiskTier and manages human consent
 * for elevated-risk actions.
 *
 * Risk tier consent mapping:
 *   Tier 0-1: auto-approve (no consent)
 *   Tier 2: session confirm
 *   Tier 3: session confirm + exact preview
 *   Tier 4: recent_password
 *   Tier 5: webauthn
 */

export type ConsentLevel = 'none' | 'session_confirm' | 'session_confirm_preview' | 'recent_password' | 'webauthn';

export interface ConsentRequest {
  tool_name: string;
  risk_tier: number;
  manifest_preview?: string;
}

export interface ConsentResult {
  granted: boolean;
  level: ConsentLevel;
  reason?: string;
  timestamp: string;
}

export interface ConsentHandler {
  (req: ConsentRequest): Promise<ConsentResult>;
}

export function deriveConsentLevel(riskTier: number): ConsentLevel {
  if (riskTier <= 1) return 'none';
  if (riskTier === 2) return 'session_confirm';
  if (riskTier === 3) return 'session_confirm_preview';
  if (riskTier === 4) return 'recent_password';
  return 'webauthn';
}

export function consentRequired(riskTier: number): boolean {
  return riskTier >= 2;
}

export class ConsentService {
  private readonly handler: ConsentHandler | null;
  private readonly autoApprove: Set<string> = new Set();

  constructor(handler?: ConsentHandler) {
    this.handler = handler ?? null;
  }

  /** Auto-approve a specific tool (e.g. for deterministic test providers). */
  allowAutoApprove(toolName: string): void {
    this.autoApprove.add(toolName);
  }

  async request(req: ConsentRequest): Promise<ConsentResult> {
    const level = deriveConsentLevel(req.risk_tier);

    if (level === 'none') {
      return { granted: true, level, timestamp: new Date().toISOString() };
    }

    if (this.autoApprove.has(req.tool_name)) {
      return { granted: true, level, reason: 'auto-approved', timestamp: new Date().toISOString() };
    }

    if (!this.handler) {
      return { granted: false, level, reason: 'no consent handler configured', timestamp: new Date().toISOString() };
    }

    return this.handler(req);
  }

  isGranted(result: ConsentResult): boolean {
    return result.granted;
  }
}
