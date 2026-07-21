import SwaggerParser from '@apidevtools/swagger-parser';
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';

const apiPath = path.resolve(__dirname, '../../../spec/api/openapi.yaml');

describe('AH-SPEC-API-001: OpenAPI contract', () => {
  it('passes a real OpenAPI parser and reference validator', async () => {
    const document = await SwaggerParser.validate(apiPath);

    expect(document).toMatchObject({ openapi: '3.1.0' });
    expect(Object.keys(document.paths ?? {}).length).toBeGreaterThan(0);
  });

  it('defines the complete Phase 1 password and WebAuthn ceremony surface', async () => {
    const document = await SwaggerParser.validate(apiPath);
    const paths = document.paths ?? {};

    expect(paths['/auth/login']?.post?.operationId).toBe('login');
    expect(paths['/auth/webauthn/register']?.post?.operationId).toBe('webauthnRegister');
    expect(paths['/auth/webauthn/authenticate']?.post).toMatchObject({
      operationId: 'webauthnAuthenticate',
      security: [],
    });
    expect(paths['/auth/webauthn/verify']?.post).toMatchObject({
      operationId: 'webauthnVerify',
      security: [],
    });
    expect(paths['/auth/me']?.get?.operationId).toBe('getCurrentSession');
    expect(paths['/auth/logout']?.post?.operationId).toBe('logout');
  });

  it('keeps authenticated account operations behind global security without publishing session tokens', async () => {
    const document = await SwaggerParser.validate(apiPath);
    const paths = document.paths ?? {};

    expect(document.security).toEqual([{ bearerAuth: [] }, { apiKeyAuth: [] }]);
    expect(paths['/auth/webauthn/register']?.post?.security).toBeUndefined();
    expect(paths['/auth/me']?.get?.security).toBeUndefined();
    expect(paths['/auth/logout']?.post?.security).toBeUndefined();
    expect(JSON.stringify(paths['/auth/me']?.get?.responses?.['200'])).not.toContain('session_token');
  });

  it('defines the Phase 1 secret vault surface without exposing values from list or write responses', async () => {
    const document = await SwaggerParser.validate(apiPath);
    const paths = document.paths ?? {};
    const collection = paths['/vault/secrets'];
    const item = paths['/vault/secrets/{name}'];

    expect(collection?.get?.operationId).toBe('listSecrets');
    expect(collection?.put).toBeUndefined();
    expect(item?.put?.operationId).toBe('storeSecret');
    expect(item?.get?.operationId).toBe('getSecret');
    expect(item?.get?.security).toEqual([{ capabilityAuth: [] }]);
    const components = (document as {
      components?: { securitySchemes?: Record<string, unknown> };
    }).components;
    expect(components?.securitySchemes?.capabilityAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'Ed25519 CapabilityToken',
    });
    expect(item?.delete?.operationId).toBe('deleteSecret');
    expect(item?.put?.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'name', in: 'path', required: true })]),
    );
    expect(item?.get?.responses?.['403']).toBeDefined();
    const listResponse = collection?.get?.responses?.['200'] as
      | { content?: Record<string, { schema?: unknown }> }
      | undefined;
    const storeResponse = item?.put?.responses?.['201'] as
      | { content?: Record<string, { schema?: unknown }> }
      | undefined;
    const listSchema = listResponse?.content?.['application/json']?.schema;
    const storeSchema = storeResponse?.content?.['application/json']?.schema;
    expect(listSchema).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(JSON.stringify(listSchema)).not.toContain('value');
    expect(JSON.stringify(storeSchema)).not.toContain('value');
  });
});
