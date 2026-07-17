 import { describe, it, expect } from 'vitest';
 import { validateFixture, loadFixture } from '../helpers/schema-validator';
 
 describe('AH-CONTRACT-ACTIONMANIFEST-001: action-manifest schema', () => {
   it('valid fixture passes full schema validation', () => {
     const data = loadFixture('0', 'valid', 'action-manifest.json');
     const result = validateFixture('action-manifest.schema.json', data);
     expect(result.valid).toBe(true);
   });
 
   it('invalid fixture fails schema validation', () => {
     const data = loadFixture('0', 'invalid', 'action-manifest.json');
     const result = validateFixture('action-manifest.schema.json', data);
     expect(result.valid).toBe(false);
   });
 });
