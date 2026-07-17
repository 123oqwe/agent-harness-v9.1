 import { describe, it, expect } from 'vitest';
 import { validateFixture, loadFixture } from '../helpers/schema-validator';
 
 describe('AH-CONTRACT-RUNPLAN-001: run-plan schema', () => {
   it('valid fixture passes full schema validation', () => {
     const data = loadFixture('0', 'valid', 'run-plan.json');
     const result = validateFixture('run-plan.schema.json', data);
     expect(result.valid).toBe(true);
   });
 
   it('invalid fixture fails schema validation', () => {
     const data = loadFixture('0', 'invalid', 'run-plan.json');
     const result = validateFixture('run-plan.schema.json', data);
     expect(result.valid).toBe(false);
   });
 });
