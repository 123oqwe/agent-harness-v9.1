/** ReAct: persisted action/observation loop with bounded effects and budgets. */
import type { StrategyContext } from './reasoning-strategy.js';

const NUMBER_WORDS: Readonly<Record<string, number>> = Object.freeze({
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
});

export function explicitOutputLimitInstruction(goal: string): string {
  const wordLimit = goal.match(
    /\b(?:at most|no more than|maximum(?: of)?)\s+(\d+|[a-z]+)\s+words?\b/iu,
  );
  if (wordLimit) {
    const parsed = /^\d+$/u.test(wordLimit[1]!)
      ? Number(wordLimit[1])
      : NUMBER_WORDS[wordLimit[1]!.toLowerCase()];
    if (
      parsed !== undefined &&
      Number.isSafeInteger(parsed) &&
      parsed > 0 &&
      parsed <= 10_000
    ) {
      return ` The final visible answer must contain at most ${parsed} whitespace-separated words.`;
    }
  }
  const characterLimit = goal.match(
    /(?:不超过|至多)\s*(\d+)\s*个?(?:字|字符)/u,
  );
  if (characterLimit) {
    const parsed = Number(characterLimit[1]);
    if (Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 100_000) {
      return ` The final visible answer must contain at most ${parsed} characters.`;
    }
  }
  return '';
}

function canonical(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

export async function runReact(
  context: StrategyContext,
  messages: unknown[],
): Promise<void> {
  const callCounts = new Map<string, number>();
  const allowedTools =
    context.config.run_plan?.tool_grants
      .map((grant) => grant.tool)
      .filter((tool): tool is string => typeof tool === 'string') ?? [];
  const allowedToolSet = new Set(allowedTools);
  const outputLimitInstruction = explicitOutputLimitInstruction(
    context.config.run_plan?.task?.goal ?? context.config.goal,
  );
  while (
    context.iterations < context.config.max_iterations &&
    !context.terminated
  ) {
    const preflight = context.preflight();
    if (preflight) {
      context.terminate(preflight);
      return;
    }
    const budget = context.nextModelBudget();
    if (budget.remaining_tokens <= 0 || budget.max_output_tokens <= 0) {
      context.terminate('budget_exhausted');
      return;
    }
    context.iterations += 1;
    const turn = await context.deps.modelCall(
      messages,
      context.iterations,
      budget,
      {
        system_instruction: `ReAct mode: use workspace tools only when needed. Base each next action on prior tool observations. When complete, return the concise final answer without a tool call.${outputLimitInstruction} Never expose private reasoning.`,
        allowed_tools: allowedTools,
      },
    );
    if (context.terminated) return;
    const recorded = context.recordTurn(turn);
    if (context.terminated) return;
    if (
      turn.stop_reason === 'length' &&
      (turn.content.trim().length === 0 ||
        (turn.tool_calls?.length ?? 0) > 0)
    ) {
      context.terminate('malformed_response');
      return;
    }
    if (turn.stop_reason === 'content_filter') {
      context.terminate('model_refusal');
      return;
    }
    if (context.budgetExceeded()) {
      if (turn.tool_calls) {
        for (const call of turn.tool_calls) {
          context.recordToolCall(recorded, call, `react-${context.iterations}`);
          context.recordObservation(
            recorded,
            call,
            'rejected',
            'model call exceeded run token budget',
            `react-${context.iterations}`,
          );
        }
      }
      context.terminate('budget_exhausted');
      return;
    }
    if (!turn.tool_calls || turn.tool_calls.length === 0) {
      context.terminate('completed');
      return;
    }

    messages.push({
      role: 'assistant',
      content: turn.content,
      ...(turn.reasoning_content === undefined
        ? {}
        : { reasoning_content: turn.reasoning_content }),
      decision_summary: turn.decision_summary,
      tool_calls: turn.tool_calls,
    });
    const duplicateIds = new Set<string>();
    const seenIds = new Set<string>();
    for (const call of turn.tool_calls) {
      if (seenIds.has(call.id)) duplicateIds.add(call.id);
      seenIds.add(call.id);
    }
    for (const call of turn.tool_calls) {
      const stepId = `react-${context.iterations}`;
      context.recordToolCall(recorded, call, stepId);
      if (!allowedToolSet.has(call.name)) {
        context.recordObservation(
          recorded,
          call,
          'rejected',
          'tool is not bound by the frozen RunPlan',
          stepId,
        );
        context.terminate('malformed_response');
        return;
      }
      if (duplicateIds.has(call.id)) {
        context.recordObservation(
          recorded,
          call,
          'rejected',
          'duplicate tool_call id in one model turn',
          stepId,
        );
        context.terminate('malformed_response');
        return;
      }

      const key = `${call.name}:${canonical(call.arguments)}`;
      const count = (callCounts.get(key) ?? 0) + 1;
      callCounts.set(key, count);
      if (count >= 3) {
        context.recordObservation(
          recorded,
          call,
          'rejected',
          'repeated tool call oscillation',
          stepId,
        );
        context.terminate('tool_oscillation');
        return;
      }
      if (!context.deps.toolExecute) {
        context.recordObservation(
          recorded,
          call,
          'rejected',
          'tool executor unavailable',
          stepId,
        );
        context.terminate('malformed_response');
        return;
      }
      try {
        const result = await context.deps.toolExecute(
          call.name,
          call.arguments,
          {
            tool_call_id: call.id,
            step_id: stepId,
            attempt_index: count,
          },
        );
        const observation = context.recordObservation(
          recorded,
          call,
          'ok',
          result,
          stepId,
        );
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(observation),
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'tool execution failed';
        const observation = context.recordObservation(
          recorded,
          call,
          'error',
          message,
          stepId,
        );
        context.deps.session.append('error', {
          tool: call.name,
          tool_call_id: call.id,
          error: message,
          error_type: 'tool_execution',
        });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(observation),
        });
      }
    }
  }
  if (!context.terminated) context.terminate('iteration_limit');
}
