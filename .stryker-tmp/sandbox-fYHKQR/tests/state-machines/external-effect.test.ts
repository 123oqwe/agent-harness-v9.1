// @ts-nocheck
 import { describe, it, expect } from 'vitest';
 import { loadMachine, assertStatesExist, assertTerminalStates, assertTransitionsExist, assertNoDeadStates, assertAllTransitionsValid } from '../helpers/machine-validator';
 
 describe('AH-STATE-EXTERNALEFFECT-001: external-effect state machine', () => {
   const machine = loadMachine('external-effect.machine.json');
 
   it('has at least 14 states', () => {
     expect(machine.states.length).toBeGreaterThanOrEqual(14);
   });
 
   it('has key states', () => {
     assertStatesExist(machine, [
       'PREPARING', 'PREPARED', 'COMMITTING', 'IN_FLIGHT',
       'PROVIDER_ACCEPTED', 'EFFECT_OBSERVED', 'EFFECT_VERIFIED',
       'EFFECT_CONFIRMED', 'EFFECT_UNKNOWN', 'RECONCILING',
       'FAILED', 'EXPIRED', 'AWAITING_HUMAN', 'RECONCILIATION_FAILED',
     ]);
   });
 
   it('has correct terminal states', () => {
     assertTerminalStates(machine, ['EFFECT_CONFIRMED', 'FAILED', 'EXPIRED', 'RECONCILIATION_FAILED']);
   });
 
   it('has key transitions', () => {
     assertTransitionsExist(machine, [
       ['PREPARING', 'PREPARED'],
       ['PREPARING', 'FAILED'],
       ['PREPARED', 'EXPIRED'],
       ['COMMITTING', 'IN_FLIGHT'],
       ['IN_FLIGHT', 'PROVIDER_ACCEPTED'],
       ['IN_FLIGHT', 'EFFECT_UNKNOWN'],
       ['EFFECT_UNKNOWN', 'RECONCILING'],
       ['RECONCILING', 'EFFECT_CONFIRMED'],
       ['RECONCILING', 'AWAITING_HUMAN'],
       ['AWAITING_HUMAN', 'EFFECT_CONFIRMED'],
       ['AWAITING_HUMAN', 'RECONCILIATION_FAILED'],
     ]);
   });
 
   it('has no dead states', () => {
     assertNoDeadStates(machine);
   });
 
   it('all transitions reference valid states', () => {
     assertAllTransitionsValid(machine);
   });
 });
