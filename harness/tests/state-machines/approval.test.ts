 import { describe, it, expect } from 'vitest';
 import { loadMachine, assertStatesExist, assertTerminalStates, assertTransitionsExist, assertNoDeadStates, assertAllTransitionsValid } from '../helpers/machine-validator';
 
 describe('AH-STATE-APPROVAL-001: approval state machine', () => {
   const machine = loadMachine('approval.machine.json');
 
   it('has exactly 7 states', () => {
     expect(machine.states.length).toBe(7);
   });
 
   it('has correct state names', () => {
     assertStatesExist(machine, [
       'CONSENT_EXEMPT', 'CONSENT_REQUIRED', 'HUMAN_APPROVED',
       'HUMAN_REJECTED', 'EXPIRED', 'AWAITING_HUMAN', 'REMEDIATION_REQUIRED',
     ]);
   });
 
   it('has correct terminal states', () => {
     assertTerminalStates(machine, ['HUMAN_APPROVED', 'HUMAN_REJECTED', 'EXPIRED', 'REMEDIATION_REQUIRED']);
   });
 
   it('has key transitions', () => {
     assertTransitionsExist(machine, [
       ['CONSENT_EXEMPT', 'HUMAN_APPROVED'],
       ['CONSENT_REQUIRED', 'HUMAN_APPROVED'],
       ['CONSENT_REQUIRED', 'HUMAN_REJECTED'],
       ['CONSENT_REQUIRED', 'EXPIRED'],
       ['AWAITING_HUMAN', 'HUMAN_APPROVED'],
       ['AWAITING_HUMAN', 'REMEDIATION_REQUIRED'],
     ]);
   });
 
   it('has no dead states', () => {
     assertNoDeadStates(machine);
   });
 
   it('all transitions reference valid states', () => {
     assertAllTransitionsValid(machine);
   });
 });
