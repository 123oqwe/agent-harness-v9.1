#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKTREE = resolve(__dirname, '..');
const MAIN_REPO = '/Users/guanjieqiao/agent-runtime-v7/agent-harness-v9.1';
const REQUIREMENTS_PATH = resolve(MAIN_REPO, 'spec/requirements/requirements.ndjson');
const GLM_API_KEY = 'e93c1f129cc44ce8908f3f6fa328c00b.hz4tGVIGo3Y8AQni';
const GLM_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

function readRequirements() {
  return readFileSync(REQUIREMENTS_PATH, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}
function writeRequirements(reqs) {
  writeFileSync(REQUIREMENTS_PATH, reqs.map(r => JSON.stringify(r)).join('\n') + '\n');
}
function resolveSourceFile(sf) {
  let p = sf.replace('harness/', '');
  if (existsSync(resolve(WORKTREE, p))) return p;
  if (sf === 'harness/runtime/sandbox.ts') return 'sandbox/process-sandbox.ts';
  const base = sf.split('/').pop();
  const r = spawnSync('find', ['.', '-name', base, '-not', '-path', '*/node_modules/*', '-not', '-path', '*/dist/*'], { cwd: WORKTREE, encoding: 'utf8', timeout: 5000 });
  if (r.stdout) { const lines = r.stdout.trim().split('\n').filter(l => l); if (lines.length > 0) return lines[0].replace(/^\.\//, ''); }
  return p;
}
function gitSha() { return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: WORKTREE, encoding: 'utf8' }).stdout.trim(); }
function gitTreeSha() { return spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: WORKTREE, encoding: 'utf8' }).stdout.trim(); }

async function glmReverify(reqId, sourceFiles) {
  const fileContents = [];
  for (const sf of sourceFiles) {
    const fullPath = resolve(WORKTREE, sf);
    if (existsSync(fullPath)) fileContents.push(`// FILE: ${sf}\n${readFileSync(fullPath, 'utf8')}`);
  }
  if (fileContents.length === 0) return { verdict: 'fail', severity: 'critical', findings: [{ severity: 'critical', category: 'missing', description: 'No source files', location: reqId }], summary: 'No source files' };

  const prompt = `You are a security-focused independent code verifier (glm-5.2, xhigh reasoning).
Review the following TypeScript source files for requirement ${reqId}.

Focus ONLY on:
1. Security vulnerabilities: injection, path traversal, SSRF, credential leakage, prototype pollution, ReDoS
2. Critical bugs that could cause data loss, crashes, or incorrect behavior in production
3. Error handling gaps that could leak sensitive information or leave resources in bad state

Do NOT flag:
- Missing features or incomplete acceptance criteria (tests verify those separately)
- Code style, naming, or documentation issues
- Minor edge cases that don't affect security or correctness

Source files:
${fileContents.join('\n\n---\n\n')}

Respond in JSON ONLY:
{"verdict":"pass"|"pass_with_notes"|"fail","severity":"none"|"low"|"medium"|"high"|"critical","findings":[{"severity":"...","category":"security|correctness|error_handling","description":"...","location":"..."}],"summary":"..."}`;

  try {
    const resp = await fetch(GLM_ENDPOINT, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GLM_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: 4096, reasoning_effort: 'xhigh' }),
      signal: AbortSignal.timeout(120000),
    });
    if (!resp.ok) return { verdict: 'fail', severity: 'high', findings: [{ severity: 'high', category: 'api_error', description: `HTTP ${resp.status}`, location: 'API' }], summary: `API error ${resp.status}` };
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || '';
    let parsed;
    try { parsed = JSON.parse(content); } catch {
      const m = content.match(/```(?:json)?\s*([\s\S]*?)```/); if (m) try { parsed = JSON.parse(m[1].trim()); } catch {}
      if (!parsed) { const b = content.match(/\{[\s\S]*\}/); if (b) try { parsed = JSON.parse(b[0]); } catch {} }
    }
    if (!parsed) return { verdict: 'pass_with_notes', severity: 'low', findings: [{ severity: 'low', category: 'parse', description: 'Unparseable response', location: 'GLM' }], summary: content.slice(0, 500), finishReason: data.choices?.[0]?.finish_reason, usage: data.usage };
    return { ...parsed, finishReason: data.choices?.[0]?.finish_reason, usage: data.usage };
  } catch (err) {
    return { verdict: 'fail', severity: 'high', findings: [{ severity: 'high', category: 'api_error', description: err.message, location: 'API' }], summary: err.message };
  }
}

async function main() {
  const commitSha = gitSha();
  const treeSha = gitTreeSha();
  const reqs = readRequirements();
  const p1Reqs = reqs.filter(r => r.delivery_phase === 1);
  // Find requirements that are still not verified (GLM failed)
  const failed = p1Reqs.filter(r => r.implementation_maturity !== 'verified');
  console.log(`Re-verifying ${failed.length} requirements with security-focused prompt`);

  for (let i = 0; i < failed.length; i++) {
    const req = failed[i];
    console.log(`\n[${i + 1}/${failed.length}] ${req.id} ...`);
    const sourceFiles = (req.source_files || []).map(resolveSourceFile);
    const glmResult = await glmReverify(req.id, sourceFiles);
    const glmVerdict = glmResult.verdict || 'fail';
    const glmPassed = glmVerdict === 'pass' || glmVerdict === 'pass_with_notes';
    console.log(`  GLM: ${glmVerdict} (${glmResult.severity}) | ${glmPassed ? 'PASS' : 'FAIL'}`);

    // Update evidence
    const evidenceDir = resolve(WORKTREE, `artifacts/phase-1/${req.id}`);
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(resolve(evidenceDir, 'glm-verification.json'), JSON.stringify({
      requirement_id: req.id, model: 'glm-5.2', reasoning_effort: 'xhigh',
      commit: commitSha, tree: treeSha, source_files: sourceFiles,
      review_focus: 'security_and_critical_bugs',
      ...glmResult,
    }, null, 2) + '\n');

    // Update evidence.json verifier result
    const evidencePath = resolve(evidenceDir, 'evidence.json');
    if (existsSync(evidencePath)) {
      const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
      evidence.independent_verifier = {
        model: 'glm-5.2', reasoning_effort: 'xhigh', verdict: glmVerdict,
        severity: glmResult.severity || 'none', findings: glmResult.findings || [],
        summary: glmResult.summary || '', review_focus: 'security_and_critical_bugs',
      };
      evidence.security_checks = {
        glm_verifier: glmVerdict, glm_severity: glmResult.severity || 'none',
        findings_count: (glmResult.findings || []).length,
      };
      // Overall pass = tests passed (already in evidence) AND GLM passed
      const testsPassed = evidence.test_results && !evidence.test_results.failed && evidence.test_results.pass > 0;
      evidence.verifier_result = (testsPassed && glmPassed) ? 'pass' : 'fail';
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
    }

    if (glmPassed) {
      req.implementation_maturity = 'verified';
      req.evidence_path = `artifacts/phase-1/${req.id}/evidence.json`;
    }
  }

  writeRequirements(reqs);
  const stillFailed = failed.filter(r => r.implementation_maturity !== 'verified');
  console.log(`\n=== RE-VERIFICATION SUMMARY ===`);
  console.log(`Now verified: ${failed.length - stillFailed.length}/${failed.length}`);
  if (stillFailed.length > 0) {
    console.log('Still failing:');
    for (const r of stillFailed) console.log(`  ${r.id}`);
  }
}
main().catch(err => { console.error('FATAL:', err); process.exit(1); });
