 import { describe, it, expect } from 'vitest';
 import { loadMachine, assertStatesExist, assertTerminalStates, assertTransitionsExist, assertNoDeadStates, assertAllTransitionsValid } from '../helpers/machine-validator';
 
 describe('AH-STATE-OPERATION-001: operation state machine', () => {
   const machine = loadMachine('operation.machine.json');
 
   it('has at least 35 states', () => {
     expect(machine.states.length).toBeGreaterThanOrEqual(35);
   });
 
   it('has key states', () => {
     assertStatesExist(machine, [
       'CREATED', 'COMPILED', 'POLICY_EVALUATED', 'DENIED', 'AUTHORIZED',
       'IN_FLIGHT', 'EFFECT_CONFIRMED', 'EFFECT_UNKNOWN', 'RECONCILING',
       'CANCELLED', 'ABORTED', 'COMPENSATED', 'RETRY_SCHEDULED', 'PARTIAL_COMMIT',
     ]);
   });
 
   it('has correct terminal states', () => {
     assertTerminalStates(machine, [
       'DENIED', 'EFFECT_CONFIRMED', 'CANCELLED', 'ABORTED', 'COMPENSATED',
       'REMEDIATION_REQUIRED', 'ROLLBACK_FAILED',
     ]);
   });
 
   it('has key transitions', () => {
     assertTransitionsExist(machine, [
       ['CREATED', 'COMPILED'],
       ['COMPILED', 'POLICY_EVALUATED'],
       ['POLICY_EVALUATED', 'DENIED'],
       ['AUTHORIZED', 'PREPARING'],
       ['IN_FLIGHT', 'EFFECT_UNKNOWN'],
       ['EFFECT_UNKNOWN', 'RECONCILING'],
       ['RECONCILING', 'EFFECT_CONFIRMED'],
       ['RETRY_SCHEDULED', 'CREATED'],
       ['PARTIAL_COMMIT', 'COMPENSATION_PENDING'],
     ]);
   });
 
   it('has no dead states', () => {
     assertNoDeadStates(machine);
   });
 
   it('all transitions reference valid states', () => {
     assertAllTransitionsValid(machine);
   });
 });
