 import { describe, it, expect } from 'vitest';
 import { loadMachine, assertStatesExist, assertTerminalStates, assertTransitionsExist, assertNoDeadStates, assertAllTransitionsValid } from '../helpers/machine-validator';
 
 describe('AH-STATE-MISSION-001: mission state machine', () => {
   const machine = loadMachine('mission.machine.json');
 
   it('has exactly 10 states', () => {
     expect(machine.states.length).toBe(10);
   });
 
   it('has correct state names', () => {
     assertStatesExist(machine, [
       'CREATED', 'DISCOVER', 'DESIGN', 'BUILD', 'DEPLOY',
       'OPERATE', 'ITERATE', 'COMPLETED', 'FAILED', 'ABORTED',
     ]);
   });
 
   it('has correct terminal states', () => {
     assertTerminalStates(machine, ['COMPLETED', 'FAILED', 'ABORTED']);
   });
 
   it('has key transitions', () => {
     assertTransitionsExist(machine, [
       ['CREATED', 'DISCOVER'],
       ['DISCOVER', 'DESIGN'],
       ['DESIGN', 'BUILD'],
       ['BUILD', 'DEPLOY'],
       ['DEPLOY', 'OPERATE'],
       ['OPERATE', 'ITERATE'],
       ['ITERATE', 'COMPLETED'],
       ['ANY', 'FAILED'],
       ['ANY', 'ABORTED'],
     ]);
   });
 
   it('has no dead states', () => {
     assertNoDeadStates(machine);
   });
 
   it('all transitions reference valid states', () => {
     assertAllTransitionsValid(machine);
   });
 });
