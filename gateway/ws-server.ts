import { WebSocketServer, WebSocket } from 'ws';
import type { ManagedGateway } from './managed-gateway.js';
import type { EconomicKernel } from './economic-kernel.js';
import type { Harness } from '../harness.js';
import type { TaskContract } from '../contracts/index.js';

export interface WsServerOptions {
  port: number;
  gateway: ManagedGateway;
  economic?: EconomicKernel;
  harnessFactory?: (gateway: ManagedGateway, userId: string, taskId: string) => Harness;
}

interface ClientSession {
  ws: WebSocket;
  userId: string;
  taskId: string | null;
}

export class GatewayWsServer {
  private readonly wss: WebSocketServer;
  private readonly gateway: ManagedGateway;
  private readonly economic: EconomicKernel | undefined;
  private readonly harnessFactory: ((gateway: ManagedGateway, userId: string, taskId: string) => Harness) | undefined;
  private readonly sessions = new Map<WebSocket, ClientSession>();
  private running = false;

  constructor(opts: WsServerOptions) {
    this.wss = new WebSocketServer({ port: opts.port });
    this.gateway = opts.gateway;
    this.economic = opts.economic;
    this.harnessFactory = opts.harnessFactory;
  }

  start(): void {
    this.running = true;
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    const addr = this.wss.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    console.log(`Gateway WebSocket server running on ws://localhost:${port}`);
    console.log('  Send: {"type":"task","goal":"...","budget_usd":0.5}');
    console.log('  Or stream: {"type":"task_stream","goal":"...","budget_usd":0.5}');
  }

  private onConnection(ws: WebSocket, req: import('http').IncomingMessage): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const userId = url.searchParams.get('user') ?? `user-${Date.now()}`;
    const session: ClientSession = { ws, userId, taskId: null };
    this.sessions.set(ws, session);
    this.send(ws, { type: 'connected', user_id: userId, models: this.gateway.getAvailableModels() });
    ws.on('message', (data) => { void this.onMessage(ws, session, data); });
    ws.on('close', () => { this.sessions.delete(ws); });
    ws.on('error', () => { this.sessions.delete(ws); });
  }

  private async onMessage(ws: WebSocket, session: ClientSession, data: import('ws').RawData): Promise<void> {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(data.toString()) as Record<string, unknown>; }
    catch { this.send(ws, { type: 'error', error: 'Invalid JSON' }); return; }

    const goal = msg['goal'] as string | undefined;
    const budgetUsd = (msg['budget_usd'] as number | undefined) ?? 1.0;
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    session.taskId = taskId;

    switch (msg['type']) {
      case 'task': await this.handleTask(ws, session, goal, taskId, budgetUsd); break;
      case 'task_stream': await this.handleTaskStream(ws, session, goal, taskId, budgetUsd); break;
      case 'usage': this.send(ws, { type: 'usage', summary: this.gateway.getUsageSummary(), cache: this.gateway.getCacheMetrics() }); break;
      case 'models': this.send(ws, { type: 'models', models: this.gateway.getAvailableModels() }); break;
      case 'economic': this.send(ws, { type: 'economic', summary: this.economic?.summary() ?? {} }); break;
      default: this.send(ws, { type: 'error', error: `Unknown type: ${msg['type'] ?? 'null'}` });
    }
  }

  private async handleTask(ws: WebSocket, session: ClientSession, goal: string | undefined, taskId: string, budgetUsd: number): Promise<void> {
    if (!goal) { this.send(ws, { type: 'error', error: 'Missing "goal"' }); return; }
    if (this.economic) { this.economic.createBudget(taskId, budgetUsd); this.economic.createWallet(session.userId, 100.0); }

    // If harnessFactory is provided, route through the full Harness pipeline
    // (Policy → Router → Loop → ModelGateway → Tools → Verification).
    // Otherwise, fall back to direct ManagedGateway.complete().
    this.send(ws, { type: 'task_started', task_id: taskId, budget_usd: budgetUsd });
    if (this.harnessFactory) {
      try {
        const harness = this.harnessFactory(this.gateway, session.userId, taskId);
        const task: TaskContract = {
          goal: goal!,
          success_criteria: [{ criterion: 'task completed', verification_method: 'deterministic' }],
          constraints: [{ type: 'budget', value: String(budgetUsd) }],
        };
        const outcome = await harness.run(task, taskId);
        this.send(ws, {
          type: 'task_complete', task_id: taskId,
          success: outcome.success,
          iterations: outcome.evidence.iterations,
          termination_reason: outcome.evidence.termination_reason,
          budget_remaining: this.economic ? (this.economic.getBudget(taskId)?.total ?? 0) - (this.economic.getBudget(taskId)?.spent ?? 0) : 0,
        });
      } catch (e) {
        this.send(ws, { type: 'task_failed', task_id: taskId, error: (e as Error).message });
      }
      return;
    }

    try {
      const result = await this.gateway.complete(goal, {
        userId: session.userId, taskId, stepId: 'model', tier: 'work',
        requiredCapabilities: ['reasoning'],
      });
      this.send(ws, {
        type: 'task_complete', task_id: taskId,
        success: result.usage.success,
        response: result.response,
        model_used: result.model_used, provider_used: result.provider_used,
        cost_usd: result.usage.cost_usd,
        fallback_triggered: result.fallback_triggered,
        budget_remaining: this.economic ? (this.economic.getBudget(taskId)?.total ?? 0) - (this.economic.getBudget(taskId)?.spent ?? 0) : 0,
      });
    } catch (e) {
      this.send(ws, { type: 'task_failed', task_id: taskId, error: (e as Error).message });
    }
  }

  private async handleTaskStream(ws: WebSocket, session: ClientSession, goal: string | undefined, taskId: string, budgetUsd: number): Promise<void> {
    if (!goal) { this.send(ws, { type: 'error', error: 'Missing "goal"' }); return; }
    if (this.economic) { this.economic.createBudget(taskId, budgetUsd); this.economic.createWallet(session.userId, 100.0); }
    this.send(ws, { type: 'task_started', task_id: taskId, budget_usd: budgetUsd, streaming: true });
    try {
      for await (const event of this.gateway.completeStream(goal, {
        userId: session.userId, taskId, stepId: 'model', tier: 'work',
        requiredCapabilities: ['reasoning'],
      })) {
        if (ws.readyState !== WebSocket.OPEN) break;
        this.send(ws, { task_id: taskId, ...event });
      }
      this.send(ws, {
        type: 'task_complete', task_id: taskId, streaming: true,
        budget_remaining: this.economic ? (this.economic.getBudget(taskId)?.total ?? 0) - (this.economic.getBudget(taskId)?.spent ?? 0) : 0,
      });
    } catch (e) {
      this.send(ws, { type: 'task_failed', task_id: taskId, error: (e as Error).message });
    }
  }

  private send(ws: WebSocket, msg: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  stop(): void {
    this.running = false;
    for (const [ws] of this.sessions) ws.close();
    this.sessions.clear();
    this.wss.close();
  }
  get isRunning(): boolean { return this.running; }
  get clientCount(): number { return this.sessions.size; }
}
