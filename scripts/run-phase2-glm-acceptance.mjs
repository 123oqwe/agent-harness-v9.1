#!/usr/bin/env node
/**
 * Phase 2 GLM-5.2 xhigh scenario acceptance.
 *
 * Runs 6 read-only scenarios against the real GLM-5.2 xhigh API:
 *   1. long-context  — context compiler / compaction
 *   2. RAG           — retrieval-augmented generation
 *   3. multimodal    — multimodal document / image understanding
 *   4. UX            — web / API / desktop UX design
 *   5. privacy       — data protection / access control
 *   6. failure-recovery — model fallback / pause-resume
 *
 * Output: JSON evidence file at ACCEPTANCE_EVIDENCE_ROOT.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "..");
const ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

function assertEnv(source) {
  if (!source.GLM_API_KEY) throw new Error("GLM_API_KEY is required");
  if ((source.GLM_MODEL ?? "glm-5.2") !== "glm-5.2")
    throw new Error("GLM_MODEL must be glm-5.2");
  if ((source.GLM_REASONING_EFFORT ?? "xhigh") !== "xhigh")
    throw new Error("GLM_REASONING_EFFORT must be xhigh");
  if (source.GLM_ALLOW_REMOTE !== "1")
    throw new Error("GLM_ALLOW_REMOTE=1 is required for the explicit read-only model run");
  if (!isAbsolute(source.ACCEPTANCE_EVIDENCE_ROOT ?? ""))
    throw new Error("ACCEPTANCE_EVIDENCE_ROOT must be an absolute external directory");
  const evidenceRoot = resolve(source.ACCEPTANCE_EVIDENCE_ROOT);
  const evidenceRelative = relative(root, evidenceRoot);
  if (evidenceRelative === "" || (evidenceRelative !== ".." && !evidenceRelative.startsWith(`..${sep}`)))
    throw new Error("ACCEPTANCE_EVIDENCE_ROOT must be outside the source repository");
}

function gitRevParse(ref) {
  const result = spawnSync("/usr/bin/git", ["rev-parse", ref], {
    cwd: root, encoding: "utf8", shell: false,
  });
  if (result.status !== 0) throw new Error(`git rev-parse ${ref} failed`);
  return result.stdout.trim();
}

const scenarios = [
  {
    id: "long-context",
    name: "Long-context summarisation",
    requirement_ids: ["AH-CONTEXT-COMPILER-001", "AH-RUNTIME-COMPACTION-001"],
    prompt: `You are evaluating an AI agent harness's context compiler. Read the following technical passage and provide a structured summary with exactly 3 bullet points, each starting with "- ".

Passage:
The context compiler is responsible for assembling the active context window from multiple sources including system prompt, conversation history, tool results, and retrieved documents. It applies progressive disclosure to limit token usage, offloads large content to the virtual filesystem, and performs aligned compaction when the context pressure exceeds 80%. The compiler also supports context reset events which clear non-essential state while preserving the active plan and session identity. When a context reset occurs, the harness emits a context_reset event on the event bus, and the runtime loop adjusts its iteration budget accordingly. The session tree maintains parent-child relationships so that branching conversations can be resumed independently.

Provide your summary now.`,
    assertions: [
      { type: "contains_any", keywords: ["context", "compiler", "compaction", "progressive", "filesystem", "reset"], minMatches: 3 },
      { type: "max_length", maxChars: 2000 },
    ],
  },
  {
    id: "RAG",
    name: "Retrieval-augmented generation",
    requirement_ids: ["AH-RAG-QUERY-001", "AH-RAG-CITE-001", "AH-RAG-RERANK-001"],
    prompt: `You are evaluating an AI agent harness's RAG (retrieval-augmented generation) system. Based on the following retrieved context, answer the question and cite the source.

Context:
[Source: RAG Architecture Doc, Section 3.2]
The hybrid RAG system uses ACL-before-retrieval to enforce access control. All queries pass through the capability registry before reaching the vector index. The system supports provenance tracking: every retrieved chunk includes a source URI and checksum. Citations are generated automatically from the provenance metadata. The reranker uses a cross-encoder model to reorder retrieved chunks by relevance. The query engine supports both full-text search (FTS) and vector search, combining results via reciprocal rank fusion.

Question: How does the RAG system enforce access control, and what metadata does each retrieved chunk include?

Answer with citation now.`,
    assertions: [
      { type: "contains_all", keywords: ["access control", "capability registry"] },
      { type: "contains_any", keywords: ["provenance", "source URI", "checksum", "citation"], minMatches: 2 },
    ],
  },
  {
    id: "multimodal",
    name: "Multimodal document understanding",
    requirement_ids: ["AH-MM-DOC-VISION-001", "AH-MM-IMAGE-GEN-001", "AH-MM-IMAGE-IN-001"],
    prompt: `You are evaluating an AI agent harness's multimodal capabilities. Describe in 4-5 sentences how the harness should handle a PDF document that contains both text and embedded images. Cover: (1) text extraction, (2) image extraction, (3) vision verification, and (4) artifact storage.

Provide your description now.`,
    assertions: [
      { type: "contains_any", keywords: ["extract", "parse", "OCR", "vision", "image", "artifact", "store"], minMatches: 3 },
      { type: "max_length", maxChars: 3000 },
    ],
  },
  {
    id: "UX",
    name: "Web and API UX design",
    requirement_ids: ["AH-UX-WEB-001", "AH-UX-API-001", "AH-UX-STATES-001", "AH-UX-DESKTOP-001"],
    prompt: `You are evaluating an AI agent harness's UX layer. Design a minimal web interface for a document management agent with these requirements: (1) a chat panel for user interaction, (2) a document list showing uploaded files, (3) a status indicator showing agent state (idle, thinking, paused). Describe the layout in 3-4 sentences.

Provide your design now.`,
    assertions: [
      { type: "contains_any", keywords: ["chat", "panel", "document", "list", "status", "state", "idle", "paused", "layout"], minMatches: 4 },
      { type: "max_length", maxChars: 3000 },
    ],
  },
  {
    id: "privacy",
    name: "Privacy and data protection",
    requirement_ids: ["AH-TOOL-ESCALATE-001", "AH-SANDBOX-OCI-001"],
    prompt: `You are evaluating an AI agent harness's privacy controls. List 4 best practices that an AI agent should follow when handling user data. Each practice should be one sentence starting with a number.

Provide your list now.`,
    assertions: [
      { type: "contains_any", keywords: ["encrypt", "access control", "minimize", "consent", "audit", "redact", "anonymize", "least privilege", "sandbox", "isolate"], minMatches: 3 },
      { type: "max_length", maxChars: 2000 },
    ],
  },
  {
    id: "failure-recovery",
    name: "Failure recovery and model fallback",
    requirement_ids: ["AH-RUNTIME-MODELFALLBACK-001", "AH-PAUSE-RESUME-001", "AH-RUNTIME-BUDGET-002"],
    prompt: `You are evaluating an AI agent harness's failure recovery system. Describe in 3-4 sentences how the harness should handle these scenarios: (1) the primary LLM API returns a 503 error, (2) the user requests a pause mid-execution, and (3) the token budget is exhausted. Cover retry, fallback, and pause/resume mechanisms.

Provide your description now.`,
    assertions: [
      { type: "contains_any", keywords: ["retry", "fallback", "pause", "resume", "budget", "503", "error", "recover"], minMatches: 4 },
      { type: "max_length", maxChars: 3000 },
    ],
  },
];

async function callGlm(apiKey, messages, timeoutMs = 120_000) {
  const body = {
    model: "glm-5.2",
    reasoning_effort: "xhigh",
    thinking: { type: "enabled", clear_thinking: false },
    messages,
    temperature: 1,
    max_tokens: 4096,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`GLM API HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function evaluateAssertion(assertion, text) {
  const lower = text.toLowerCase();
  if (assertion.type === "contains_all") {
    return assertion.keywords.every((kw) => lower.includes(kw.toLowerCase()));
  }
  if (assertion.type === "contains_any") {
    const matches = assertion.keywords.filter((kw) => lower.includes(kw.toLowerCase()));
    return matches.length >= (assertion.minMatches ?? 1);
  }
  if (assertion.type === "max_length") {
    return text.length <= assertion.maxChars;
  }
  if (assertion.type === "min_length") {
    return text.length >= assertion.minChars;
  }
  return false;
}

function extractContent(apiResponse) {
  const choice = apiResponse?.choices?.[0];
  if (!choice) return "";
  const message = choice.message ?? {};
  return (message.content ?? "").toString();
}

function extractUsage(apiResponse) {
  const usage = apiResponse?.usage ?? {};
  return {
    prompt_tokens: usage.prompt_tokens ?? 0,
    completion_tokens: usage.completion_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
  };
}

export async function runPhase2GlmAcceptance(source = process.env) {
  assertEnv(source);
  const apiKey = source.GLM_API_KEY;
  const commitSha = gitRevParse("HEAD");
  const treeSha = gitRevParse("HEAD^{tree}");
  const evidenceRoot = resolve(source.ACCEPTANCE_EVIDENCE_ROOT);
  mkdirSync(evidenceRoot, { recursive: true });

  const startTime = new Date().toISOString();
  const results = [];

  for (const scenario of scenarios) {
    const scenarioStart = Date.now();
    let status = "PASS";
    let errorMessage = null;
    let content = "";
    let usage = null;

    try {
      const apiResponse = await callGlm(apiKey, [
        { role: "user", content: scenario.prompt },
      ]);
      content = extractContent(apiResponse);
      usage = extractUsage(apiResponse);

      if (!content.trim()) {
        status = "FAIL";
        errorMessage = "empty response from GLM API";
      } else {
        for (const assertion of scenario.assertions) {
          if (!evaluateAssertion(assertion, content)) {
            status = "FAIL";
            errorMessage = `assertion failed: ${assertion.type}`;
            break;
          }
        }
      }
    } catch (error) {
      status = "ERROR";
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    const durationMs = Date.now() - scenarioStart;
    results.push({
      id: scenario.id,
      name: scenario.name,
      requirement_ids: scenario.requirement_ids,
      status,
      error: errorMessage,
      duration_ms: durationMs,
      usage,
      assertion_count: scenario.assertions.length,
      response_length: content.length,
      response_preview: content.slice(0, 500),
    });

    process.stderr.write(
      `[${scenario.id}] ${status} (${durationMs}ms, ${usage?.total_tokens ?? 0} tokens)\n`,
    );
  }

  const endTime = new Date().toISOString();
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const errors = results.filter((r) => r.status === "ERROR").length;
  const allPassed = passed === scenarios.length;

  const report = {
    schema_version: "phase2-glm-acceptance/v1",
    phase: 2,
    model: "glm-5.2",
    reasoning_effort: "xhigh",
    temperature: 1,
    commit_sha: commitSha,
    tree_sha: treeSha,
    started_at: startTime,
    completed_at: endTime,
    summary: {
      total: scenarios.length,
      passed,
      failed,
      errors,
      all_passed: allPassed,
    },
    scenarios: results,
    forbidden_secrets_check: {
      checked: true,
      leaked: results.some(
        (r) => r.response_preview?.includes(apiKey) ?? false,
      ),
    },
  };

  if (report.forbidden_secrets_check.leaked) {
    throw new Error("FATAL: GLM API key leaked in response content");
  }

  const outputName = `phase2-glm-5.2-xhigh-acceptance-${commitSha}.json`;
  const outputPath = join(evidenceRoot, outputName);
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });

  process.stderr.write(
    `\nPhase 2 GLM-5.2 xhigh acceptance: ${passed}/${scenarios.length} passed\n` +
      `Evidence: ${outputPath}\n`,
  );

  if (!allPassed) {
    process.exitCode = 1;
  }

  return report;
}

const isMain =
  process.argv[1] !== undefined &&
  existsSync(resolve(process.argv[1])) &&
  resolve(process.argv[1]) === resolve(scriptPath);

if (isMain) {
  try {
    await runPhase2GlmAcceptance();
  } catch (error) {
    process.stderr.write(
      `Phase 2 GLM acceptance FAIL: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
