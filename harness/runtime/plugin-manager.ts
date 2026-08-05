/**
 * AH-RUNTIME-003: Plugin Manager / Hooks System (P1-24, P1-07)
 *
 * Implements 6 hook types: PreToolUse, PostToolUse, UserPromptSubmit,
 * SessionStart, SessionEnd, Stop. Hooks can allow, deny, skip, or
 * force-prompt a tool call. Deny is never bypassed.
 *
 * The kernel calls trigger() at the appropriate points. Hook output is
 * re-validated against schema and policy (AR-007).
 */

export type HookType =
  | 'on_task_start'
  | 'on_task_end'
  | 'on_step_start'
  | 'on_step_end'
  | 'pre_tool_use'
  | 'post_tool_use'
  | 'on_session_start'
  | 'on_session_end'
  | 'on_stop';

export interface HookContext {
  run_id: string;
  step_id?: string;
  tool_name?: string;
  tool_args?: Record<string, unknown>;
  tool_result?: Record<string, unknown>;
  session_id?: string;
}

export type HookAction = 'allow' | 'deny' | 'skip' | 'force_prompt';

export interface HookResult {
  action: HookAction;
  reason?: string;
  modified_args?: Record<string, unknown>;
}

export type HookHandler = (ctx: HookContext) => HookResult | Promise<HookResult>;

export interface HookRegistration {
  type: HookType;
  handler: HookHandler;
  priority: number;
  name: string;
}

export class PluginManager {
  private readonly hooks = new Map<HookType, HookRegistration[]>();

  register(type: HookType, handler: HookHandler, name: string, priority: number = 0): void {
    const reg: HookRegistration = { type, handler, name, priority };
    const list = this.hooks.get(type) ?? [];
    list.push(reg);
    list.sort((a, b) => a.priority - b.priority);
    this.hooks.set(type, list);
  }

 unregister(name: string): void {
    for (const [type, list] of this.hooks) {
      this.hooks.set(type, list.filter((h) => h.name !== name));
    }
  }

 /**
  * Trigger all hooks of a given type. For PreToolUse, the first 'deny'
  * wins and short-circuits. For other types, all hooks run.
  */
  async trigger(type: HookType, ctx: HookContext): Promise<HookResult[]> {
    const list = this.hooks.get(type);
    if (!list || list.length === 0) return [];

    const results: HookResult[] = [];
    for (const reg of list) {
      const result = await reg.handler(ctx);
      results.push(result);
      // PreToolUse: deny short-circuits
      if (type === 'pre_tool_use' && result.action === 'deny') {
        break;
      }
    }
    return results;
  }

  hasHooks(type: HookType): boolean {
    const list = this.hooks.get(type);
    return !!list && list.length > 0;
  }

  listHooks(): { type: HookType; name: string; priority: number }[] {
    const result: { type: HookType; name: string; priority: number }[] = [];
    for (const [type, list] of this.hooks) {
      for (const reg of list) {
        result.push({ type, name: reg.name, priority: reg.priority });
      }
    }
    return result;
  }
}
