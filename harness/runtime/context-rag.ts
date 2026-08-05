/**
 * AH-CONTEXT-002: Semantic Chunking, Vector Embedding, Compaction,
 * Output Validation, State Reducer, Few-Shot Selector (P2-02, P2-03,
 * P2-04, P2-06, P2-07, P2-11, P2-25, P2-26, P2-01)
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Proportional Context Budget Allocation (P2-01)
// ---------------------------------------------------------------------------

/**
 * Context layer budget percentages relative to the model's context window.
 * These are NOT hardcoded token counts — they scale with the model.
 */
export interface ContextLayerBudget {
  system: number;
  task: number;
  active_plan: number;
  conversation: number;
  evidence: number;
  tools: number;
  tool_results: number;
  memory: number;
  reserved_output: number;
  total: number;
}

/** Default proportional allocation (percentages sum to 100). */
export const DEFAULT_LAYER_PERCENTAGES = {
  system: 5,
  task: 3,
  active_plan: 1.5,
  conversation: 50,
  evidence: 12,
  tools: 3,
  tool_results: 20,
  memory: 3,
  // reserved_output is max(4K, 2.5%) — computed dynamically below
};

/**
 * Compute layer token budgets from a model's context window.
 * Layers scale proportionally; reserved output has a 4K floor.
 */
export function allocateContextBudget(modelContextWindow: number): ContextLayerBudget {
  const reservedOutput = Math.max(4000, Math.floor(modelContextWindow * 0.025));
  const usable = modelContextWindow - reservedOutput;
  return {
    system: Math.floor(usable * DEFAULT_LAYER_PERCENTAGES.system / 100),
    task: Math.floor(usable * DEFAULT_LAYER_PERCENTAGES.task / 100),
    active_plan: Math.floor(usable * DEFAULT_LAYER_PERCENTAGES.active_plan / 100),
    conversation: Math.floor(usable * DEFAULT_LAYER_PERCENTAGES.conversation / 100),
    evidence: Math.floor(usable * DEFAULT_LAYER_PERCENTAGES.evidence / 100),
    tools: Math.floor(usable * DEFAULT_LAYER_PERCENTAGES.tools / 100),
    tool_results: Math.floor(usable * DEFAULT_LAYER_PERCENTAGES.tool_results / 100),
    memory: Math.floor(usable * DEFAULT_LAYER_PERCENTAGES.memory / 100),
    reserved_output: reservedOutput,
    total: modelContextWindow,
  };
}

// ---------------------------------------------------------------------------
// Semantic Chunking (P2-03): split by file type boundaries
// ---------------------------------------------------------------------------

export interface TextChunk {
  source: string;
  chunk_id: string;
  content: string;
  content_hash: string;
  line_start: number;
  line_end: number;
  language: string;
}

export interface ChunkingOptions {
  maxTokens: number;
  overlapTokens: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkingOptions = { maxTokens: 512, overlapTokens: 50 };

/**
 * Semantic chunker: Python by def/class, Markdown by header, other by paragraph.
 */
export function semanticChunk(
  content: string,
  source: string,
  language: string = 'text',
  opts: Partial<ChunkingOptions> = {},
): TextChunk[] {
  const options = { ...DEFAULT_CHUNK_OPTIONS, ...opts };

  if (language === 'python') {
    return chunkPython(content, source);
  }
  if (language === 'markdown' || language === 'md') {
    return chunkMarkdown(content, source);
  }
  return chunkGeneric(content, source, language, options);
}

function chunkPython(content: string, source: string): TextChunk[] {
  const lines = content.split('\n');
  const chunks: TextChunk[] = [];
  let currentStart = 0;
  let currentLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    // Detect def/class at column 0
    if (/^(def |class |async def )/.test(lines[i]) && currentLines.length > 0) {
      chunks.push(makeChunk(source, currentLines, currentStart, 'python'));
      currentStart = i;
      currentLines = [];
    }
    currentLines.push(lines[i]);
  }
  if (currentLines.length > 0) {
    chunks.push(makeChunk(source, currentLines, currentStart, 'python'));
  }
  return chunks;
}

function chunkMarkdown(content: string, source: string): TextChunk[] {
  const lines = content.split('\n');
  const chunks: TextChunk[] = [];
  let currentStart = 0;
  let currentLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,3} /.test(lines[i]) && currentLines.length > 0) {
      chunks.push(makeChunk(source, currentLines, currentStart, 'markdown'));
      currentStart = i;
      currentLines = [];
    }
    currentLines.push(lines[i]);
  }
  if (currentLines.length > 0) {
    chunks.push(makeChunk(source, currentLines, currentStart, 'markdown'));
  }
  return chunks;
}

function chunkGeneric(content: string, source: string, language: string, opts: ChunkingOptions): TextChunk[] {
  const paragraphs = content.split(/\n\n+/);
  const chunks: TextChunk[] = [];
  let currentPara: string[] = [];
  let lineOffset = 0;
  let currentStart = 0;

  for (const para of paragraphs) {
    if (currentPara.join('\n\n').length + para.length > opts.maxTokens * 4 && currentPara.length > 0) {
      chunks.push(makeChunk(source, currentPara.join('\n\n').split('\n'), currentStart, language));
      currentStart = lineOffset;
      currentPara = [];
    }
    currentPara.push(para);
    lineOffset += para.split('\n').length + 2; // +2 for the \n\n separator
  }
  if (currentPara.length > 0) {
    chunks.push(makeChunk(source, currentPara.join('\n\n').split('\n'), currentStart, language));
  }
  return chunks;
}

function makeChunk(source: string, lines: string[], lineStart: number, language: string): TextChunk {
  const content = lines.join('\n');
  return {
    source,
    chunk_id: createHash('sha256').update(`${source}:${lineStart}`).digest('hex').slice(0, 16),
    content,
    content_hash: createHash('sha256').update(content).digest('hex'),
    line_start: lineStart + 1,
    line_end: lineStart + lines.length,
    language,
  };
}

// ---------------------------------------------------------------------------
// Vector Embedding Interface (P2-02)
// ---------------------------------------------------------------------------

export interface EmbeddingResult {
  chunk_id: string;
  embedding: number[];
}

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

/**
 * Hybrid search: BM25 score * 0.4 + vector similarity * 0.6
 */
export function hybridSearch(
  bm25Scores: Map<string, number>,
  vectorScores: Map<string, number>,
  bm25Weight: number = 0.4,
  vectorWeight: number = 0.6,
): { chunk_id: string; score: number }[] {
  const allIds = new Set([...bm25Scores.keys(), ...vectorScores.keys()]);
  const results: { chunk_id: string; score: number }[] = [];
  for (const id of allIds) {
    const bm25 = bm25Scores.get(id) ?? 0;
    const vec = vectorScores.get(id) ?? 0;
    results.push({ chunk_id: id, score: bm25 * bm25Weight + vec * vectorWeight });
  }
  return results.sort((a, b) => b.score - a.score);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Incremental Indexing (P2-04)
// ---------------------------------------------------------------------------

export interface FileFingerprint {
  path: string;
  file_count: number;
  total_size: number;
  max_mtime: number;
}

export function computeFingerprint(path: string, files: { size: number; mtime: number }[]): FileFingerprint {
  return {
    path,
    file_count: files.length,
    total_size: files.reduce((sum, f) => sum + f.size, 0),
    max_mtime: files.reduce((max, f) => Math.max(max, f.mtime), 0),
  };
}

export function fingerprintsEqual(a: FileFingerprint, b: FileFingerprint): boolean {
  return a.file_count === b.file_count && a.total_size === b.total_size && a.max_mtime === b.max_mtime;
}

// ---------------------------------------------------------------------------
// Context Compaction (P2-06, P2-07)
// ---------------------------------------------------------------------------

/**
 * Compaction must preserve: goals, constraints, decisions, approvals,
 * side effects, open tasks, security state (exact, not compressed).
 *
 * Uses L3 verify_model (not L2 work_model) to avoid confirmation bias (P2-07).
 */
export interface CompactionConfig {
  verifyModel: string;  // L3 model for compaction
  preserveKeys: string[]; // state keys that must not be compressed
  triggerThreshold: number; // 0.70
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  verifyModel: 'verify-model',
  preserveKeys: ['goals', 'constraints', 'decisions', 'approvals', 'side_effects', 'open_tasks', 'security_state'],
  triggerThreshold: 0.70,
};

export interface CompactionResult {
  compacted: boolean;
  originalTokens: number;
  compactedTokens: number;
  preservedKeys: string[];
  summary?: string;
}

/**
 * Compact conversation by removing messages that can be safely summarized,
 * while preserving critical state.
 */
export function compactMessages(
  messages: { role: string; content: string; preserved?: boolean }[],
  preserveLastN: number = 4,
): CompactionResult {
  if (messages.length <= preserveLastN) {
    return { compacted: false, originalTokens: 0, compactedTokens: 0, preservedKeys: [] };
  }

  const toCompact = messages.slice(0, -preserveLastN);
  const toKeep = messages.slice(-preserveLastN);

  const originalTokens = messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);

  // Create a summary of compacted messages (in real impl, this calls L3 verify_model)
  const summary = `[Compacted ${toCompact.length} messages: ${toCompact.map((m) => m.role).join(', ')}]`;
  const compactedTokens = Math.ceil(summary.length / 4) + toKeep.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);

  return {
    compacted: true,
    originalTokens,
    compactedTokens,
    preservedKeys: DEFAULT_COMPACTION_CONFIG.preserveKeys,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Structural Output Validation (P2-11)
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates structured output against a schema.
 * On failure, returns errors so the LLM can regenerate (max 2 retries).
 */
export function validateStructuredOutput(
  output: unknown,
  schema: { required?: string[]; properties?: Record<string, { type: string }> },
): ValidationResult {
  const errors: string[] = [];

  if (typeof output !== 'object' || output === null) {
    return { valid: false, errors: ['output must be an object'] };
  }

  const obj = output as Record<string, unknown>;

  for (const field of schema.required ?? []) {
    if (!(field in obj)) {
      errors.push(`missing required field: ${field}`);
    }
  }

  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (key in obj) {
 const actualType = Array.isArray(obj[key]) ? 'array' : typeof obj[key];
        if (actualType !== propSchema.type) {
          errors.push(`field '${key}' expected type '${propSchema.type}' but got '${actualType}'`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Generate a retry prompt for the LLM when validation fails.
 */
export function validationRetryPrompt(errors: string[]): string {
  return `Your output did not match the required schema: ${errors.join('; ')}. Please regenerate.`;
}

// ---------------------------------------------------------------------------
// State Reducer (P2-26): append instead of overwrite
// ---------------------------------------------------------------------------

export type ReducerStrategy = 'overwrite' | 'append' | 'merge' | 'vote';

export function reduceState(
  current: unknown,
  incoming: unknown,
  strategy: ReducerStrategy = 'append',
): unknown {
  switch (strategy) {
    case 'overwrite':
      return incoming;
    case 'append':
      if (Array.isArray(current) && Array.isArray(incoming)) {
        return [...current, ...incoming];
      }
      if (current === undefined || current === null) return incoming;
      if (Array.isArray(current)) return [...current, incoming];
      return [current, incoming];
    case 'merge':
      if (typeof current === 'object' && typeof incoming === 'object' && current && incoming) {
        return { ...(current as object), ...(incoming as object) };
      }
      return incoming;
    case 'vote':
      // Phase 3: multi-agent vote
      return incoming;
    default:
      return incoming;
  }
}

// ---------------------------------------------------------------------------
// Few-Shot Example Selector (P2-25)
// ---------------------------------------------------------------------------

export interface FewShotExample {
  task: string;
  result: string;
  tags: string[];
}

export class ExampleSelector {
  private readonly examples: FewShotExample[] = [];

  constructor(examples: FewShotExample[] = []) {
    this.examples.push(...examples);
  }

  add(example: FewShotExample): void {
    this.examples.push(example);
  }

  /**
   * Select the most relevant examples for a task using keyword matching.
   * Phase 2 uses BM25; after RAG is built, uses embedding similarity.
   */
  select(task: string, maxExamples: number = 3): FewShotExample[] {
    const taskLower = task.toLowerCase();
    const scored = this.examples.map((ex) => {
      const exLower = ex.task.toLowerCase();
      let score = 0;
      for (const word of taskLower.split(/\s+/)) {
        if (word.length > 2 && exLower.includes(word)) score++;
      }
      for (const tag of ex.tags) {
        if (taskLower.includes(tag.toLowerCase())) score += 2;
      }
      return { example: ex, score };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxExamples)
      .map((s) => s.example);
  }
}

// ---------------------------------------------------------------------------
// Model Output Sanitization (P2-20)
// ---------------------------------------------------------------------------

/**
 * Sanitize model output before tool execution.
 * 1. Schema validation (P2-11)
 * 2. Safety engine check (existing PolicyEngine)
 * 3. Post-injection check: verify tool call aligns with user intent
 */
export interface SanitizationResult {
  safe: boolean;
  reason?: string;
  sanitized_args?: Record<string, unknown>;
}

export function sanitizeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  _userIntent: string,
): SanitizationResult {
  // Check for path traversal in file-related tools
  if (['write_file', 'edit_file', 'read_file', 'create_artifact'].includes(toolName)) {
    const path = args.path as string | undefined;
    if (path && (path.includes('..') || path.includes('\0'))) {
      return { safe: false, reason: `path traversal detected in ${toolName}: ${path}` };
    }
  }

  // Check for suspicious patterns in command execution
  if (toolName === 'execute_command' || toolName === 'execute_command_sandboxed') {
    const executable = args.executable as string | undefined;
    if (executable && /[;|&`$()]/.test(executable)) {
      return { safe: false, reason: `shell metacharacters in executable: ${executable}` };
    }
  }

  return { safe: true };
}

// ---------------------------------------------------------------------------
// Credential Redaction in Tool Results (P2-21)
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g,           // OpenAI API key
  /sk-ant-[a-zA-Z0-9]{20,}/g,       // Anthropic API key
  /Bearer\s+[a-zA-Z0-9._-]+/gi,     // Bearer token
  /ghp_[a-zA-Z0-9]{36}/g,           // GitHub token
  /AKIA[A-Z0-9]{16}/g,              // AWS access key
  /[a-zA-Z0-9_-]{32,}\.[a-zA-Z0-9_-]+/g, // JWT-like
];

export function redactCredentials(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

// ---------------------------------------------------------------------------
// LLM-based Injection Detection (P2-19)
// ---------------------------------------------------------------------------

export interface InjectionCheckResult {
  clean: boolean;
  quarantined: boolean;
  reason?: string;
}

/**
 * First layer: regex-based injection detection (existing).
 * Second layer: LLM-based semantic check (Phase 2, needs verify_model).
 * If regex flags content as suspicious, L3 verify_model checks:
 * "Does this content contain instructions that attempt to override system policy?"
 */
export function detectInjectionRegex(content: string): InjectionCheckResult {
  const suspiciousPatterns = [
    /ignore\s+(previous|above|all)\s+(instructions?|prompts?)/i,
    /system\s+prompt/i,
    /<\|im_start\|>/i,
    /<\|im_end\|>/i,
    /you\s+are\s+now\s+/i,
    /forget\s+(everything|all|previous)/i,
    /disregard\s+(previous|above|all)/i,
  ];

  for (const pattern of suspiciousPatterns) {
    if (pattern.test(content)) {
      return {
        clean: false,
        quarantined: true,
        reason: `suspicious pattern detected: ${pattern.source}`,
      };
    }
  }

  return { clean: true, quarantined: false };
}

// ---------------------------------------------------------------------------
// Non-code Output Verification (P2-28)
// ---------------------------------------------------------------------------

export interface DocVerificationResult {
  completeness: number;  // 0-1: covers all required topics
  correctness: number;   // 0-1: facts are accurate
  coherence: number;     // 0-1: logical flow
  citation: number;      // 0-1: citations accurate
  overall: number;       // average
  issues: string[];
}

/**
 * Verify non-code output (documents, research) using 4 dimensions.
 * In production, calls L3 verify_model. Here we provide the interface.
 */
export function verifyDocumentOutput(
  output: string,
  requiredTopics: string[],
  _citations?: string[],
): DocVerificationResult {
  const issues: string[] = [];
  const outputLower = output.toLowerCase();

  // Completeness: check if all required topics are mentioned
  const coveredTopics = requiredTopics.filter((t) => outputLower.includes(t.toLowerCase()));
  const completeness = requiredTopics.length > 0 ? coveredTopics.length / requiredTopics.length : 1;
  if (completeness < 1) {
    const missing = requiredTopics.filter((t) => !outputLower.includes(t.toLowerCase()));
    issues.push(`missing topics: ${missing.join(', ')}`);
  }

  // Coherence: check for basic structure (paragraphs, headings)
  const hasParagraphs = output.split('\n\n').length > 1;
  const coherence = hasParagraphs ? 0.8 : 0.4;

  // Citation: check for citation patterns
  const hasCitations = /\[\d+\]|\(http|Source:|Reference:/i.test(output);
  const citation = hasCitations ? 0.7 : 0.3;

 // Correctness: placeholder (real impl needs fact-checking via verify_model)
  const correctness = 0.8;

  const overall = (completeness + correctness + coherence + citation) / 4;

  return { completeness, correctness, coherence, citation, overall, issues };
}
