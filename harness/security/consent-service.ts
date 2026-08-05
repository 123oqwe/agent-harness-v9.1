/**
 * AH-SECURITY-002: Consent Service (P2-14)
 *
 * Manages user consent records with scope, expiry, and revocation.
 * Consent for "read file A" does not cover "read any file".
 */

export interface ConsentRecord {
  id: string;
 user_id: string;
 action_manifest_hash: string;
 approved_at: string;
 expires_at: string;
 scope: {
    paths: string[];
    tools: string[];
  };
  revoked: boolean;
}

export interface ConsentRequest {
  user_id: string;
 action_manifest_hash: string;
 paths: string[];
  tools: string[];
  ttl_seconds?: number;
}

export class ConsentService {
  private readonly consents = new Map<string, ConsentRecord>();
  private readonly defaultTtl: number;

  constructor(defaultTtlSeconds: number = 3600) {
    this.defaultTtl = defaultTtlSeconds;
  }

  approve(req: ConsentRequest): ConsentRecord {
    const id = `consent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date();
    const ttl = req.ttl_seconds ?? this.defaultTtl;
    const record: ConsentRecord = {
      id,
      user_id: req.user_id,
      action_manifest_hash: req.action_manifest_hash,
      approved_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttl * 1000).toISOString(),
      scope: { paths: [...req.paths], tools: [...req.tools] },
      revoked: false,
    };
    this.consents.set(id, record);
    return record;
  }

  /**
   * Check if a consent covers a specific action.
   * Path prefix matching: consent for /workspace/src/ covers /workspace/src/foo.ts
   */
  check(consentId: string, path: string, tool: string): { valid: boolean; reason?: string } {
    const record = this.consents.get(consentId);
    if (!record) return { valid: false, reason: 'consent not found' };
    if (record.revoked) return { valid: false, reason: 'consent revoked' };

    const now = Date.now();
    if (now > new Date(record.expires_at).getTime()) {
      return { valid: false, reason: 'consent expired' };
    }

    if (!record.scope.tools.includes(tool)) {
      return { valid: false, reason: `tool '${tool}' not in consent scope` };
    }

 const pathMatch = record.scope.paths.some((prefix) => path.startsWith(prefix));
    if (!pathMatch) {
      return { valid: false, reason: `path '${path}' not in consent scope` };
    }

    return { valid: true };
  }

  revoke(consentId: string): boolean {
    const record = this.consents.get(consentId);
    if (!record) return false;
    record.revoked = true;
    return true;
  }

  get(consentId: string): ConsentRecord | undefined {
    return this.consents.get(consentId);
  }

  list(userId?: string): ConsentRecord[] {
    const all = [...this.consents.values()];
    return userId ? all.filter((c) => c.user_id === userId) : all;
  }
}
