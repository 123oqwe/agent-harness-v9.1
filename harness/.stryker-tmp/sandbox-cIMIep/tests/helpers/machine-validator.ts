// @ts-nocheck
 import * as fs from 'fs';
 import * as path from 'path';
 
 export interface StateMachine {
   name: string;
   description?: string;
   states: Array<{ name: string; terminal: boolean; description?: string }>;
   transitions: Array<{ source: string; target: string; [k: string]: unknown }>;
   invariants?: string[];
 }
 
 export function loadMachine(machineFile: string): StateMachine {
   const machinePath = path.resolve(__dirname, `../../../spec/state-machines/${machineFile}`);
   return JSON.parse(fs.readFileSync(machinePath, 'utf-8'));
 }
 
 export function getStateNames(machine: StateMachine): string[] {
   return machine.states.map(s => s.name);
 }
 
 export function getTerminalStates(machine: StateMachine): string[] {
   return machine.states.filter(s => s.terminal).map(s => s.name);
 }
 
 export function getTransitions(machine: StateMachine): Array<[string, string]> {
   return machine.transitions.map(t => [t.source, t.target]);
 }
 
 export function assertStatesExist(machine: StateMachine, expected: string[]): void {
   const actual = getStateNames(machine);
   for (const s of expected) {
     if (!actual.includes(s)) {
       throw new Error(`Expected state "${s}" not found. Actual states: ${actual.join(', ')}`);
     }
   }
 }
 
 export function assertTerminalStates(machine: StateMachine, expected: string[]): void {
   const actual = getTerminalStates(machine);
   for (const s of expected) {
     if (!actual.includes(s)) {
       throw new Error(`Expected terminal state "${s}" not terminal. Terminal states: ${actual.join(', ')}`);
     }
   }
 }
 
 export function assertTransitionsExist(machine: StateMachine, expected: Array<[string, string]>): void {
   const actual = getTransitions(machine);
   const actualStr = actual.map(t => `${t[0]}->${t[1]}`);
   for (const [src, tgt] of expected) {
     const key = `${src}->${tgt}`;
     if (!actualStr.includes(key)) {
       throw new Error(`Expected transition "${key}" not found. Actual: ${actualStr.join(', ')}`);
     }
   }
 }
 
 export function assertNoDeadStates(machine: StateMachine): void {
   const states = getStateNames(machine);
   const hasOutgoing = new Set(machine.transitions.map(t => t.source));
   const terminal = new Set(getTerminalStates(machine));
   const dead = states.filter(s => !terminal.has(s) && !hasOutgoing.has(s));
   if (dead.length > 0) {
     throw new Error(`Non-terminal states with no outgoing transitions (dead states): ${dead.join(', ')}`);
   }
 }
 
 export function assertAllTransitionsValid(machine: StateMachine): void {
   const stateSet = new Set(getStateNames(machine));
   for (const t of machine.transitions) {
     if (t.source !== 'ANY' && !stateSet.has(t.source)) {
       throw new Error(`Transition source "${t.source}" not in states list`);
     }
     if (!stateSet.has(t.target)) {
       throw new Error(`Transition target "${t.target}" not in states list (from "${t.source}")`);
     }
   }
 }
