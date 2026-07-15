import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const machinePath = path.resolve(__dirname, '../../../spec/state-machines/attempt.machine.json');

describe('AH-STATE-ATTEMPT-001: attempt state machine', () => {
  it('machine file exists and parses as JSON', () => {
    expect(fs.existsSync(machinePath)).toBe(true);
    const machine = JSON.parse(fs.readFileSync(machinePath, 'utf-8'));
    expect(machine.name || machine.states).toBeDefined();
  });

  it('machine has at least 2 states', () => {
    const machine = JSON.parse(fs.readFileSync(machinePath, 'utf-8'));
    const states = Array.isArray(machine.states) ? machine.states : machine.states;
    expect(states.length).toBeGreaterThanOrEqual(2);
  });

  it('machine has at least 1 transition or invariant', () => {
    const machine = JSON.parse(fs.readFileSync(machinePath, 'utf-8'));
    const hasTransitions = machine.transitions && machine.transitions.length > 0;
    const hasInvariants = machine.invariants && machine.invariants.length > 0;
    expect(hasTransitions || hasInvariants).toBe(true);
  });
});
