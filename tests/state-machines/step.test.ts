 import { describe, it, expect } from 'vitest';
 import { loadMachine, assertStatesExist, assertTerminalStates, assertTransitionsExist, assertNoDeadStates, assertAllTransitionsValid } from '../helpers/machine-validator';
 
 describe('AH-STATE-STEP-001: step state machine', () => {
   const machine = loadMachine('step.machine.json');
 
   it('has exactly 7 states', () => {
     expect(machine.states.length).toBe(7);
   });
 
   it('has correct state names', () => {
     assertStatesExist(machine, ['PENDING', 'DISPATCHED', 'EXECUTING', 'VERIFYING', 'DONE', 'FAILED', 'BLOCKED']);
   });
 
   it('has correct terminal states', () => {
     assertTerminalStates(machine, ['DONE']);
   });
 
   it('has key transitions', () => {
     assertTransitionsExist(machine, [
       ['PENDING', 'DISPATCHED'],
       ['PENDING', 'BLOCKED'],
       ['DISPATCHED', 'EXECUTING'],
       ['EXECUTING', 'VERIFYING'],
       ['EXECUTING', 'FAILED'],
       ['VERIFYING', 'DONE'],
       ['VERIFYING', 'FAILED'],
       ['FAILED', 'PENDING'],
       ['BLOCKED', 'PENDING'],
     ]);
   });
 
   it('has no dead states', () => {
     assertNoDeadStates(machine);
   });
 
   it('all transitions reference valid states', () => {
     assertAllTransitionsValid(machine);
   });
 });
