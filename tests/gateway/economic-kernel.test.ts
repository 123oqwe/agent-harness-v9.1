import { describe, it, expect } from 'vitest';
import { EconomicKernel } from '../../gateway/economic-kernel.js';

describe('EconomicKernel', () => {
  it('creates a budget with zero spent', () => {
    const ek = new EconomicKernel();
    const b = ek.createBudget('task1', 1000);
    expect(b.task_id).toBe('task1');
    expect(b.total).toBe(1000);
    expect(b.spent).toBe(0);
    expect(b.status).toBe('active');
    expect(b.transactions).toHaveLength(0);
  });

  it('spend reduces remaining budget', () => {
    const ek = new EconomicKernel();
    ek.createBudget('task1', 1000);
    expect(ek.spend('task1', 300, 'step1', 'model call')).toBe(true);
    const b = ek.getBudget('task1')!;
    expect(b.spent).toBe(300);
    expect(b.transactions).toHaveLength(1);
    expect(b.transactions[0]!.tx_type).toBe('spend');
  });

  it('spend fails when budget exhausted', () => {
    const ek = new EconomicKernel();
    ek.createBudget('task1', 500);
    expect(ek.spend('task1', 500, 'step1', 'big call')).toBe(true);
    expect(ek.spend('task1', 1, 'step2', 'over budget')).toBe(false);
  });

  it('spend fails for non-existent budget', () => {
    const ek = new EconomicKernel();
    expect(ek.spend('nonexistent', 100, 'step1', 'test')).toBe(false);
  });

  it('budget status changes to exhausted when fully spent', () => {
    const ek = new EconomicKernel();
    ek.createBudget('task1', 500);
    ek.spend('task1', 500, 'step1', 'full spend');
    expect(ek.getBudget('task1')!.status).toBe('exhausted');
  });

  it('refund increases remaining budget', () => {
    const ek = new EconomicKernel();
    ek.createBudget('task1', 1000);
    ek.spend('task1', 500, 'step1', 'spend');
    ek.refund('task1', 200, 'step1', 'partial refund');
    expect(ek.getBudget('task1')!.spent).toBe(300);
    expect(ek.getBudget('task1')!.transactions).toHaveLength(2);
  });

  it('refund reactivates exhausted budget', () => {
    const ek = new EconomicKernel();
    ek.createBudget('task1', 500);
    ek.spend('task1', 500, 'step1', 'full');
    expect(ek.getBudget('task1')!.status).toBe('exhausted');
    ek.refund('task1', 200, 'step1', 'refund');
    expect(ek.getBudget('task1')!.status).toBe('active');
  });

  it('refund does not go negative', () => {
    const ek = new EconomicKernel();
    ek.createBudget('task1', 500);
    ek.spend('task1', 100, 'step1', 'spend');
    ek.refund('task1', 500, 'step1', 'big refund');
    expect(ek.getBudget('task1')!.spent).toBe(0);
  });

  it('settle produces settlement with variance', () => {
    const ek = new EconomicKernel();
    ek.createBudget('task1', 1000);
    ek.spend('task1', 700, 'step1', 'spend');
    const s = ek.settle('task1')!;
    expect(s.budgeted).toBe(1000);
    expect(s.actual).toBe(700);
    expect(s.variance).toBe(300);
    expect(ek.getBudget('task1')!.status).toBe('settled');
  });

  it('settle returns undefined for non-existent budget', () => {
    const ek = new EconomicKernel();
    expect(ek.settle('nonexistent')).toBeUndefined();
  });

  it('wallet operations work independently', () => {
    const ek = new EconomicKernel();
    ek.createWallet('alice', 1000);
    ek.createWallet('bob', 500);
    expect(ek.getBalance('alice')).toBe(1000);
    expect(ek.getBalance('bob')).toBe(500);
    expect(ek.debitWallet('alice', 300)).toBe(true);
    expect(ek.getBalance('alice')).toBe(700);
    expect(ek.debitWallet('bob', 600)).toBe(false);
    expect(ek.getBalance('bob')).toBe(500);
  });

  it('getBalance returns 0 for unknown wallet', () => {
    const ek = new EconomicKernel();
    expect(ek.getBalance('unknown')).toBe(0);
  });

  it('summary returns budget and wallet info', () => {
    const ek = new EconomicKernel();
    ek.createBudget('task1', 1000);
    ek.spend('task1', 500, 'step1', 'spend');
    ek.createWallet('alice', 2000);
    const s = ek.summary() as any;
    expect(s.budgets).toHaveLength(1);
    expect(s.budgets[0].spent).toBe(500);
    expect(s.wallets.alice).toBe(2000);
    expect(s.settlements).toBe(0);
  });
});
