// @ts-nocheck
 import Ajv from 'ajv';
 import addFormats from 'ajv-formats';
 import * as fs from 'fs';
 import * as path from 'path';

 const contractsDir = path.resolve(__dirname, '../../../spec/contracts');

 // Cache compiled validators
 const validatorCache = new Map<string, Ajv>();

 function getAjv(): Ajv {
   if (validatorCache.has('default')) {
     return validatorCache.get('default')!;
   }
   const ajv = new Ajv({ allErrors: true, strict: false });
   addFormats(ajv);

   // Load all schemas into the ajv instance for $ref resolution
   const schemaFiles = fs.readdirSync(contractsDir).filter(f => f.endsWith('.schema.json'));
   for (const f of schemaFiles) {
     const schema = JSON.parse(fs.readFileSync(path.join(contractsDir, f), 'utf-8'));
     // Use filename as $id for $ref resolution
     if (!schema.$id) {
       schema.$id = f;
     }
     try {
       ajv.addSchema(schema);
     } catch {
       // Schema may already be added or have $id conflict; skip
     }
   }

   validatorCache.set('default', ajv);
   return ajv;
 }

 export function validateFixture(schemaName: string, data: unknown): { valid: boolean; errors: string[] } {
   const ajv = getAjv();
   const schemaPath = path.join(contractsDir, schemaName);
   const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));

   // Compile with ref resolution
   const validate = ajv.getSchema(schema.$id || schemaName) || ajv.compile(schema);
   const valid = validate(data);

   return {
     valid: !!valid,
     errors: validate.errors ? validate.errors.map(e => `${e.instancePath}: ${e.message}`) : [],
   };
 }

 export function loadFixture(phase: string, type: 'valid' | 'invalid', name: string): unknown {
   const fixturePath = path.resolve(__dirname, `../../../spec/fixtures/phase-${phase}/${type}/${name}`);
   return JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
 }

 export function expectValid(schemaName: string, data: unknown): void {
   const result = validateFixture(schemaName, data);
   if (!result.valid) {
     throw new Error(`Expected valid but got errors: ${result.errors.join('; ')}`);
   }
 }

 export function expectInvalid(schemaName: string, data: unknown): void {
   const result = validateFixture(schemaName, data);
   if (result.valid) {
     throw new Error('Expected validation failure but fixture passed');
   }
 }
