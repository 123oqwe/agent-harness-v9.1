/**
 * AH-SECURITY-002: Consent Service (P2-14)
 */
export interface ConsentRecord { id: string; user_id: string; action_manifest_hash: string; approved_at: string; expires_at: string; scope: { paths: string[]; tools: string[] }; revoked: boolean }
export interface ConsentRequest { user_id: string; action_manifest_hash: string; paths: string[]; tools: string[]; ttl_seconds?: number }

export class ConsentService {
  private readonly consents = new Map<string, ConsentRecord>();
  private readonly defaultTtl: number;
  constructor(defaultTtlSeconds = 3600) { this.defaultTtl = defaultTtlSeconds; }

  approve(req: ConsentRequest): ConsentRecord {
    const id = `consent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date();
    const ttl = req.ttl_seconds ?? this.defaultTtl;
    const r: ConsentRecord = { id, user_id: req.user_id, action_manifest_hash: req.action_manifest_hash, approved_at: now.toISOString(), expires_at: new Date(now.getTime() + ttl * 1000).toISOString(), scope: { paths: [...req.paths], tools: [...req.tools] }, revoked: false };
    this.consents.set(id, r);
    return r;
  }

  check(id: string, path: string, tool: string): { valid: boolean; reason?: string } {
    const r = this.consents.get(id);
    if (!r) return { valid: false, reason: 'consent not found' };
    if (r.revoked) return { valid: false, reason: 'consent revoked' };
    if (Date.now() > new Date(r.expires_at).getTime()) return { valid: false, reason: 'consent expired' };
    if (!r.scope.tools.includes(tool)) return { valid: false, reason: `tool '${tool}' not in scope` };
    if (!r.scope.paths.some(p => path.startsWith(p))) return { valid: false, reason: `path '${path}' not in scope` };
    return { valid: true };
  }

  revoke(id: string): boolean { const r = this.consents.get(id); if (!r) return false; r.revoked = true; return true; }
  get(id: string): ConsentRecord | undefined { return this.consents.get(id); }
}
