 import { describe, it, expect } from 'vitest';
 import { loadMachine, assertStatesExist, assertTerminalStates, assertTransitionsExist, assertNoDeadStates, assertAllTransitionsValid } from '../helpers/machine-validator';
 
 describe('AH-STATE-RUN-001: run state machine', () => {
   const machine = loadMachine('run.machine.json');
 
   it('has exactly 7 states', () => {
     expect(machine.states.length).toBe(7);
   });
 
   it('has correct state names', () => {
     assertStatesExist(machine, ['CREATED', 'PLANNING', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED']);
   });
 
   it('has correct terminal states', () => {
     assertTerminalStates(machine, ['COMPLETED', 'FAILED', 'CANCELLED']);
   });
 
   it('has key transitions', () => {
     assertTransitionsExist(machine, [
       ['CREATED', 'PLANNING'],
       ['PLANNING', 'RUNNING'],
       ['RUNNING', 'PAUSED'],
       ['PAUSED', 'RUNNING'],
       ['RUNNING', 'COMPLETED'],
       ['RUNNING', 'FAILED'],
       ['RUNNING', 'CANCELLED'],
       ['PAUSED', 'CANCELLED'],
     ]);
   });
 
   it('has no dead states (non-terminal without outgoing)', () => {
     assertNoDeadStates(machine);
   });
 
   it('all transitions reference valid states', () => {
     assertAllTransitionsValid(machine);
   });
 });
