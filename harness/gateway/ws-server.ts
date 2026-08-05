import { WebSocketServer, WebSocket } from 'ws';
import { ManagedGateway } from './managed-gateway.js';
import type { KeyVault } from './key-vault.js';
import type { EconomicKernel } from './economic-kernel.js';
import type { Harness } from '../harness.js';
import type { TaskContract } from '../../spec/types/task-contract.js';

export interface WsServerOptions {
  port: number;
  gateway: ManagedGateway;
  harnessFactory: (gateway: ManagedGateway, userId: string, taskId: string) => Harness;
  economic?: EconomicKernel;
}

interface ClientSession {
  ws: WebSocket;
  userId: string;
  taskId: string | null;
}

export class GatewayWsServer {
  private readonly wss: WebSocketServer;
  private readonly gateway: ManagedGateway;
  private readonly harnessFactory: (gateway: ManagedGateway, userId: string, taskId: string) => Harness;
  private readonly economic: EconomicKernel | undefined;
  private readonly sessions = new Map<WebSocket, ClientSession>();
  private running = false;

  constructor(opts: WsServerOptions) {
    this.wss = new WebSocketServer({ port: opts.port });
    this.gateway = opts.gateway;
    this.harnessFactory = opts.harnessFactory;
    this.economic = opts.economic;
  }

  start(): void {
    this.running = true;
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    const addr = this.wss.address();
    const port = typeof addr === 'object' && addr ? addr.port : opts_port;
    console.log(`Gateway WebSocket server running on ws://localhost:${port}`);
    console.log('  Connect via WebSocket, send: {"type":"task","goal":"...","budget_usd":0.5}');
    console.log('  Events stream back: task_started, model_call, tool_call, progress, task_complete');
  }

  private onConnection(ws: WebSocket, req: import('http').IncomingMessage): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const userId = url.searchParams.get('user') ?? `user-${Date.now()}`;
    const session: ClientSession = { ws, userId, taskId: null };
    this.sessions.set(ws, session);

    this.send(ws, { type: 'connected', user_id: userId, models: this.gateway.getAvailableModels() });

    ws.on('message', (data) => this.onMessage(ws, session, data));
    ws.on('close', () => { this.sessions.delete(ws); });
    ws.on('error', () => { this.sessions.delete(ws); });
  }

  private async onMessage(ws: WebSocket, session: ClientSession, data: import('ws').RawData): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      this.send(ws, { type: 'error', error: 'Invalid JSON' });
      return;
    }

    switch (msg['type']) {
      case 'task': {
        await this.handleTask(ws, session, msg);
        break;
      }
      case 'usage': {
        this.send(ws, { type: 'usage', summary: this.gateway.getUsageSummary() });
        break;
      }
      case 'models': {
        this.send(ws, { type: 'models', models: this.gateway.getAvailableModels() });
        break;
      }
      case 'economic': {
        this.send(ws, { type: 'economic', summary: this.economic?.summary() ?? {} });
        break;
      }
      default:
        this.send(ws, { type: 'error', error: `Unknown message type: ${msg['type'] ?? 'null'}` });
    }
  }

  private async handleTask(ws: WebSocket, session: ClientSession, msg: Record<string, unknown>): Promise<void> {
    const goal = msg['goal'] as string | undefined;
    if (!goal || typeof goal !== 'string') {
      this.send(ws, { type: 'error', error: 'Missing "goal" field' });
      return;
    }

    const budgetUsd = (msg['budget_usd'] as number | undefined) ?? 1.0;
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    session.taskId = taskId;

    if (this.economic) {
      this.economic.createBudget(taskId, budgetUsd);
      this.economic.createWallet(session.userId, 100.0);
    }

    const rawCriteria = msg['success_criteria'] as Array<{ criterion: string; verification_method: string }> | undefined;
    const successCriteria: Array<{ criterion: string; verification_method: 'deterministic' | 'test' | 'human_review' | 'semantic' }> =
      (rawCriteria ?? [{ criterion: 'task completed', verification_method: 'deterministic' }]).map(c => ({
        criterion: c.criterion,
        verification_method: (['deterministic', 'test', 'human_review', 'semantic'].includes(c.verification_method)
          ? c.verification_method
          : 'deterministic') as 'deterministic' | 'test' | 'human_review' | 'semantic',
      }));

    const task: TaskContract = {
      goal,
      success_criteria: successCriteria,
      constraints: [{ type: 'budget', value: String(budgetUsd) }],
    };

    this.send(ws, { type: 'task_started', task_id: taskId, budget_usd: budgetUsd });

    try {
      const harness = this.harnessFactory(this.gateway, session.userId, taskId);
      const outcome = await harness.run(task, taskId);

      this.send(ws, {
        type: 'task_complete',
        task_id: taskId,
        success: outcome.success,
        iterations: outcome.evidence.iterations,
        termination_reason: outcome.evidence.termination_reason,
        budget_used: this.economic?.getBudget(taskId)?.spent ?? 0,
        budget_remaining: this.economic
          ? (this.economic.getBudget(taskId)?.total ?? 0) - (this.economic.getBudget(taskId)?.spent ?? 0)
          : 0,
      });
    } catch (e) {
      this.send(ws, { type: 'task_failed', task_id: taskId, error: (e as Error).message });
    }
  }

  private send(ws: WebSocket, msg: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  stop(): void {
    this.running = false;
    for (const [ws] of this.sessions) {
      ws.close();
    }
    this.sessions.clear();
    this.wss.close();
  }

  get isRunning(): boolean { return this.running; }
  get clientCount(): number { return this.sessions.size; }
}

const opts_port = 0;
