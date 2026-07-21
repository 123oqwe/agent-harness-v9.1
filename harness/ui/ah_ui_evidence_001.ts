/** AH-UI-EVIDENCE-001: Evidence viewer with real API dependencies. */
import type { UiResult } from './ui-state.js';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface EvidenceSummary { requirement_id: string; verifier_result: string; commit_sha: string }
export class EvidenceViewerController {
  constructor(private evidenceDir: string) {}
  list(): UiResult<EvidenceSummary[]> {
    if (!existsSync(this.evidenceDir)) return { state: 'empty', data: [] };
    const files = readdirSync(this.evidenceDir).filter(f => f.endsWith('.json'));
    if (files.length === 0) return { state: 'empty', data: [] };
    const summaries = files.map(f => {
      try { const d = JSON.parse(readFileSync(join(this.evidenceDir, f), 'utf8')); return { requirement_id: d.requirement_id, verifier_result: d.verifier_result, commit_sha: d.commit_sha }; }
      catch { return null; }
    }).filter((x): x is EvidenceSummary => x !== null);
    return { state: 'success', data: summaries };
  }
}
