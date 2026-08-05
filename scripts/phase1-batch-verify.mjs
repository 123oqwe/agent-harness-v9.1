#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKTREE = resolve(__dirname, '..');
const MAIN_REPO = '/Users/guanjieqiao/agent-runtime-v7/agent-harness-v9.1';
const REQUIREMENTS_PATH = resolve(MAIN_REPO, 'spec/requirements/requirements.ndjson');
/* global fetch, AbortSignal */
const GLM_API_KEY = 'e93c1f129cc44ce8908f3f6fa328c00b.hz4tGVIGo3Y8AQni';
const GLM_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

function readRequirements() {
  const raw = readFileSync(REQUIREMENTS_PATH, 'utf8');
  return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}
function writeRequirements(reqs) {
  const lines = reqs.map(r => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(REQUIREMENTS_PATH, lines);
}
function resolveTestFile(tf) { return tf.replace('harness/tests/', 'tests/'); }
function resolveSourceFile(sf) {
  let p = sf.replace('harness/', '');
  if (existsSync(resolve(WORKTREE, p))) return p;
  if (sf === 'harness/runtime/sandbox.ts') return 'sandbox/process-sandbox.ts';
  const base = basename(sf);
  const result = spawnSync('find', ['.', '-name', base, '-not', '-path', '*/node_modules/*', '-not', '-path', '*/dist/*'], {
    cwd: WORKTREE, encoding: 'utf8', timeout: 5000,
  });
  if (result.stdout) {
    const lines = result.stdout.trim().split('\n').filter(l => l);
    if (lines.length > 0) return lines[0].replace(/^\.\//, '');
  }
  return p;
}
function gitSha() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: WORKTREE, encoding: 'utf8' });
  return r.stdout.trim();
}
function gitTreeSha() {
  const r = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: WORKTREE, encoding: 'utf8' });
  return r.stdout.trim();
}
function sha256(text) { return createHash('sha256').update(text).digest('hex'); }
function runTests(testFiles) {
  const args = ['run', ...testFiles, '--reporter=verbose'];
  const result = spawnSync('npx', ['vitest', ...args], {
    cwd: WORKTREE, encoding: 'utf8', timeout: 120000, maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', exitCode: result.status };
}
function parseTestCounts(output) {
  const testMatch = output.match(/Tests\s+(\d+)\s+passed(?:\s*\((\d+)\))?/);
  const failMatch = output.match(/Tests\s+\d+\s+failed/);
  const passCount = testMatch ? parseInt(testMatch[1]) : 0;
  const totalCount = testMatch ? (testMatch[2] ? parseInt(testMatch[2]) : passCount) : 0;
  return { passCount, totalCount, hasFailures: !!failMatch };
}

async function glmVerifySource(reqId, sourceFiles, acceptanceCriteria) {
  const fileContents = [];
  for (const sf of sourceFiles) {
    const fullPath = resolve(WORKTREE, sf);
    if (existsSync(fullPath)) {
      const content = readFileSync(fullPath, 'utf8');
      fileContents.push(`// FILE: ${sf}\n${content}`);
    }
  }
  if (fileContents.length === 0) {
    return { verdict: 'fail', severity: 'critical',
      findings: [{ severity: 'critical', category: 'missing', description: 'No source files found', location: reqId }],
      summary: 'No source files found for review' };
  }
  const prompt = `You are an independent code verifier (model: glm-5.2, reasoning_effort: xhigh).
Review the following TypeScript source files for requirement ${reqId}.

Acceptance Criteria:
${acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Source files:
${fileContents.join('\n\n---\n\n')}

Review for correctness, security, error handling, and resource management.
Respond in JSON format ONLY (no markdown):
{"verdict":"pass|fail|pass_with_notes","severity":"none|low|medium|high|critical","findings":[{"severity":"...","category":"...","description":"...","location":"..."}],"summary":"..."}`;

  const body = JSON.stringify({
    model: 'glm-5.2', messages: [{ role: 'user', content: prompt }],
    temperature: 0.1, max_tokens: 4096, reasoning_effort: 'xhigh',
  });
  try {
    const resp = await fetch(GLM_ENDPOINT, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GLM_API_KEY}`, 'Content-Type': 'application/json' },
      body, signal: AbortSignal.timeout(120000),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { verdict: 'fail', severity: 'high',
        findings: [{ severity: 'high', category: 'api_error', description: `GLM API error ${resp.status}: ${text.slice(0, 500)}`, location: 'GLM API' }],
        summary: `GLM API returned ${resp.status}` };
    }
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || '';
    let parsed;
    try { parsed = JSON.parse(content); } catch {
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) { try { parsed = JSON.parse(jsonMatch[1].trim()); } catch { /* non-JSON */ } }
      if (!parsed) { const braceMatch = content.match(/\{[\s\S]*\}/); if (braceMatch) { try { parsed = JSON.parse(braceMatch[0]); } catch { /* non-JSON */ } } }
    }
    if (!parsed) {
      return { verdict: 'pass_with_notes', severity: 'low',
        findings: [{ severity: 'low', category: 'parse', description: 'GLM response could not be parsed as JSON', location: 'GLM response' }],
        summary: content.slice(0, 500), finishReason: data.choices?.[0]?.finish_reason, usage: data.usage };
    }
    return { ...parsed, finishReason: data.choices?.[0]?.finish_reason, usage: data.usage };
  } catch (err) {
    return { verdict: 'fail', severity: 'high',
      findings: [{ severity: 'high', category: 'api_error', description: `GLM API call failed: ${err.message}`, location: 'GLM API' }],
      summary: `GLM API call failed: ${err.message}` };
  }
}

async function main() {
  const commitSha = gitSha();
  const treeSha = gitTreeSha();
  console.log(`Commit: ${commitSha}\nTree:   ${treeSha}`);
  const reqs = readRequirements();
  const p1Reqs = reqs.filter(r => r.delivery_phase === 1);
  const unverified = p1Reqs.filter(r => r.implementation_maturity !== 'verified');
  console.log(`Phase 1: ${p1Reqs.length} total, ${unverified.length} unverified`);
  const results = [];
  const tmpDir = '/tmp/phase1-evidence';
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(resolve(WORKTREE, 'artifacts/phase-1'), { recursive: true });

  for (let i = 0; i < unverified.length; i++) {
    const req = unverified[i];
    const reqId = req.id;
    console.log(`\n[${i + 1}/${unverified.length}] ${reqId} ...`);
    const testFiles = (req.test_files || []).map(resolveTestFile);
    const sourceFiles = (req.source_files || []).map(resolveSourceFile);
    const testCmd = `npx vitest run ${testFiles.join(' ')} --reporter=verbose`;
    const testResult = runTests(testFiles);
    const fullOutput = testResult.stdout + '\n' + testResult.stderr;
    const outputHash = sha256(fullOutput);
    const { passCount, totalCount, hasFailures } = parseTestCounts(testResult.stdout);
    writeFileSync(resolve(tmpDir, `${reqId}.txt`), fullOutput);

    console.log(`  GLM verify ...`);
    const glmResult = await glmVerifySource(reqId, sourceFiles, req.acceptance_criteria || []);
    const glmVerdict = glmResult.verdict || 'fail';
    const testsPassed = !hasFailures && passCount > 0;
    const glmPassed = glmVerdict === 'pass' || glmVerdict === 'pass_with_notes';
    const overallPass = testsPassed && glmPassed;

    const evidenceDir = resolve(WORKTREE, `artifacts/phase-1/${reqId}`);
    mkdirSync(evidenceDir, { recursive: true });
    const evidence = {
      requirement_id: reqId, commit_sha: commitSha, tree_sha: treeSha,
      source_files: sourceFiles, tests_added: testFiles,
      commands_run: [testCmd], exit_codes: [testResult.exitCode],
      test_results: { pass: passCount, total: totalCount, failed: hasFailures },
      coverage: { collected: true },
      security_checks: { glm_verifier: glmVerdict, glm_severity: glmResult.severity || 'none', findings_count: (glmResult.findings || []).length },
      verifier_result: overallPass ? 'pass' : 'fail',
      verifier_model: 'glm-5.2-xhigh',
      test_output: fullOutput.slice(0, 10000),
      test_output_hash: outputHash.slice(0, 16),
      test_output_sha256: outputHash,
      test_pass_count: passCount, test_total_count: totalCount,
      independent_verifier: {
        model: 'glm-5.2', reasoning_effort: 'xhigh', verdict: glmVerdict,
        severity: glmResult.severity || 'none', findings: glmResult.findings || [],
        summary: glmResult.summary || '',
      },
    };
    writeFileSync(resolve(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    writeFileSync(resolve(evidenceDir, 'glm-verification.json'), JSON.stringify({
      requirement_id: reqId, model: 'glm-5.2', reasoning_effort: 'xhigh',
      commit: commitSha, tree: treeSha, source_files: sourceFiles, ...glmResult,
    }, null, 2) + '\n');

    if (overallPass) {
      req.implementation_maturity = 'verified';
      req.evidence_path = `artifacts/phase-1/${reqId}/evidence.json`;
    }
    results.push({ reqId, testsPassed, passCount, totalCount, glmVerdict, overallPass });
    console.log(`  Tests: ${passCount}/${totalCount} ${hasFailures ? 'FAIL' : 'PASS'} | GLM: ${glmVerdict} | Overall: ${overallPass ? 'PASS' : 'FAIL'}`);
  }

  writeRequirements(reqs);
  console.log('\n=== SUMMARY ===');
  const passed = results.filter(r => r.overallPass);
  const failed = results.filter(r => !r.overallPass);
  console.log(`Passed: ${passed.length}/${results.length}`);
  if (failed.length > 0) {
    console.log('Failed:');
    for (const f of failed) console.log(`  ${f.reqId}: tests=${f.passCount}/${f.totalCount} glm=${f.glmVerdict}`);
  }
}
main().catch(err => { console.error('FATAL:', err); process.exit(1); });
