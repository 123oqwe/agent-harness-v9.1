/**
 * AH-ROUTER-001: Task Normalizer
 *
 * Normalizes raw user input into a typed TaskContract. The Router consumes
 * TaskContract, never raw strings. This ensures the Router always operates
 * on structured input with explicit goal, success criteria, and constraints.
 */
import type { TaskContract } from '../../spec/types/task-contract.js';

export interface RawTaskInput {
  prompt: string;
  available_tools?: string[];
  available_skills?: string[];
  context?: Record<string, unknown>;
}

export class TaskNormalizer {
  /** Normalize raw input into a typed TaskContract. */
  normalize(input: RawTaskInput): TaskContract {
    if (!input.prompt || input.prompt.trim().length === 0) {
      throw new Error('TaskNormalizer: prompt must not be empty');
    }

    const prompt = input.prompt.trim();
    const constraints: TaskContract['constraints'] = [];

    // Extract budget constraint if mentioned
    const budgetMatch = prompt.match(/\$?(\d+(?:\.\d+)?)\s*(?:dollar|usd|budget)/i);
    if (budgetMatch) {
      const usd = parseFloat(budgetMatch[1]!);
      constraints.push({ type: 'budget', value: String(Math.round(usd * 1_000_000)) });
    }

    // Extract time constraint if mentioned
    const timeMatch = prompt.match(/(\d+)\s*(minute|hour|second)s?/i);
    if (timeMatch) {
      const num = parseInt(timeMatch[1]!, 10);
      const unit = timeMatch[2]!.toLowerCase();
      const ms = unit === 'hour' ? num * 3_600_000 : unit === 'minute' ? num * 60_000 : num * 1_000;
      constraints.push({ type: 'time', value: String(ms) });
    }

    // Extract risk ceiling constraint
    if (/\b(safe|read[- ]?only|no[- ]?write|local[- ]?only)\b/i.test(prompt)) {
      constraints.push({ type: 'risk_ceiling', value: 'read_only' });
    }

   // Extract privacy constraint
   if (/(private|no[- ]?network|offline|local)/i.test(prompt)) {
     constraints.push({ type: 'privacy', value: 'local_only' });
   }

   // Derive success criteria
   const successCriteria: TaskContract['success_criteria'] = [];

   // If the task mentions tests, add a test-based criterion
   if (/\b(tests?|spec|verify|assert)\b/i.test(prompt)) {
     successCriteria.push({ criterion: 'tests pass', verification_method: 'test' });
    }

    // If the task mentions a document or file, add a deterministic criterion
    if (/\b(file|document|pdf|code|diff|artifact)\b/i.test(prompt)) {
      successCriteria.push({ criterion: 'output artifact produced', verification_method: 'deterministic' });
    }

    // Default: semantic criterion
    if (successCriteria.length === 0) {
      successCriteria.push({ criterion: 'task completed as described', verification_method: 'semantic' });
    }

    // Derive priority
    let priority: TaskContract['priority'];
    if (/\b(urgent|asap|critical|immediately)\b/i.test(prompt)) {
      priority = 'urgent';
    } else if (/\b(important|high priority)\b/i.test(prompt)) {
      priority = 'high';
    } else if (/\b(low priority|whenever|no rush)\b/i.test(prompt)) {
      priority = 'low';
    } else {
      priority = 'normal';
    }

    return {
      goal: prompt,
      success_criteria: successCriteria,
      constraints,
      priority,
    };
  }
}
