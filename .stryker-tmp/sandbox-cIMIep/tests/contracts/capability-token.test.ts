// @ts-nocheck
 import { describe, it, expect } from 'vitest';
 import { validateFixture, loadFixture } from '../helpers/schema-validator';
 
 describe('AH-CONTRACT-CAPABILITY-001: capability-token schema', () => {
   it('valid fixture passes full schema validation', () => {
     const data = loadFixture('0', 'valid', 'capability-token.json');
     const result = validateFixture('capability-token.schema.json', data);
     expect(result.valid).toBe(true);
   });
 
   it('invalid fixture fails schema validation', () => {
     const data = loadFixture('0', 'invalid', 'capability-token.json');
     const result = validateFixture('capability-token.schema.json', data);
     expect(result.valid).toBe(false);
   });
 });
