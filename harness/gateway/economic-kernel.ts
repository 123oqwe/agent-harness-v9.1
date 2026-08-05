export type BudgetStatus = 'active' | 'exhausted' | 'settled';

export interface Transaction {
  step_id: string;
  amount: number;
  reason: string;
  timestamp: number;
  tx_type: 'credit' | 'spend' | 'refund' | 'settlement';
}

export interface Budget {
  task_id: string;
  total: number;
  spent: number;
  status: BudgetStatus;
  transactions: Transaction[];
}

export interface Settlement {
  task_id: string;
  budgeted: number;
  actual: number;
  variance: number;
}

export class EconomicKernel {
  private readonly budgets = new Map<string, Budget>();
  private readonly settlements = new Map<string, Settlement>();
  private readonly wallets = new Map<string, number>();

  createBudget(taskId: string, total: number): Budget {
    const budget: Budget = { task_id: taskId, total, spent: 0, status: 'active', transactions: [] };
    this.budgets.set(taskId, budget);
    return budget;
  }

  getBudget(taskId: string): Budget | undefined {
    return this.budgets.get(taskId);
  }

  spend(taskId: string, amount: number, stepId: string, reason: string): boolean {
    const budget = this.budgets.get(taskId);
    if (!budget || budget.status !== 'active') return false;
    if (budget.spent + amount > budget.total) return false;
    budget.spent += amount;
    budget.transactions.push({ step_id: stepId, amount, reason, timestamp: Date.now(), tx_type: 'spend' });
    if (budget.spent >= budget.total) budget.status = 'exhausted';
    return true;
  }

  refund(taskId: string, amount: number, stepId: string, reason: string): void {
    const budget = this.budgets.get(taskId);
    if (!budget) return;
    budget.spent = Math.max(0, budget.spent - amount);
    budget.transactions.push({ step_id: stepId, amount, reason, timestamp: Date.now(), tx_type: 'refund' });
    if (budget.status === 'exhausted' && budget.spent < budget.total) budget.status = 'active';
  }

  settle(taskId: string): Settlement | undefined {
    const budget = this.budgets.get(taskId);
    if (!budget) return undefined;
    const settlement: Settlement = {
      task_id: taskId, budgeted: budget.total, actual: budget.spent,
      variance: budget.total - budget.spent,
    };
    budget.status = 'settled';
    this.settlements.set(taskId, settlement);
    return settlement;
  }

  createWallet(owner: string, initialBalance: number): void {
    this.wallets.set(owner, initialBalance);
  }

  getBalance(owner: string): number {
    return this.wallets.get(owner) ?? 0;
  }

  debitWallet(owner: string, amount: number): boolean {
    const bal = this.wallets.get(owner) ?? 0;
    if (bal < amount) return false;
    this.wallets.set(owner, bal - amount);
    return true;
  }

  summary(): Record<string, unknown> {
    return {
      budgets: [...this.budgets.values()].map(b => ({ task_id: b.task_id, total: b.total, spent: b.spent, status: b.status })),
      settlements: this.settlements.size,
      wallets: Object.fromEntries(this.wallets),
    };
  }
}
