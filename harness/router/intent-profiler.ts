/**
 * AH-ROUTER-001: Intent Profiler
 *
 * Normalizes each request into structured features: tool need, dependency
 * count, effect risk, interactivity, file transaction need, and uncertainty.
 * Deterministic: same input produces same output.
 */

export interface TaskFeatures {
  needs_tools: boolean;
  tool_count: number;
  dependency_count: number;
  effect_risk: 'none' | 'low' | 'medium' | 'high';
  requires_interaction: boolean;
  requires_file_transaction: boolean;
  uncertainty: number; // 0-1
  steps_estimated: number;
  domains: string[];
}

export interface ProfilerInput {
  prompt: string;
  available_tools?: string[];
  available_skills?: string[];
  context?: Record<string, unknown>;
}

export function profileIntent(input: ProfilerInput): TaskFeatures {
  const prompt = input.prompt.toLowerCase();
  const tools = input.available_tools ?? [];

  // Detect tool need
  const toolKeywords = ['read', 'write', 'edit', 'search', 'execute', 'run', 'create', 'list', 'parse', 'ask'];
  const needsTools = toolKeywords.some((kw) => prompt.includes(kw)) || tools.length > 0;

  // Count tool mentions
  let toolCount = 0;
  for (const tool of tools) {
    if (prompt.includes(tool.toLowerCase())) toolCount++;
  }
  if (toolCount === 0 && needsTools) toolCount = 1;

  // Detect dependencies (multiple steps)
  const dependencyKeywords = ['then', 'after', 'depends', 'first', 'next', 'finally', 'before'];
  const dependencyCount = dependencyKeywords.filter((kw) => prompt.includes(kw)).length;

  // Detect effect risk
  let effectRisk: TaskFeatures['effect_risk'] = 'none';
  if (/\b(delete|remove|destroy|execute|purchase|publish|send)\b/.test(prompt)) {
    effectRisk = 'high';
  } else if (/\b(write|edit|modify|update|create|install)\b/.test(prompt)) {
    effectRisk = 'medium';
  } else if (/\b(read|list|search|view|show)\b/.test(prompt)) {
    effectRisk = 'low';
  }

  // Detect interactivity
  const requiresInteraction = /\b(ask|prompt|confirm|approve|choose|select)\b/.test(prompt);

  // Detect file transaction
  const requiresFileTransaction = /\b(file|directory|path|repository|code|source)\b/.test(prompt)
    || (needsTools && (prompt.includes('write') || prompt.includes('edit')));

  // Estimate uncertainty
  let uncertainty = 0;
  if (/\b(maybe|might|uncertain|unclear|not sure|approximate)\b/.test(prompt)) uncertainty += 0.3;
  if (dependencyCount > 2) uncertainty += 0.2;
  if (effectRisk === 'high') uncertainty += 0.2;
  uncertainty = Math.min(1, uncertainty);

  // Estimate steps
  let stepsEstimated = 1;
  if (needsTools) stepsEstimated = Math.max(2, toolCount);
  if (dependencyCount > 0) stepsEstimated += dependencyCount;
  if (requiresFileTransaction) stepsEstimated = Math.max(stepsEstimated, 3);

  // Detect domains
  const domains: string[] = [];
  if (/\b(code|function|bug|test|repository|programming)\b/.test(prompt)) domains.push('coding');
  if (/\b(document|pdf|summary|page)\b/.test(prompt)) domains.push('documents');
  if (/\b(research|citation|source|evidence)\b/.test(prompt)) domains.push('research');
  if (/\b(write|draft|article|blog|essay)\b/.test(prompt)) domains.push('writing');
  if (/\b(plan|schedule|task|dependency|goal)\b/.test(prompt)) domains.push('planning');
  if (domains.length === 0) domains.push('general');

  return {
    needs_tools: needsTools,
    tool_count: toolCount,
    dependency_count: dependencyCount,
    effect_risk: effectRisk,
    requires_interaction: requiresInteraction,
    requires_file_transaction: requiresFileTransaction,
    uncertainty,
    steps_estimated: stepsEstimated,
    domains,
  };
}
