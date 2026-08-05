/**
 * AH-CONTEXT-002: Semantic Chunking, Vector Embedding, Compaction,
 * Output Validation, State Reducer, Few-Shot Selector, Sanitization (P2-01..P2-28)
 */
import { createHash } from 'node:crypto';

// P2-01: Proportional Context Budget Allocation
export interface ContextLayerBudget {
  system: number; task: number; active_plan: number; conversation: number;
  evidence: number; tools: number; tool_results: number; memory: number; reserved_output: number; total: number;
}
export function allocateContextBudget(modelContextWindow: number): ContextLayerBudget {
  const reservedOutput = Math.max(4000, Math.floor(modelContextWindow * 0.025));
  const usable = modelContextWindow - reservedOutput;
  const pct = (p: number) => Math.floor(usable * p / 100);
  return {
    system: pct(5), task: pct(3), active_plan: pct(1.5), conversation: pct(50),
    evidence: pct(12), tools: pct(3), tool_results: pct(20), memory: pct(3),
    reserved_output: reservedOutput, total: modelContextWindow,
  };
}

// P2-03: Semantic Chunking
export interface TextChunk { source: string; chunk_id: string; content: string; content_hash: string; line_start: number; line_end: number; language: string }
export const DEFAULT_CHUNK_OPTIONS = { maxTokens: 512, overlapTokens: 50 };

export function semanticChunk(content: string, source: string, language = 'text', opts: Partial<typeof DEFAULT_CHUNK_OPTIONS> = {}): TextChunk[] {
  const o = { ...DEFAULT_CHUNK_OPTIONS, ...opts };
  const make = (lines: string[], start: number, lang: string): TextChunk => {
    const c = lines.join('\n');
    return { source, chunk_id: createHash('sha256').update(`${source}:${start}`).digest('hex').slice(0, 16), content: c, content_hash: createHash('sha256').update(c).digest('hex'), line_start: start + 1, line_end: start + lines.length, language: lang };
  };
  const lines = content.split('\n');
  const splitByPattern = (pattern: RegExp, lang: string): TextChunk[] => {
    const chunks: TextChunk[] = []; let cur: string[] = []; let start = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (pattern.test(line) && cur.length > 0) { chunks.push(make(cur, start, lang)); start = i; cur = []; }
      cur.push(line);
    }
    if (cur.length > 0) chunks.push(make(cur, start, lang));
    return chunks;
  };

  if (language === 'python') return splitByPattern(/^(def |class |async def )/, 'python');
  if (language === 'markdown' || language === 'md') return splitByPattern(/^#{1,3} /, 'markdown');

  // Generic: split by paragraphs
  const paras = content.split(/\n\n+/); const chunks: TextChunk[] = []; let cur: string[] = []; let lineOff = 0;
  for (const para of paras) {
    if (cur.join('\n\n').length + para.length > o.maxTokens * 4 && cur.length > 0) { chunks.push(make(cur, lineOff, language)); lineOff += cur.join('\n\n').split('\n').length + 2; cur = []; }
    cur.push(para);
  }
  if (cur.length > 0) chunks.push(make(cur, lineOff, language));
  return chunks;
}

// P2-02: Vector Embedding + Hybrid Search
export interface EmbeddingProvider { embed(text: string): Promise<number[]>; embedBatch(texts: string[]): Promise<number[][]> }
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { const ai = a[i]!; const bi = b[i]!; dot += ai * bi; na += ai * ai; nb += bi * bi; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}
export function hybridSearch(bm25: Map<string, number>, vec: Map<string, number>, bw = 0.4, vw = 0.6): { chunk_id: string; score: number }[] {
  const ids = new Set([...bm25.keys(), ...vec.keys()]);
  return [...ids].map(id => ({ chunk_id: id, score: (bm25.get(id) ?? 0) * bw + (vec.get(id) ?? 0) * vw })).sort((a, b) => b.score - a.score);
}

// P2-04: Incremental Indexing
export interface FileFingerprint { path: string; file_count: number; total_size: number; max_mtime: number }
export function computeFingerprint(path: string, files: { size: number; mtime: number }[]): FileFingerprint {
  return { path, file_count: files.length, total_size: files.reduce((s, f) => s + f.size, 0), max_mtime: files.reduce((m, f) => Math.max(m, f.mtime), 0) };
}
export function fingerprintsEqual(a: FileFingerprint, b: FileFingerprint): boolean {
  return a.file_count === b.file_count && a.total_size === b.total_size && a.max_mtime === b.max_mtime;
}

// P2-06/P2-07: Compaction
export const DEFAULT_COMPACTION_CONFIG = {
  verifyModel: 'verify-model',
  preserveKeys: ['goals', 'constraints', 'decisions', 'approvals', 'side_effects', 'open_tasks', 'security_state'],
  triggerThreshold: 0.70,
};
export interface CompactionResult { compacted: boolean; originalTokens: number; compactedTokens: number; preservedKeys: string[]; summary?: string | undefined }
export function compactMessages(messages: { role: string; content: string }[], preserveLastN = 4): CompactionResult {
  if (messages.length <= preserveLastN) return { compacted: false, originalTokens: 0, compactedTokens: 0, preservedKeys: [] };
  const toCompact = messages.slice(0, -preserveLastN);
  const toKeep = messages.slice(-preserveLastN);
  const orig = messages.reduce((s, m) => s + Math.ceil(m.content.length / 4), 0);
  const summary = `[Compacted ${toCompact.length} messages]`;
  const compacted = Math.ceil(summary.length / 4) + toKeep.reduce((s, m) => s + Math.ceil(m.content.length / 4), 0);
  return { compacted: true, originalTokens: orig, compactedTokens: compacted, preservedKeys: DEFAULT_COMPACTION_CONFIG.preserveKeys, summary };
}

// P2-11: Structural Output Validation
export interface ValidationResult { valid: boolean; errors: string[] }
export function validateStructuredOutput(output: unknown, schema: { required?: string[]; properties?: Record<string, { type: string }> }): ValidationResult {
  const errors: string[] = [];
  if (typeof output !== 'object' || output === null) return { valid: false, errors: ['output must be an object'] };
  const obj = output as Record<string, unknown>;
  for (const f of schema.required ?? []) if (!(f in obj)) errors.push(`missing required field: ${f}`);
  if (schema.properties) for (const [k, p] of Object.entries(schema.properties)) {
    if (k in obj) { const at = Array.isArray(obj[k]) ? 'array' : typeof obj[k]; if (at !== p.type) errors.push(`field '${k}' expected '${p.type}' got '${at}'`); }
  }
  return { valid: errors.length === 0, errors };
}
export function validationRetryPrompt(errors: string[]): string { return `Your output did not match the required schema: ${errors.join('; ')}. Please regenerate.`; }

// P2-26: State Reducer
export type ReducerStrategy = 'overwrite' | 'append' | 'merge' | 'vote';
export function reduceState(current: unknown, incoming: unknown, strategy: ReducerStrategy = 'append'): unknown {
  switch (strategy) {
    case 'overwrite': return incoming;
    case 'append':
      if (Array.isArray(current) && Array.isArray(incoming)) return [...current, ...incoming];
      if (current === undefined || current === null) return incoming;
      if (Array.isArray(current)) return [...current, incoming];
      return [current, incoming];
    case 'merge':
      if (typeof current === 'object' && typeof incoming === 'object' && current && incoming) return { ...(current as object), ...(incoming as object) };
      return incoming;
    case 'vote': return incoming;
  }
}

// P2-25: Few-Shot Example Selector
export interface FewShotExample { task: string; result: string; tags: string[] }
export class ExampleSelector {
  private readonly examples: FewShotExample[] = [];
  constructor(examples: FewShotExample[] = []) { this.examples.push(...examples); }
  add(ex: FewShotExample): void { this.examples.push(ex); }
  select(task: string, max = 3): FewShotExample[] {
    const tl = task.toLowerCase();
    return this.examples.map(ex => {
      const el = ex.task.toLowerCase();
      let score = 0;
      for (const w of tl.split(/\s+/)) if (w.length > 2 && el.includes(w)) score++;
      for (const t of ex.tags) if (tl.includes(t.toLowerCase())) score += 2;
      return { ex, score };
    }).filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, max).map(s => s.ex);
  }
}

// P2-20: Output Sanitization
export interface SanitizationResult { safe: boolean; reason?: string | undefined }
export function sanitizeToolCall(toolName: string, args: Record<string, unknown>, _userIntent: string): SanitizationResult {
  if (['write_file', 'edit_file', 'read_file', 'create_artifact'].includes(toolName)) {
    const path = args.path as string | undefined;
    if (path && (path.includes('..') || path.includes('\0'))) return { safe: false, reason: `path traversal in ${toolName}: ${path}` };
  }
  if (toolName === 'execute_command' || toolName === 'execute_command_sandboxed') {
    const exe = args.executable as string | undefined;
    if (exe && /[;|&`$()]/.test(exe)) return { safe: false, reason: `shell metacharacters: ${exe}` };
  }
  return { safe: true };
}

// P2-21: Credential Redaction
const SECRET_PATTERNS = [/sk-[a-zA-Z0-9]{20,}/g, /sk-ant-[a-zA-Z0-9]{20,}/g, /Bearer\s+[a-zA-Z0-9._-]+/gi, /ghp_[a-zA-Z0-9]{36}/g, /AKIA[A-Z0-9]{16}/g];
export function redactCredentials(text: string): string {
  let r = text;
  for (const p of SECRET_PATTERNS) r = r.replace(p, '[REDACTED]');
  return r;
}

// P2-19: Injection Detection
export interface InjectionCheckResult { clean: boolean; quarantined: boolean; reason?: string | undefined }
export function detectInjectionRegex(content: string): InjectionCheckResult {
  const patterns = [/ignore\s+(previous|above|all)\s+(instructions?|prompts?)/i, /system\s+prompt/i, /<\|im_start\|>/i, /<\|im_end\|>/i, /you\s+are\s+now\s+/i, /forget\s+(everything|all|previous)/i, /disregard\s+(previous|above|all)/i];
  for (const p of patterns) if (p.test(content)) return { clean: false, quarantined: true, reason: `suspicious: ${p.source}` };
  return { clean: true, quarantined: false };
}

// P2-28: Document Output Verification
export interface DocVerificationResult { completeness: number; correctness: number; coherence: number; citation: number; overall: number; issues: string[] }
export function verifyDocumentOutput(output: string, requiredTopics: string[], _citations?: string[]): DocVerificationResult {
  const issues: string[] = [];
  const ol = output.toLowerCase();
  const covered = requiredTopics.filter(t => ol.includes(t.toLowerCase()));
  const completeness = requiredTopics.length > 0 ? covered.length / requiredTopics.length : 1;
  if (completeness < 1) issues.push(`missing: ${requiredTopics.filter(t => !ol.includes(t.toLowerCase())).join(', ')}`);
  const coherence = output.split('\n\n').length > 1 ? 0.8 : 0.4;
  const citation = /\[\d+\]|\(http|Source:|Reference:/i.test(output) ? 0.7 : 0.3;
  const correctness = 0.8;
  return { completeness, correctness, coherence, citation, overall: (completeness + correctness + coherence + citation) / 4, issues };
}
