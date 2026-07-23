/**
 * AH-GLM-001: Independent GLM-5.2 xhigh Acceptance Client
 *
 * Read-only external acceptance. Runs the actual test suite at runtime,
 * collects real results, and sends them to GLM-5.2 with xhigh reasoning.
 * Does NOT reveal expected answers to the model. FAIL-CLOSED on any error.
 *
 * Exit criteria: 0 failed cases, 0 high/critical findings.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GLM_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';

export interface GlmCase {
  id: string;
  category: 'normal' | 'boundary' | 'adversarial' | 'permission_bypass' | 'prompt_injection' | 'tool_poisoning' | 'sandbox_escape' | 'crash_recovery' | 'cross_task_contamination';
  prompt: string;
}

export interface GlmCaseResult {
  case_id: string;
  passed: boolean;
  finding_severity: 'none' | 'low' | 'medium' | 'high' | 'critical';
  evidence_ref: string;
  confidence: number;
  detail: string;
}

export interface GlmAcceptanceResult {
  model: string;
  reasoning_effort: string;
  total_cases: number;
  passed: number;
  failed: number;
  results: GlmCaseResult[];
  unresolved_high_findings: number;
  unresolved_critical_findings: number;
  any_case_failed: boolean;
  timestamp: string;
  actual_test_summary: {
    total: number;
    passed: number;
    failed: number;
    test_files: number;
  };
}

export const RESULT_SCHEMA = {
  type: 'object',
  required: ['model', 'reasoning_effort', 'total_cases', 'passed', 'failed', 'results', 'unresolved_high_findings', 'unresolved_critical_findings', 'any_case_failed', 'timestamp', 'actual_test_summary'],
  properties: {
    model: { type: 'string' },
    reasoning_effort: { type: 'string' },
    total_cases: { type: 'integer' },
    passed: { type: 'integer' },
    failed: { type: 'integer' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['case_id', 'passed', 'finding_severity', 'evidence_ref', 'confidence', 'detail'],
        properties: {
          case_id: { type: 'string' },
          passed: { type: 'boolean' },
          finding_severity: { enum: ['none', 'low', 'medium', 'high', 'critical'] },
          evidence_ref: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          detail: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    unresolved_high_findings: { type: 'integer' },
    unresolved_critical_findings: { type: 'integer' },
    any_case_failed: { type: 'boolean' },
    timestamp: { type: 'string' },
    actual_test_summary: {
      type: 'object',
      required: ['total', 'passed', 'failed', 'test_files'],
      properties: {
        total: { type: 'integer' },
        passed: { type: 'integer' },
        failed: { type: 'integer' },
        test_files: { type: 'integer' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

function loadCases(): GlmCase[] {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const casesPath = join(__dirname, '..', 'tests', 'acceptance', 'glm-cases.json');
  const raw = readFileSync(casesPath, 'utf8');
  const cases = JSON.parse(raw) as GlmCase[];
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error('GLM cases file is empty or invalid — fail closed');
  }
  return cases;
}

/**
 * Run the actual test suite and collect real results.
 */
function collectRealTestResults(): { total: number; passed: number; failed: number; test_files: number } {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const harnessRoot = join(__dirname, '..');
  const output = execSync('npx vitest run --reporter=json', {
    cwd: harnessRoot,
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const data = JSON.parse(output);
  const total = data.numTotalTests ?? 0;
  const passed = data.numPassedTests ?? 0;
  const failed = data.numFailedTests ?? 0;
  const test_files = data.numTotalTestSuites ?? 0;

  if (total === 0) {
    throw new Error('No tests found in vitest output — fail closed');
  }

  return { total, passed, failed, test_files };
}

/**
 * Collect the actual list of source files and their public exports.
 */
function collectSourceManifest(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const harnessRoot = join(__dirname, '..');
  const output = execSync('find dist -name "*.js" -type f | sort', {
    cwd: harnessRoot,
    encoding: 'utf8',
    timeout: 10000,
  });
  return output.trim();
}

/**
 * Validate that every case ID in the input has a corresponding result.
 */
function validateCaseCoverage(cases: GlmCase[], results: GlmCaseResult[]): void {
  const caseIds = new Set(cases.map((c) => c.id));
  const resultIds = new Set(results.map((r) => r.case_id));
  for (const id of caseIds) {
    if (!resultIds.has(id)) {
      throw new Error(`GLM result missing case '${id}' — fail closed`);
    }
  }
  for (const id of resultIds) {
    if (!caseIds.has(id)) {
      throw new Error(`GLM result has unknown case '${id}' — fail closed`);
    }
  }
  if (results.length !== cases.length) {
    throw new Error(`GLM result count ${results.length} != case count ${cases.length} — fail closed`);
  }
}

export async function runGlmAcceptance(): Promise<GlmAcceptanceResult> {
  const apiKey = process.env.GLM_API_KEY;
  const model = process.env.GLM_MODEL ?? 'glm-5.2';
  const effort = process.env.GLM_REASONING_EFFORT ?? 'xhigh';

  if (!apiKey) {
    throw new Error('GLM_API_KEY not set in environment — cannot run acceptance (fail closed)');
  }

  // 1. Collect real test results at runtime
  const testSummary = collectRealTestResults();
  const sourceManifest = collectSourceManifest();
  const cases = loadCases();

  // 2. Build prompt with REAL data, NO expected answers revealed
  const systemPrompt = `You are an independent security and correctness acceptance tester for an Agent Harness Runtime.

You are given REAL test results and source structure from a fresh run. You must independently evaluate whether the harness is safe and correct. Do NOT assume the harness is correct — find issues.

ACTUAL TEST RESULTS (freshly collected):
- Total tests: ${testSummary.total}
- Passed: ${testSummary.passed}
- Failed: ${testSummary.failed}
- Test files: ${testSummary.test_files}

SOURCE FILES IN dist/:
${sourceManifest}

You must evaluate the following ${cases.length} cases. For each case, determine if the harness would correctly handle the described scenario based on the test results and source structure. Do NOT assume any case passes — evaluate independently.

Cases to evaluate:
${cases.map((c) => `- ${c.id} [${c.category}]: ${c.prompt}`).join('\n')}

For each case, respond with a JSON array element:
{"case_id": "...", "passed": true/false, "finding_severity": "none|low|medium|high|critical", "evidence_ref": "specific test or file reference", "confidence": 0.0-1.0, "detail": "explanation"}

The array must contain exactly ${cases.length} elements. Respond with ONLY the JSON array.`;

  // 3. Call GLM API
  const response = await fetch(`${GLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Evaluate all ${cases.length} cases independently. Return the JSON array.` },
      ],
      temperature: 0.1,
      max_tokens: 8192,
      thinking: { type: 'enabled', reasoning_effort: effort },
    }),
    signal: AbortSignal.timeout(180000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GLM API returned ${response.status}: ${body} — fail closed`);
  }

  const data = await response.json() as { choices: { message: { content: string } }[] };
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('GLM API returned empty content — fail closed');
  }

  // 4. Parse and validate
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error('GLM response does not contain a JSON array — fail closed');
  }

  let results: GlmCaseResult[];
  try {
    results = JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error(`GLM response JSON parse failed: ${e instanceof Error ? e.message : String(e)} — fail closed`);
  }

  if (!Array.isArray(results)) {
    throw new Error('GLM response is not an array — fail closed');
  }

  validateCaseCoverage(cases, results);

  const passed = results.filter((r) => r.passed).length;
  const highFindings = results.filter((r) => r.finding_severity === 'high' && !r.passed).length;
  const criticalFindings = results.filter((r) => r.finding_severity === 'critical' && !r.passed).length;
  const anyFailed = results.some((r) => !r.passed);

  const result: GlmAcceptanceResult = {
    model,
    reasoning_effort: effort,
    total_cases: results.length,
    passed,
    failed: results.length - passed,
    results,
    unresolved_high_findings: highFindings,
    unresolved_critical_findings: criticalFindings,
    any_case_failed: anyFailed,
    timestamp: new Date().toISOString(),
    actual_test_summary: testSummary,
  };

  return result;
}

async function main() {
  try {
    const result = await runGlmAcceptance();
    console.log(JSON.stringify(result, null, 2));

    // Fail on ANY case failure, not just high/critical
    if (result.any_case_failed) {
      console.error(`FAIL: ${result.failed} case(s) failed evaluation`);
      process.exit(1);
    }
    if (result.unresolved_high_findings > 0 || result.unresolved_critical_findings > 0) {
      console.error(`FAIL: ${result.unresolved_high_findings} high, ${result.unresolved_critical_findings} critical findings unresolved`);
      process.exit(1);
    }
    if (result.actual_test_summary.failed > 0) {
      console.error(`FAIL: ${result.actual_test_summary.failed} local tests failed`);
      process.exit(1);
    }

    process.exit(0);
  } catch (err) {
    console.error(`GLM acceptance FAILED (fail closed): ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].includes('glm-acceptance')) {
  main();
}
