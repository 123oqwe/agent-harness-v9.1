 import { describe, it, expect } from 'vitest';
 import { validateFixture, loadFixture } from '../helpers/schema-validator';
 
 describe('AH-CONTRACT-TOOLSPEC-001: tool-spec schema', () => {
   it('valid fixture passes full schema validation', () => {
     const data = loadFixture('0', 'valid', 'tool-spec.json');
     const result = validateFixture('tool-spec.schema.json', data);
     expect(result.valid).toBe(true);
   });
 
   it('invalid fixture fails schema validation', () => {
     const data = loadFixture('0', 'invalid', 'tool-spec.json');
     const result = validateFixture('tool-spec.schema.json', data);
     expect(result.valid).toBe(false);
   });
 });
