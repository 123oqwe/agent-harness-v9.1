/**
 * AH-RUNTIME-003: Plugin Manager / Hooks System (P1-24, P1-07)
 * 6+ hook types. PreToolUse deny is never bypassed.
 */
export type HookType =
  | 'on_task_start' | 'on_task_end' | 'on_step_start' | 'on_step_end'
  | 'pre_tool_use' | 'post_tool_use' | 'on_session_start' | 'on_session_end' | 'on_stop';

export interface HookContext {
  run_id: string; step_id?: string; tool_name?: string;
  tool_args?: Record<string, unknown>; tool_result?: Record<string, unknown>; session_id?: string;
}

export type HookAction = 'allow' | 'deny' | 'skip' | 'force_prompt';
export interface HookResult { action: HookAction; reason?: string; modified_args?: Record<string, unknown> }
export type HookHandler = (ctx: HookContext) => HookResult | Promise<HookResult>;

export interface HookRegistration { type: HookType; handler: HookHandler; priority: number; name: string }

export class PluginManager {
  private readonly hooks = new Map<HookType, HookRegistration[]>();

  register(type: HookType, handler: HookHandler, name: string, priority = 0): void {
    const list = this.hooks.get(type) ?? [];
    list.push({ type, handler, name, priority });
    list.sort((a, b) => a.priority - b.priority);
    this.hooks.set(type, list);
  }

  unregister(name: string): void {
    for (const [type, list] of this.hooks) this.hooks.set(type, list.filter(h => h.name !== name));
  }

  async trigger(type: HookType, ctx: HookContext): Promise<HookResult[]> {
    const list = this.hooks.get(type);
    if (!list || list.length === 0) return [];
    const results: HookResult[] = [];
    for (const reg of list) {
      const result = await reg.handler(ctx);
      results.push(result);
      if (type === 'pre_tool_use' && result.action === 'deny') break;
    }
    return results;
  }

  hasHooks(type: HookType): boolean {
    const list = this.hooks.get(type);
    return !!list && list.length > 0;
  }
}
