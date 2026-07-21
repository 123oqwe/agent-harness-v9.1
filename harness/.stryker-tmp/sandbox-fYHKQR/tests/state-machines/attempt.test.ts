// @ts-nocheck
 import { describe, it, expect } from 'vitest';
 import { loadMachine, assertStatesExist, assertTerminalStates, assertTransitionsExist, assertNoDeadStates, assertAllTransitionsValid } from '../helpers/machine-validator';
 
 describe('AH-STATE-ATTEMPT-001: attempt state machine', () => {
   const machine = loadMachine('attempt.machine.json');
 
   it('has exactly 5 states', () => {
     expect(machine.states.length).toBe(5);
   });
 
   it('has correct state names', () => {
     assertStatesExist(machine, ['INIT', 'DISPATCHING', 'COMPLETED', 'FAILED', 'EXPIRED']);
   });
 
   it('has correct terminal states', () => {
     assertTerminalStates(machine, ['COMPLETED', 'EXPIRED']);
   });
 
   it('has key transitions', () => {
     assertTransitionsExist(machine, [
       ['INIT', 'DISPATCHING'],
       ['DISPATCHING', 'COMPLETED'],
       ['DISPATCHING', 'FAILED'],
       ['DISPATCHING', 'EXPIRED'],
       ['FAILED', 'INIT'],
     ]);
   });
 
   it('has no dead states', () => {
     assertNoDeadStates(machine);
   });
 
   it('all transitions reference valid states', () => {
     assertAllTransitionsValid(machine);
   });
 });
