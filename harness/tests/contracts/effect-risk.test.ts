 import { describe, it, expect } from 'vitest';
 import { validateFixture, loadFixture } from '../helpers/schema-validator';
 
 describe('AH-CONTRACT-EFFECTRISK-001: effect-risk schema', () => {
   it('valid fixture passes full schema validation', () => {
     const data = loadFixture('0', 'valid', 'effect-risk.json');
     const result = validateFixture('effect-risk.schema.json', data);
     expect(result.valid).toBe(true);
   });
 
   it('invalid fixture fails schema validation', () => {
     const data = loadFixture('0', 'invalid', 'effect-risk.json');
     const result = validateFixture('effect-risk.schema.json', data);
     expect(result.valid).toBe(false);
   });
 });
