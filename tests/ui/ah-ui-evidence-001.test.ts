import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceViewerController } from '../../ui/ah_ui_evidence_001.js';
describe('AH-UI-EVIDENCE-001 evidence viewer', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'uie-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it('empty state when no evidence', () => { const c = new EvidenceViewerController(dir); expect(c.list().state).toBe('empty'); });
  it('success state lists evidence summaries', () => { writeFileSync(join(dir, 'AH-X-001.json'), JSON.stringify({ requirement_id: 'AH-X-001', verifier_result: 'pass', commit_sha: 'abc123' })); const c = new EvidenceViewerController(dir); const r = c.list(); expect(r.state).toBe('success'); expect(r.data![0]!.requirement_id).toBe('AH-X-001'); });
});
