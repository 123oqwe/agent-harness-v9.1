// @ts-nocheck
function stryNS_9fa48() {
  var g = typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis || new Function("return this")();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov = ns.mutantCoverage || (ns.mutantCoverage = {
    static: {},
    perTest: {}
  });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import Database from 'better-sqlite3';
import { AuthorizationService, hashCapabilityGrant, type CredentialExchangeContext } from './authorization-service.js';
import { CredentialDispatchError, type SignedCapabilityToken } from './capability.js';
import { isStrictDateTime } from './policy-engine.js';
const PBKDF2_ITERATIONS = 100_000;
const MASTER_KEY_BYTES = 32;
const KDF_SALT_BYTES = 16;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const MAX_SECRET_BYTES = stryMutAct_9fa48("4633") ? 1024 / 1024 : (stryCov_9fa48("4633"), 1024 * 1024);
const MAX_PASSWORD_BYTES = 1024;
const AUDIT_RETENTION_MS = stryMutAct_9fa48("4634") ? 90 * 24 * 60 * 60 / 1000 : (stryCov_9fa48("4634"), (stryMutAct_9fa48("4635") ? 90 * 24 * 60 / 60 : (stryCov_9fa48("4635"), (stryMutAct_9fa48("4636") ? 90 * 24 / 60 : (stryCov_9fa48("4636"), (stryMutAct_9fa48("4637") ? 90 / 24 : (stryCov_9fa48("4637"), 90 * 24)) * 60)) * 60)) * 1000);
const KEY_CHECK_PLAINTEXT = Buffer.from(stryMutAct_9fa48("4638") ? "" : (stryCov_9fa48("4638"), 'agent-harness-vault-key-check-v1'));
const KEY_CHECK_AAD = Buffer.from(stryMutAct_9fa48("4639") ? "" : (stryCov_9fa48("4639"), 'agent-harness:vault:key-check:v1'));
const NAME_PATTERN = stryMutAct_9fa48("4644") ? /^[A-Za-z0-9][^A-Za-z0-9._-]{0,127}$/u : stryMutAct_9fa48("4643") ? /^[A-Za-z0-9][A-Za-z0-9._-]$/u : stryMutAct_9fa48("4642") ? /^[^A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u : stryMutAct_9fa48("4641") ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}/u : stryMutAct_9fa48("4640") ? /[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u : (stryCov_9fa48("4640", "4641", "4642", "4643", "4644"), /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const REQUESTER_PATTERN = stryMutAct_9fa48("4649") ? /^[A-Za-z0-9][^A-Za-z0-9._:@/-]{0,255}$/u : stryMutAct_9fa48("4648") ? /^[A-Za-z0-9][A-Za-z0-9._:@/-]$/u : stryMutAct_9fa48("4647") ? /^[^A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u : stryMutAct_9fa48("4646") ? /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}/u : stryMutAct_9fa48("4645") ? /[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u : (stryCov_9fa48("4645", "4646", "4647", "4648", "4649"), /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u);
const RECORD_DENIAL = Symbol('record-secret-access-denial');
interface MetadataRow {
  key: string;
  value: Buffer;
}
interface EncryptedSecretRow {
  nonce: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
}
interface ExchangeResult {
  readonly kind: 'success' | 'replay' | 'missing' | 'integrity';
  readonly value?: Buffer;
}
export interface SecretAuditEvent {
  readonly timestamp: string;
  readonly action: 'put' | 'get' | 'list' | 'delete';
  readonly secret_name: string;
  readonly requester: string;
  readonly outcome: 'grant' | 'deny';
  readonly reason_code: string;
}
export interface SecretsBrokerOptions {
  readonly database_path: string;
  readonly password: string;
  readonly tenant_id: string;
  readonly authorization_service: AuthorizationService;
  readonly now?: () => string;
  readonly random_bytes?: (length: number) => Uint8Array;
}
export interface SecretDispatchRequest<T> {
  readonly name: string;
  readonly requester: string;
  readonly capability: SignedCapabilityToken;
  readonly confirmation_key_thumbprint: string;
  readonly dispatch: (credential: Uint8Array) => Promise<T>;
}
export interface SecretsBrokerApiRequest {
  readonly method: string;
  readonly path: string;
  readonly session_token?: string;
  readonly capability?: SignedCapabilityToken;
  readonly confirmation_key_thumbprint?: string;
  readonly body?: unknown;
}
export interface SecretsBrokerApiResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}
export class SecretBrokerError extends Error {
  constructor(message = stryMutAct_9fa48("4650") ? "" : (stryCov_9fa48("4650"), 'secret broker request failed')) {
    if (stryMutAct_9fa48("4651")) {
      {}
    } else {
      stryCov_9fa48("4651");
      super(message);
      this.name = new.target.name;
    }
  }
}
export class SecretAccessDeniedError extends SecretBrokerError {
  constructor(message = stryMutAct_9fa48("4652") ? "" : (stryCov_9fa48("4652"), 'secret access denied')) {
    if (stryMutAct_9fa48("4653")) {
      {}
    } else {
      stryCov_9fa48("4653");
      super(message);
    }
  }
}
export class SecretNotFoundError extends SecretBrokerError {
  constructor() {
    if (stryMutAct_9fa48("4654")) {
      {}
    } else {
      stryCov_9fa48("4654");
      super(stryMutAct_9fa48("4655") ? "" : (stryCov_9fa48("4655"), 'secret not found'));
    }
  }
}
export class SecretIntegrityError extends SecretBrokerError {
  constructor() {
    if (stryMutAct_9fa48("4656")) {
      {}
    } else {
      stryCov_9fa48("4656");
      super(stryMutAct_9fa48("4657") ? "" : (stryCov_9fa48("4657"), 'secret integrity verification failed'));
    }
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  if (stryMutAct_9fa48("4658")) {
    {}
  } else {
    stryCov_9fa48("4658");
    return stryMutAct_9fa48("4661") ? typeof value === 'object' && value !== null || !Array.isArray(value) : stryMutAct_9fa48("4660") ? false : stryMutAct_9fa48("4659") ? true : (stryCov_9fa48("4659", "4660", "4661"), (stryMutAct_9fa48("4663") ? typeof value === 'object' || value !== null : stryMutAct_9fa48("4662") ? true : (stryCov_9fa48("4662", "4663"), (stryMutAct_9fa48("4665") ? typeof value !== 'object' : stryMutAct_9fa48("4664") ? true : (stryCov_9fa48("4664", "4665"), typeof value === (stryMutAct_9fa48("4666") ? "" : (stryCov_9fa48("4666"), 'object')))) && (stryMutAct_9fa48("4668") ? value === null : stryMutAct_9fa48("4667") ? true : (stryCov_9fa48("4667", "4668"), value !== null)))) && (stryMutAct_9fa48("4669") ? Array.isArray(value) : (stryCov_9fa48("4669"), !Array.isArray(value))));
  }
}
function validateName(name: unknown): asserts name is string {
  if (stryMutAct_9fa48("4670")) {
    {}
  } else {
    stryCov_9fa48("4670");
    if (stryMutAct_9fa48("4673") ? typeof name !== 'string' && !NAME_PATTERN.test(name) : stryMutAct_9fa48("4672") ? false : stryMutAct_9fa48("4671") ? true : (stryCov_9fa48("4671", "4672", "4673"), (stryMutAct_9fa48("4675") ? typeof name === 'string' : stryMutAct_9fa48("4674") ? false : (stryCov_9fa48("4674", "4675"), typeof name !== (stryMutAct_9fa48("4676") ? "" : (stryCov_9fa48("4676"), 'string')))) || (stryMutAct_9fa48("4677") ? NAME_PATTERN.test(name) : (stryCov_9fa48("4677"), !NAME_PATTERN.test(name))))) {
      if (stryMutAct_9fa48("4678")) {
        {}
      } else {
        stryCov_9fa48("4678");
        throw new SecretBrokerError(stryMutAct_9fa48("4679") ? "" : (stryCov_9fa48("4679"), 'invalid secret name'));
      }
    }
  }
}
function validateRequester(requester: unknown): asserts requester is string {
  if (stryMutAct_9fa48("4680")) {
    {}
  } else {
    stryCov_9fa48("4680");
    if (stryMutAct_9fa48("4683") ? typeof requester !== 'string' && !REQUESTER_PATTERN.test(requester) : stryMutAct_9fa48("4682") ? false : stryMutAct_9fa48("4681") ? true : (stryCov_9fa48("4681", "4682", "4683"), (stryMutAct_9fa48("4685") ? typeof requester === 'string' : stryMutAct_9fa48("4684") ? false : (stryCov_9fa48("4684", "4685"), typeof requester !== (stryMutAct_9fa48("4686") ? "" : (stryCov_9fa48("4686"), 'string')))) || (stryMutAct_9fa48("4687") ? REQUESTER_PATTERN.test(requester) : (stryCov_9fa48("4687"), !REQUESTER_PATTERN.test(requester))))) {
      if (stryMutAct_9fa48("4688")) {
        {}
      } else {
        stryCov_9fa48("4688");
        throw new SecretBrokerError(stryMutAct_9fa48("4689") ? "" : (stryCov_9fa48("4689"), 'invalid requester'));
      }
    }
  }
}
function requireBytes(value: unknown, label: string, expectedLength?: number): Buffer {
  if (stryMutAct_9fa48("4690")) {
    {}
  } else {
    stryCov_9fa48("4690");
    if (stryMutAct_9fa48("4693") ? false : stryMutAct_9fa48("4692") ? true : stryMutAct_9fa48("4691") ? value instanceof Uint8Array : (stryCov_9fa48("4691", "4692", "4693"), !(value instanceof Uint8Array))) throw new SecretBrokerError(stryMutAct_9fa48("4694") ? `` : (stryCov_9fa48("4694"), `invalid ${label}`));
    const copy = Buffer.from(value);
    if (stryMutAct_9fa48("4697") ? (expectedLength !== undefined && copy.byteLength !== expectedLength || copy.byteLength === 0) && copy.every(byte => byte === 0) : stryMutAct_9fa48("4696") ? false : stryMutAct_9fa48("4695") ? true : (stryCov_9fa48("4695", "4696", "4697"), (stryMutAct_9fa48("4699") ? expectedLength !== undefined && copy.byteLength !== expectedLength && copy.byteLength === 0 : stryMutAct_9fa48("4698") ? false : (stryCov_9fa48("4698", "4699"), (stryMutAct_9fa48("4701") ? expectedLength !== undefined || copy.byteLength !== expectedLength : stryMutAct_9fa48("4700") ? false : (stryCov_9fa48("4700", "4701"), (stryMutAct_9fa48("4703") ? expectedLength === undefined : stryMutAct_9fa48("4702") ? true : (stryCov_9fa48("4702", "4703"), expectedLength !== undefined)) && (stryMutAct_9fa48("4705") ? copy.byteLength === expectedLength : stryMutAct_9fa48("4704") ? true : (stryCov_9fa48("4704", "4705"), copy.byteLength !== expectedLength)))) || (stryMutAct_9fa48("4707") ? copy.byteLength !== 0 : stryMutAct_9fa48("4706") ? false : (stryCov_9fa48("4706", "4707"), copy.byteLength === 0)))) || (stryMutAct_9fa48("4708") ? copy.some(byte => byte === 0) : (stryCov_9fa48("4708"), copy.every(stryMutAct_9fa48("4709") ? () => undefined : (stryCov_9fa48("4709"), byte => stryMutAct_9fa48("4712") ? byte !== 0 : stryMutAct_9fa48("4711") ? false : stryMutAct_9fa48("4710") ? true : (stryCov_9fa48("4710", "4711", "4712"), byte === 0))))))) {
      if (stryMutAct_9fa48("4713")) {
        {}
      } else {
        stryCov_9fa48("4713");
        copy.fill(0);
        throw new SecretBrokerError(stryMutAct_9fa48("4714") ? `` : (stryCov_9fa48("4714"), `invalid ${label}`));
      }
    }
    return copy;
  }
}
function secretAad(name: string): Buffer {
  if (stryMutAct_9fa48("4715")) {
    {}
  } else {
    stryCov_9fa48("4715");
    return Buffer.from(JSON.stringify(stryMutAct_9fa48("4716") ? {} : (stryCov_9fa48("4716"), {
      name,
      version: 1
    })));
  }
}
function encrypt(key: Buffer, plaintext: Buffer, nonce: Buffer, aad: Buffer): {
  ciphertext: Buffer;
  authTag: Buffer;
} {
  if (stryMutAct_9fa48("4717")) {
    {}
  } else {
    stryCov_9fa48("4717");
    const cipher = createCipheriv(stryMutAct_9fa48("4718") ? "" : (stryCov_9fa48("4718"), 'aes-256-gcm'), key, nonce, stryMutAct_9fa48("4719") ? {} : (stryCov_9fa48("4719"), {
      authTagLength: GCM_TAG_BYTES
    }));
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat(stryMutAct_9fa48("4720") ? [] : (stryCov_9fa48("4720"), [cipher.update(plaintext), cipher.final()]));
    return stryMutAct_9fa48("4721") ? {} : (stryCov_9fa48("4721"), {
      ciphertext,
      authTag: cipher.getAuthTag()
    });
  }
}
function decrypt(key: Buffer, row: EncryptedSecretRow, aad: Buffer): Buffer {
  if (stryMutAct_9fa48("4722")) {
    {}
  } else {
    stryCov_9fa48("4722");
    if (stryMutAct_9fa48("4725") ? (!(row.nonce instanceof Buffer) || row.nonce.byteLength !== GCM_NONCE_BYTES || !(row.ciphertext instanceof Buffer) || !(row.auth_tag instanceof Buffer)) && row.auth_tag.byteLength !== GCM_TAG_BYTES : stryMutAct_9fa48("4724") ? false : stryMutAct_9fa48("4723") ? true : (stryCov_9fa48("4723", "4724", "4725"), (stryMutAct_9fa48("4727") ? (!(row.nonce instanceof Buffer) || row.nonce.byteLength !== GCM_NONCE_BYTES || !(row.ciphertext instanceof Buffer)) && !(row.auth_tag instanceof Buffer) : stryMutAct_9fa48("4726") ? false : (stryCov_9fa48("4726", "4727"), (stryMutAct_9fa48("4729") ? (!(row.nonce instanceof Buffer) || row.nonce.byteLength !== GCM_NONCE_BYTES) && !(row.ciphertext instanceof Buffer) : stryMutAct_9fa48("4728") ? false : (stryCov_9fa48("4728", "4729"), (stryMutAct_9fa48("4731") ? !(row.nonce instanceof Buffer) && row.nonce.byteLength !== GCM_NONCE_BYTES : stryMutAct_9fa48("4730") ? false : (stryCov_9fa48("4730", "4731"), (stryMutAct_9fa48("4732") ? row.nonce instanceof Buffer : (stryCov_9fa48("4732"), !(row.nonce instanceof Buffer))) || (stryMutAct_9fa48("4734") ? row.nonce.byteLength === GCM_NONCE_BYTES : stryMutAct_9fa48("4733") ? false : (stryCov_9fa48("4733", "4734"), row.nonce.byteLength !== GCM_NONCE_BYTES)))) || (stryMutAct_9fa48("4735") ? row.ciphertext instanceof Buffer : (stryCov_9fa48("4735"), !(row.ciphertext instanceof Buffer))))) || (stryMutAct_9fa48("4736") ? row.auth_tag instanceof Buffer : (stryCov_9fa48("4736"), !(row.auth_tag instanceof Buffer))))) || (stryMutAct_9fa48("4738") ? row.auth_tag.byteLength === GCM_TAG_BYTES : stryMutAct_9fa48("4737") ? false : (stryCov_9fa48("4737", "4738"), row.auth_tag.byteLength !== GCM_TAG_BYTES)))) {
      if (stryMutAct_9fa48("4739")) {
        {}
      } else {
        stryCov_9fa48("4739");
        throw new SecretIntegrityError();
      }
    }
    try {
      if (stryMutAct_9fa48("4740")) {
        {}
      } else {
        stryCov_9fa48("4740");
        const decipher = createDecipheriv(stryMutAct_9fa48("4741") ? "" : (stryCov_9fa48("4741"), 'aes-256-gcm'), key, row.nonce, stryMutAct_9fa48("4742") ? {} : (stryCov_9fa48("4742"), {
          authTagLength: GCM_TAG_BYTES
        }));
        decipher.setAAD(aad);
        decipher.setAuthTag(row.auth_tag);
        return Buffer.concat(stryMutAct_9fa48("4743") ? [] : (stryCov_9fa48("4743"), [decipher.update(row.ciphertext), decipher.final()]));
      }
    } catch {
      if (stryMutAct_9fa48("4744")) {
        {}
      } else {
        stryCov_9fa48("4744");
        throw new SecretIntegrityError();
      }
    }
  }
}
function canonicalTimestamp(value: unknown): string {
  if (stryMutAct_9fa48("4745")) {
    {}
  } else {
    stryCov_9fa48("4745");
    if (stryMutAct_9fa48("4748") ? false : stryMutAct_9fa48("4747") ? true : stryMutAct_9fa48("4746") ? isStrictDateTime(value) : (stryCov_9fa48("4746", "4747", "4748"), !isStrictDateTime(value))) throw new SecretBrokerError(stryMutAct_9fa48("4749") ? "" : (stryCov_9fa48("4749"), 'clock returned an invalid timestamp'));
    return new Date(Date.parse(value)).toISOString();
  }
}
function cloneAudit(row: SecretAuditEvent): SecretAuditEvent {
  if (stryMutAct_9fa48("4750")) {
    {}
  } else {
    stryCov_9fa48("4750");
    return Object.freeze(stryMutAct_9fa48("4751") ? {} : (stryCov_9fa48("4751"), {
      ...row
    }));
  }
}
export function secretReadOperation(name: string): string {
  if (stryMutAct_9fa48("4752")) {
    {}
  } else {
    stryCov_9fa48("4752");
    validateName(name);
    return stryMutAct_9fa48("4753") ? `` : (stryCov_9fa48("4753"), `vault.secret.read:${createHash(stryMutAct_9fa48("4754") ? "" : (stryCov_9fa48("4754"), 'sha256')).update(name).digest(stryMutAct_9fa48("4755") ? "" : (stryCov_9fa48("4755"), 'hex'))}`);
  }
}
export class SecretsBroker {
  readonly #database: Database.Database;
  readonly #databasePath: string;
  readonly #now: () => string;
  readonly #randomBytes: (length: number) => Uint8Array;
  readonly #authorizationService: AuthorizationService;
  readonly #tenantId: string;
  readonly #masterKey: Buffer;
  #closed = stryMutAct_9fa48("4756") ? true : (stryCov_9fa48("4756"), false);
  constructor(options: SecretsBrokerOptions) {
    if (stryMutAct_9fa48("4757")) {
      {}
    } else {
      stryCov_9fa48("4757");
      if (stryMutAct_9fa48("4760") ? false : stryMutAct_9fa48("4759") ? true : stryMutAct_9fa48("4758") ? isRecord(options) : (stryCov_9fa48("4758", "4759", "4760"), !isRecord(options))) throw new SecretBrokerError(stryMutAct_9fa48("4761") ? "" : (stryCov_9fa48("4761"), 'invalid secret broker options'));
      if (stryMutAct_9fa48("4764") ? typeof options.database_path !== 'string' && !isAbsolute(options.database_path) : stryMutAct_9fa48("4763") ? false : stryMutAct_9fa48("4762") ? true : (stryCov_9fa48("4762", "4763", "4764"), (stryMutAct_9fa48("4766") ? typeof options.database_path === 'string' : stryMutAct_9fa48("4765") ? false : (stryCov_9fa48("4765", "4766"), typeof options.database_path !== (stryMutAct_9fa48("4767") ? "" : (stryCov_9fa48("4767"), 'string')))) || (stryMutAct_9fa48("4768") ? isAbsolute(options.database_path) : (stryCov_9fa48("4768"), !isAbsolute(options.database_path))))) {
        if (stryMutAct_9fa48("4769")) {
          {}
        } else {
          stryCov_9fa48("4769");
          throw new SecretBrokerError(stryMutAct_9fa48("4770") ? "" : (stryCov_9fa48("4770"), 'vault database path must be absolute'));
        }
      }
      if (stryMutAct_9fa48("4773") ? (typeof options.password !== 'string' || Buffer.byteLength(options.password, 'utf8') === 0) && Buffer.byteLength(options.password, 'utf8') > MAX_PASSWORD_BYTES : stryMutAct_9fa48("4772") ? false : stryMutAct_9fa48("4771") ? true : (stryCov_9fa48("4771", "4772", "4773"), (stryMutAct_9fa48("4775") ? typeof options.password !== 'string' && Buffer.byteLength(options.password, 'utf8') === 0 : stryMutAct_9fa48("4774") ? false : (stryCov_9fa48("4774", "4775"), (stryMutAct_9fa48("4777") ? typeof options.password === 'string' : stryMutAct_9fa48("4776") ? false : (stryCov_9fa48("4776", "4777"), typeof options.password !== (stryMutAct_9fa48("4778") ? "" : (stryCov_9fa48("4778"), 'string')))) || (stryMutAct_9fa48("4780") ? Buffer.byteLength(options.password, 'utf8') !== 0 : stryMutAct_9fa48("4779") ? false : (stryCov_9fa48("4779", "4780"), Buffer.byteLength(options.password, stryMutAct_9fa48("4781") ? "" : (stryCov_9fa48("4781"), 'utf8')) === 0)))) || (stryMutAct_9fa48("4784") ? Buffer.byteLength(options.password, 'utf8') <= MAX_PASSWORD_BYTES : stryMutAct_9fa48("4783") ? Buffer.byteLength(options.password, 'utf8') >= MAX_PASSWORD_BYTES : stryMutAct_9fa48("4782") ? false : (stryCov_9fa48("4782", "4783", "4784"), Buffer.byteLength(options.password, stryMutAct_9fa48("4785") ? "" : (stryCov_9fa48("4785"), 'utf8')) > MAX_PASSWORD_BYTES)))) {
        if (stryMutAct_9fa48("4786")) {
          {}
        } else {
          stryCov_9fa48("4786");
          throw new SecretBrokerError(stryMutAct_9fa48("4787") ? "" : (stryCov_9fa48("4787"), 'invalid vault password'));
        }
      }
      if (stryMutAct_9fa48("4790") ? typeof options.tenant_id !== 'string' && !REQUESTER_PATTERN.test(options.tenant_id) : stryMutAct_9fa48("4789") ? false : stryMutAct_9fa48("4788") ? true : (stryCov_9fa48("4788", "4789", "4790"), (stryMutAct_9fa48("4792") ? typeof options.tenant_id === 'string' : stryMutAct_9fa48("4791") ? false : (stryCov_9fa48("4791", "4792"), typeof options.tenant_id !== (stryMutAct_9fa48("4793") ? "" : (stryCov_9fa48("4793"), 'string')))) || (stryMutAct_9fa48("4794") ? REQUESTER_PATTERN.test(options.tenant_id) : (stryCov_9fa48("4794"), !REQUESTER_PATTERN.test(options.tenant_id))))) {
        if (stryMutAct_9fa48("4795")) {
          {}
        } else {
          stryCov_9fa48("4795");
          throw new SecretBrokerError(stryMutAct_9fa48("4796") ? "" : (stryCov_9fa48("4796"), 'invalid vault tenant'));
        }
      }
      if (stryMutAct_9fa48("4799") ? false : stryMutAct_9fa48("4798") ? true : stryMutAct_9fa48("4797") ? options.authorization_service instanceof AuthorizationService : (stryCov_9fa48("4797", "4798", "4799"), !(options.authorization_service instanceof AuthorizationService))) {
        if (stryMutAct_9fa48("4800")) {
          {}
        } else {
          stryCov_9fa48("4800");
          throw new SecretBrokerError(stryMutAct_9fa48("4801") ? "" : (stryCov_9fa48("4801"), 'authorization service is required'));
        }
      }
      if (stryMutAct_9fa48("4804") ? options.now !== undefined || typeof options.now !== 'function' : stryMutAct_9fa48("4803") ? false : stryMutAct_9fa48("4802") ? true : (stryCov_9fa48("4802", "4803", "4804"), (stryMutAct_9fa48("4806") ? options.now === undefined : stryMutAct_9fa48("4805") ? true : (stryCov_9fa48("4805", "4806"), options.now !== undefined)) && (stryMutAct_9fa48("4808") ? typeof options.now === 'function' : stryMutAct_9fa48("4807") ? true : (stryCov_9fa48("4807", "4808"), typeof options.now !== (stryMutAct_9fa48("4809") ? "" : (stryCov_9fa48("4809"), 'function')))))) {
        if (stryMutAct_9fa48("4810")) {
          {}
        } else {
          stryCov_9fa48("4810");
          throw new SecretBrokerError(stryMutAct_9fa48("4811") ? "" : (stryCov_9fa48("4811"), 'now must be a function'));
        }
      }
      if (stryMutAct_9fa48("4814") ? options.random_bytes !== undefined || typeof options.random_bytes !== 'function' : stryMutAct_9fa48("4813") ? false : stryMutAct_9fa48("4812") ? true : (stryCov_9fa48("4812", "4813", "4814"), (stryMutAct_9fa48("4816") ? options.random_bytes === undefined : stryMutAct_9fa48("4815") ? true : (stryCov_9fa48("4815", "4816"), options.random_bytes !== undefined)) && (stryMutAct_9fa48("4818") ? typeof options.random_bytes === 'function' : stryMutAct_9fa48("4817") ? true : (stryCov_9fa48("4817", "4818"), typeof options.random_bytes !== (stryMutAct_9fa48("4819") ? "" : (stryCov_9fa48("4819"), 'function')))))) {
        if (stryMutAct_9fa48("4820")) {
          {}
        } else {
          stryCov_9fa48("4820");
          throw new SecretBrokerError(stryMutAct_9fa48("4821") ? "" : (stryCov_9fa48("4821"), 'random_bytes must be a function'));
        }
      }
      if (stryMutAct_9fa48("4824") ? existsSync(options.database_path) || lstatSync(options.database_path).isSymbolicLink() : stryMutAct_9fa48("4823") ? false : stryMutAct_9fa48("4822") ? true : (stryCov_9fa48("4822", "4823", "4824"), existsSync(options.database_path) && lstatSync(options.database_path).isSymbolicLink())) {
        if (stryMutAct_9fa48("4825")) {
          {}
        } else {
          stryCov_9fa48("4825");
          throw new SecretBrokerError(stryMutAct_9fa48("4826") ? "" : (stryCov_9fa48("4826"), 'vault database symlinks are forbidden'));
        }
      }
      this.#databasePath = options.database_path;
      this.#now = stryMutAct_9fa48("4827") ? options.now && (() => new Date().toISOString()) : (stryCov_9fa48("4827"), options.now ?? (stryMutAct_9fa48("4828") ? () => undefined : (stryCov_9fa48("4828"), () => new Date().toISOString())));
      this.#randomBytes = stryMutAct_9fa48("4829") ? options.random_bytes && randomBytes : (stryCov_9fa48("4829"), options.random_bytes ?? randomBytes);
      this.#authorizationService = options.authorization_service;
      this.#tenantId = options.tenant_id;
      canonicalTimestamp(this.#now());
      const parent = dirname(this.#databasePath);
      mkdirSync(parent, stryMutAct_9fa48("4830") ? {} : (stryCov_9fa48("4830"), {
        recursive: stryMutAct_9fa48("4831") ? false : (stryCov_9fa48("4831"), true),
        mode: 0o700
      }));
      const hadContent = stryMutAct_9fa48("4834") ? existsSync(this.#databasePath) || statSync(this.#databasePath).size > 0 : stryMutAct_9fa48("4833") ? false : stryMutAct_9fa48("4832") ? true : (stryCov_9fa48("4832", "4833", "4834"), existsSync(this.#databasePath) && (stryMutAct_9fa48("4837") ? statSync(this.#databasePath).size <= 0 : stryMutAct_9fa48("4836") ? statSync(this.#databasePath).size >= 0 : stryMutAct_9fa48("4835") ? true : (stryCov_9fa48("4835", "4836", "4837"), statSync(this.#databasePath).size > 0)));
      const database = new Database(this.#databasePath);
      let masterKey: Buffer | undefined;
      try {
        if (stryMutAct_9fa48("4838")) {
          {}
        } else {
          stryCov_9fa48("4838");
          chmodSync(this.#databasePath, 0o600);
          database.pragma(stryMutAct_9fa48("4839") ? "" : (stryCov_9fa48("4839"), 'journal_mode = DELETE'));
          database.pragma(stryMutAct_9fa48("4840") ? "" : (stryCov_9fa48("4840"), 'foreign_keys = ON'));
          database.pragma(stryMutAct_9fa48("4841") ? "" : (stryCov_9fa48("4841"), 'secure_delete = ON'));
          database.pragma(stryMutAct_9fa48("4842") ? "" : (stryCov_9fa48("4842"), 'trusted_schema = OFF'));
          database.exec(stryMutAct_9fa48("4843") ? `` : (stryCov_9fa48("4843"), `
        CREATE TABLE IF NOT EXISTS vault_metadata (
          key TEXT PRIMARY KEY,
          value BLOB NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS vault_secrets (
          name TEXT PRIMARY KEY,
          nonce BLOB NOT NULL CHECK(length(nonce) = 12),
          ciphertext BLOB NOT NULL,
          auth_tag BLOB NOT NULL CHECK(length(auth_tag) = 16),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS vault_nonces (
          nonce BLOB PRIMARY KEY CHECK(length(nonce) = 12)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS vault_exchanges (
          token_id TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL,
          attempt_id TEXT NOT NULL,
          secret_name TEXT NOT NULL,
          exchanged_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS vault_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          action TEXT NOT NULL CHECK(action IN ('put', 'get', 'list', 'delete')),
          secret_name TEXT NOT NULL,
          requester TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK(outcome IN ('grant', 'deny')),
          reason_code TEXT NOT NULL
        ) STRICT;
      `));
          const metadataRows = database.prepare('SELECT key, value FROM vault_metadata').all() as MetadataRow[];
          if (stryMutAct_9fa48("4846") ? metadataRows.length !== 0 : stryMutAct_9fa48("4845") ? false : stryMutAct_9fa48("4844") ? true : (stryCov_9fa48("4844", "4845", "4846"), metadataRows.length === 0)) {
            if (stryMutAct_9fa48("4847")) {
              {}
            } else {
              stryCov_9fa48("4847");
              if (stryMutAct_9fa48("4849") ? false : stryMutAct_9fa48("4848") ? true : (stryCov_9fa48("4848", "4849"), hadContent)) throw new SecretAccessDeniedError(stryMutAct_9fa48("4850") ? "" : (stryCov_9fa48("4850"), 'vault unlock failed'));
              masterKey = this.#initializeVault(database, options.password, options.tenant_id);
            }
          } else {
            if (stryMutAct_9fa48("4851")) {
              {}
            } else {
              stryCov_9fa48("4851");
              masterKey = this.#unlockVault(database, metadataRows, options.password, options.tenant_id);
            }
          }
        }
      } catch (error) {
        if (stryMutAct_9fa48("4852")) {
          {}
        } else {
          stryCov_9fa48("4852");
          stryMutAct_9fa48("4853") ? masterKey.fill(0) : (stryCov_9fa48("4853"), masterKey?.fill(0));
          database.close();
          if (stryMutAct_9fa48("4855") ? false : stryMutAct_9fa48("4854") ? true : (stryCov_9fa48("4854", "4855"), error instanceof SecretBrokerError)) throw error;
          throw new SecretBrokerError(stryMutAct_9fa48("4856") ? "" : (stryCov_9fa48("4856"), 'vault initialization failed'));
        }
      }
      this.#database = database;
      this.#masterKey = masterKey;
    }
  }
  get auditEvents(): readonly SecretAuditEvent[] {
    if (stryMutAct_9fa48("4857")) {
      {}
    } else {
      stryCov_9fa48("4857");
      this.#assertOpen();
      const rows = this.#database.prepare('SELECT timestamp, action, secret_name, requester, outcome, reason_code FROM vault_audit ORDER BY id').all() as SecretAuditEvent[];
      return Object.freeze(rows.map(cloneAudit));
    }
  }
  putSecret(name: string, value: Uint8Array, requester: string): void {
    if (stryMutAct_9fa48("4858")) {
      {}
    } else {
      stryCov_9fa48("4858");
      this.#assertOpen();
      validateName(name);
      validateRequester(requester);
      if (stryMutAct_9fa48("4861") ? (!(value instanceof Uint8Array) || value.byteLength === 0) && value.byteLength > MAX_SECRET_BYTES : stryMutAct_9fa48("4860") ? false : stryMutAct_9fa48("4859") ? true : (stryCov_9fa48("4859", "4860", "4861"), (stryMutAct_9fa48("4863") ? !(value instanceof Uint8Array) && value.byteLength === 0 : stryMutAct_9fa48("4862") ? false : (stryCov_9fa48("4862", "4863"), (stryMutAct_9fa48("4864") ? value instanceof Uint8Array : (stryCov_9fa48("4864"), !(value instanceof Uint8Array))) || (stryMutAct_9fa48("4866") ? value.byteLength !== 0 : stryMutAct_9fa48("4865") ? false : (stryCov_9fa48("4865", "4866"), value.byteLength === 0)))) || (stryMutAct_9fa48("4869") ? value.byteLength <= MAX_SECRET_BYTES : stryMutAct_9fa48("4868") ? value.byteLength >= MAX_SECRET_BYTES : stryMutAct_9fa48("4867") ? false : (stryCov_9fa48("4867", "4868", "4869"), value.byteLength > MAX_SECRET_BYTES)))) {
        if (stryMutAct_9fa48("4870")) {
          {}
        } else {
          stryCov_9fa48("4870");
          this.#writeAudit(stryMutAct_9fa48("4871") ? "" : (stryCov_9fa48("4871"), 'put'), name, requester, stryMutAct_9fa48("4872") ? "" : (stryCov_9fa48("4872"), 'deny'), stryMutAct_9fa48("4873") ? "" : (stryCov_9fa48("4873"), 'invalid_secret_value'));
          throw new SecretBrokerError(stryMutAct_9fa48("4874") ? "" : (stryCov_9fa48("4874"), 'invalid secret value'));
        }
      }
      const plaintext = Buffer.from(value);
      let nonce: Buffer | undefined;
      let encrypted: {
        ciphertext: Buffer;
        authTag: Buffer;
      } | undefined;
      try {
        if (stryMutAct_9fa48("4875")) {
          {}
        } else {
          stryCov_9fa48("4875");
          nonce = this.#uniqueNonce();
          encrypted = encrypt(this.#masterKey, plaintext, nonce, secretAad(name));
          const encryptedPayload = encrypted;
          const now = canonicalTimestamp(this.#now());
          const write = this.#database.transaction(() => {
            if (stryMutAct_9fa48("4876")) {
              {}
            } else {
              stryCov_9fa48("4876");
              this.#database.prepare(stryMutAct_9fa48("4877") ? "" : (stryCov_9fa48("4877"), 'INSERT INTO vault_nonces(nonce) VALUES (?)')).run(nonce);
              this.#database.prepare(stryMutAct_9fa48("4878") ? `` : (stryCov_9fa48("4878"), `INSERT INTO vault_secrets(name, nonce, ciphertext, auth_tag, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(name) DO UPDATE SET
               nonce = excluded.nonce,
               ciphertext = excluded.ciphertext,
               auth_tag = excluded.auth_tag,
               updated_at = excluded.updated_at`)).run(name, nonce, encryptedPayload.ciphertext, encryptedPayload.authTag, now, now);
              this.#insertAudit(now, stryMutAct_9fa48("4879") ? "" : (stryCov_9fa48("4879"), 'put'), name, requester, stryMutAct_9fa48("4880") ? "" : (stryCov_9fa48("4880"), 'grant'), stryMutAct_9fa48("4881") ? "" : (stryCov_9fa48("4881"), 'stored'));
            }
          });
          write.immediate();
        }
      } catch (error) {
        if (stryMutAct_9fa48("4882")) {
          {}
        } else {
          stryCov_9fa48("4882");
          if (stryMutAct_9fa48("4884") ? false : stryMutAct_9fa48("4883") ? true : (stryCov_9fa48("4883", "4884"), error instanceof SecretBrokerError)) throw error;
          throw new SecretBrokerError(stryMutAct_9fa48("4885") ? "" : (stryCov_9fa48("4885"), 'secret storage failed'));
        }
      } finally {
        if (stryMutAct_9fa48("4886")) {
          {}
        } else {
          stryCov_9fa48("4886");
          plaintext.fill(0);
          stryMutAct_9fa48("4887") ? nonce.fill(0) : (stryCov_9fa48("4887"), nonce?.fill(0));
          stryMutAct_9fa48("4888") ? encrypted.ciphertext.fill(0) : (stryCov_9fa48("4888"), encrypted?.ciphertext.fill(0));
          stryMutAct_9fa48("4889") ? encrypted.authTag.fill(0) : (stryCov_9fa48("4889"), encrypted?.authTag.fill(0));
        }
      }
    }
  }
  listSecrets(requester: string): readonly string[] {
    if (stryMutAct_9fa48("4890")) {
      {}
    } else {
      stryCov_9fa48("4890");
      this.#assertOpen();
      validateRequester(requester);
      try {
        if (stryMutAct_9fa48("4891")) {
          {}
        } else {
          stryCov_9fa48("4891");
          const list = this.#database.transaction(() => {
            if (stryMutAct_9fa48("4892")) {
              {}
            } else {
              stryCov_9fa48("4892");
              const names = this.#database.prepare(stryMutAct_9fa48("4893") ? "" : (stryCov_9fa48("4893"), 'SELECT name FROM vault_secrets ORDER BY name')).all().map(stryMutAct_9fa48("4894") ? () => undefined : (stryCov_9fa48("4894"), row => (row as {
                name: string;
              }).name));
              this.#insertAudit(canonicalTimestamp(this.#now()), stryMutAct_9fa48("4895") ? "" : (stryCov_9fa48("4895"), 'list'), stryMutAct_9fa48("4896") ? "" : (stryCov_9fa48("4896"), '*'), requester, stryMutAct_9fa48("4897") ? "" : (stryCov_9fa48("4897"), 'grant'), stryMutAct_9fa48("4898") ? "" : (stryCov_9fa48("4898"), 'listed'));
              return names;
            }
          });
          return Object.freeze(list.immediate());
        }
      } catch {
        if (stryMutAct_9fa48("4899")) {
          {}
        } else {
          stryCov_9fa48("4899");
          throw new SecretBrokerError(stryMutAct_9fa48("4900") ? "" : (stryCov_9fa48("4900"), 'secret listing failed'));
        }
      }
    }
  }
  deleteSecret(name: string, requester: string): boolean {
    if (stryMutAct_9fa48("4901")) {
      {}
    } else {
      stryCov_9fa48("4901");
      this.#assertOpen();
      validateName(name);
      validateRequester(requester);
      try {
        if (stryMutAct_9fa48("4902")) {
          {}
        } else {
          stryCov_9fa48("4902");
          const remove = this.#database.transaction(() => {
            if (stryMutAct_9fa48("4903")) {
              {}
            } else {
              stryCov_9fa48("4903");
              const changed = stryMutAct_9fa48("4906") ? this.#database.prepare('DELETE FROM vault_secrets WHERE name = ?').run(name).changes !== 1 : stryMutAct_9fa48("4905") ? false : stryMutAct_9fa48("4904") ? true : (stryCov_9fa48("4904", "4905", "4906"), this.#database.prepare(stryMutAct_9fa48("4907") ? "" : (stryCov_9fa48("4907"), 'DELETE FROM vault_secrets WHERE name = ?')).run(name).changes === 1);
              this.#insertAudit(canonicalTimestamp(this.#now()), stryMutAct_9fa48("4908") ? "" : (stryCov_9fa48("4908"), 'delete'), name, requester, changed ? stryMutAct_9fa48("4909") ? "" : (stryCov_9fa48("4909"), 'grant') : stryMutAct_9fa48("4910") ? "" : (stryCov_9fa48("4910"), 'deny'), changed ? stryMutAct_9fa48("4911") ? "" : (stryCov_9fa48("4911"), 'deleted') : stryMutAct_9fa48("4912") ? "" : (stryCov_9fa48("4912"), 'not_found'));
              return changed;
            }
          });
          return remove.immediate();
        }
      } catch {
        if (stryMutAct_9fa48("4913")) {
          {}
        } else {
          stryCov_9fa48("4913");
          throw new SecretBrokerError(stryMutAct_9fa48("4914") ? "" : (stryCov_9fa48("4914"), 'secret deletion failed'));
        }
      }
    }
  }
  async dispatchWithSecret<T>(request: SecretDispatchRequest<T>): Promise<T> {
    if (stryMutAct_9fa48("4915")) {
      {}
    } else {
      stryCov_9fa48("4915");
      this.#assertOpen();
      if (stryMutAct_9fa48("4918") ? false : stryMutAct_9fa48("4917") ? true : stryMutAct_9fa48("4916") ? isRecord(request) : (stryCov_9fa48("4916", "4917", "4918"), !isRecord(request))) throw new SecretAccessDeniedError();
      validateName(request.name);
      validateRequester(request.requester);
      if (stryMutAct_9fa48("4921") ? typeof request.dispatch === 'function' : stryMutAct_9fa48("4920") ? false : stryMutAct_9fa48("4919") ? true : (stryCov_9fa48("4919", "4920", "4921"), typeof request.dispatch !== (stryMutAct_9fa48("4922") ? "" : (stryCov_9fa48("4922"), 'function')))) throw new SecretAccessDeniedError();
      const claims = (stryMutAct_9fa48("4925") ? isRecord(request.capability) || isRecord(request.capability.claims) : stryMutAct_9fa48("4924") ? false : stryMutAct_9fa48("4923") ? true : (stryCov_9fa48("4923", "4924", "4925"), isRecord(request.capability) && isRecord(request.capability.claims))) ? request.capability.claims : undefined;
      const expectedResourceHash = hashCapabilityGrant(stryMutAct_9fa48("4926") ? [] : (stryCov_9fa48("4926"), [stryMutAct_9fa48("4927") ? `` : (stryCov_9fa48("4927"), `vault-secret:${request.name}`)]));
      if (stryMutAct_9fa48("4930") ? (claims === undefined || claims.operation_id !== secretReadOperation(request.name) || claims.resource_grant_hash !== expectedResourceHash || claims.tool_grant_hash !== hashCapabilityGrant(['secrets.exchange']) || claims.tenant_id !== this.#tenantId || claims.audience !== 'harness-secrets-broker' || claims.subject_workload !== request.requester || typeof request.confirmation_key_thumbprint !== 'string') && request.confirmation_key_thumbprint.length === 0 : stryMutAct_9fa48("4929") ? false : stryMutAct_9fa48("4928") ? true : (stryCov_9fa48("4928", "4929", "4930"), (stryMutAct_9fa48("4932") ? (claims === undefined || claims.operation_id !== secretReadOperation(request.name) || claims.resource_grant_hash !== expectedResourceHash || claims.tool_grant_hash !== hashCapabilityGrant(['secrets.exchange']) || claims.tenant_id !== this.#tenantId || claims.audience !== 'harness-secrets-broker' || claims.subject_workload !== request.requester) && typeof request.confirmation_key_thumbprint !== 'string' : stryMutAct_9fa48("4931") ? false : (stryCov_9fa48("4931", "4932"), (stryMutAct_9fa48("4934") ? (claims === undefined || claims.operation_id !== secretReadOperation(request.name) || claims.resource_grant_hash !== expectedResourceHash || claims.tool_grant_hash !== hashCapabilityGrant(['secrets.exchange']) || claims.tenant_id !== this.#tenantId || claims.audience !== 'harness-secrets-broker') && claims.subject_workload !== request.requester : stryMutAct_9fa48("4933") ? false : (stryCov_9fa48("4933", "4934"), (stryMutAct_9fa48("4936") ? (claims === undefined || claims.operation_id !== secretReadOperation(request.name) || claims.resource_grant_hash !== expectedResourceHash || claims.tool_grant_hash !== hashCapabilityGrant(['secrets.exchange']) || claims.tenant_id !== this.#tenantId) && claims.audience !== 'harness-secrets-broker' : stryMutAct_9fa48("4935") ? false : (stryCov_9fa48("4935", "4936"), (stryMutAct_9fa48("4938") ? (claims === undefined || claims.operation_id !== secretReadOperation(request.name) || claims.resource_grant_hash !== expectedResourceHash || claims.tool_grant_hash !== hashCapabilityGrant(['secrets.exchange'])) && claims.tenant_id !== this.#tenantId : stryMutAct_9fa48("4937") ? false : (stryCov_9fa48("4937", "4938"), (stryMutAct_9fa48("4940") ? (claims === undefined || claims.operation_id !== secretReadOperation(request.name) || claims.resource_grant_hash !== expectedResourceHash) && claims.tool_grant_hash !== hashCapabilityGrant(['secrets.exchange']) : stryMutAct_9fa48("4939") ? false : (stryCov_9fa48("4939", "4940"), (stryMutAct_9fa48("4942") ? (claims === undefined || claims.operation_id !== secretReadOperation(request.name)) && claims.resource_grant_hash !== expectedResourceHash : stryMutAct_9fa48("4941") ? false : (stryCov_9fa48("4941", "4942"), (stryMutAct_9fa48("4944") ? claims === undefined && claims.operation_id !== secretReadOperation(request.name) : stryMutAct_9fa48("4943") ? false : (stryCov_9fa48("4943", "4944"), (stryMutAct_9fa48("4946") ? claims !== undefined : stryMutAct_9fa48("4945") ? false : (stryCov_9fa48("4945", "4946"), claims === undefined)) || (stryMutAct_9fa48("4948") ? claims.operation_id === secretReadOperation(request.name) : stryMutAct_9fa48("4947") ? false : (stryCov_9fa48("4947", "4948"), claims.operation_id !== secretReadOperation(request.name))))) || (stryMutAct_9fa48("4950") ? claims.resource_grant_hash === expectedResourceHash : stryMutAct_9fa48("4949") ? false : (stryCov_9fa48("4949", "4950"), claims.resource_grant_hash !== expectedResourceHash)))) || (stryMutAct_9fa48("4952") ? claims.tool_grant_hash === hashCapabilityGrant(['secrets.exchange']) : stryMutAct_9fa48("4951") ? false : (stryCov_9fa48("4951", "4952"), claims.tool_grant_hash !== hashCapabilityGrant(stryMutAct_9fa48("4953") ? [] : (stryCov_9fa48("4953"), [stryMutAct_9fa48("4954") ? "" : (stryCov_9fa48("4954"), 'secrets.exchange')])))))) || (stryMutAct_9fa48("4956") ? claims.tenant_id === this.#tenantId : stryMutAct_9fa48("4955") ? false : (stryCov_9fa48("4955", "4956"), claims.tenant_id !== this.#tenantId)))) || (stryMutAct_9fa48("4958") ? claims.audience === 'harness-secrets-broker' : stryMutAct_9fa48("4957") ? false : (stryCov_9fa48("4957", "4958"), claims.audience !== (stryMutAct_9fa48("4959") ? "" : (stryCov_9fa48("4959"), 'harness-secrets-broker')))))) || (stryMutAct_9fa48("4961") ? claims.subject_workload === request.requester : stryMutAct_9fa48("4960") ? false : (stryCov_9fa48("4960", "4961"), claims.subject_workload !== request.requester)))) || (stryMutAct_9fa48("4963") ? typeof request.confirmation_key_thumbprint === 'string' : stryMutAct_9fa48("4962") ? false : (stryCov_9fa48("4962", "4963"), typeof request.confirmation_key_thumbprint !== (stryMutAct_9fa48("4964") ? "" : (stryCov_9fa48("4964"), 'string')))))) || (stryMutAct_9fa48("4966") ? request.confirmation_key_thumbprint.length !== 0 : stryMutAct_9fa48("4965") ? false : (stryCov_9fa48("4965", "4966"), request.confirmation_key_thumbprint.length === 0)))) {
        if (stryMutAct_9fa48("4967")) {
          {}
        } else {
          stryCov_9fa48("4967");
          this.#writeAudit(stryMutAct_9fa48("4968") ? "" : (stryCov_9fa48("4968"), 'get'), request.name, request.requester, stryMutAct_9fa48("4969") ? "" : (stryCov_9fa48("4969"), 'deny'), stryMutAct_9fa48("4970") ? "" : (stryCov_9fa48("4970"), 'capability_scope_mismatch'));
          throw new SecretAccessDeniedError();
        }
      }
      let dispatchStarted = stryMutAct_9fa48("4971") ? true : (stryCov_9fa48("4971"), false);
      try {
        if (stryMutAct_9fa48("4972")) {
          {}
        } else {
          stryCov_9fa48("4972");
          return await this.#authorizationService.dispatchWithExchangedCredential(stryMutAct_9fa48("4973") ? {} : (stryCov_9fa48("4973"), {
            capability: request.capability,
            confirmation_key_thumbprint: request.confirmation_key_thumbprint,
            exchange: async context => {
              if (stryMutAct_9fa48("4974")) {
                {}
              } else {
                stryCov_9fa48("4974");
                const exchanged = this.#exchange(request.name, request.requester, context);
                if (stryMutAct_9fa48("4977") ? exchanged.kind !== 'replay' : stryMutAct_9fa48("4976") ? false : stryMutAct_9fa48("4975") ? true : (stryCov_9fa48("4975", "4976", "4977"), exchanged.kind === (stryMutAct_9fa48("4978") ? "" : (stryCov_9fa48("4978"), 'replay')))) throw new SecretAccessDeniedError();
                if (stryMutAct_9fa48("4981") ? exchanged.kind !== 'missing' : stryMutAct_9fa48("4980") ? false : stryMutAct_9fa48("4979") ? true : (stryCov_9fa48("4979", "4980", "4981"), exchanged.kind === (stryMutAct_9fa48("4982") ? "" : (stryCov_9fa48("4982"), 'missing')))) throw new SecretNotFoundError();
                if (stryMutAct_9fa48("4985") ? exchanged.kind !== 'integrity' : stryMutAct_9fa48("4984") ? false : stryMutAct_9fa48("4983") ? true : (stryCov_9fa48("4983", "4984", "4985"), exchanged.kind === (stryMutAct_9fa48("4986") ? "" : (stryCov_9fa48("4986"), 'integrity')))) throw new SecretIntegrityError();
                const value = exchanged.value!;
                return stryMutAct_9fa48("4987") ? {} : (stryCov_9fa48("4987"), {
                  value,
                  dispose: () => {
                    if (stryMutAct_9fa48("4988")) {
                      {}
                    } else {
                      stryCov_9fa48("4988");
                      value.fill(0);
                    }
                  }
                });
              }
            },
            dispatch: async credential => {
              if (stryMutAct_9fa48("4989")) {
                {}
              } else {
                stryCov_9fa48("4989");
                dispatchStarted = stryMutAct_9fa48("4990") ? false : (stryCov_9fa48("4990"), true);
                return request.dispatch(credential);
              }
            }
          }));
        }
      } catch (error) {
        if (stryMutAct_9fa48("4991")) {
          {}
        } else {
          stryCov_9fa48("4991");
          if (stryMutAct_9fa48("4993") ? false : stryMutAct_9fa48("4992") ? true : (stryCov_9fa48("4992", "4993"), dispatchStarted)) throw error;
          if (stryMutAct_9fa48("4996") ? error instanceof SecretNotFoundError && error instanceof SecretIntegrityError : stryMutAct_9fa48("4995") ? false : stryMutAct_9fa48("4994") ? true : (stryCov_9fa48("4994", "4995", "4996"), error instanceof SecretNotFoundError || error instanceof SecretIntegrityError)) throw error;
          if (stryMutAct_9fa48("4999") ? false : stryMutAct_9fa48("4998") ? true : stryMutAct_9fa48("4997") ? error instanceof SecretAccessDeniedError : (stryCov_9fa48("4997", "4998", "4999"), !(error instanceof SecretAccessDeniedError))) {
            if (stryMutAct_9fa48("5000")) {
              {}
            } else {
              stryCov_9fa48("5000");
              this.#writeAudit(stryMutAct_9fa48("5001") ? "" : (stryCov_9fa48("5001"), 'get'), request.name, request.requester, stryMutAct_9fa48("5002") ? "" : (stryCov_9fa48("5002"), 'deny'), stryMutAct_9fa48("5003") ? "" : (stryCov_9fa48("5003"), 'capability_rejected'));
            }
          }
          throw new SecretAccessDeniedError();
        }
      }
    }
  }
  purgeExpiredAudit(): number {
    if (stryMutAct_9fa48("5004")) {
      {}
    } else {
      stryCov_9fa48("5004");
      this.#assertOpen();
      const cutoff = new Date(stryMutAct_9fa48("5005") ? Date.parse(canonicalTimestamp(this.#now())) + AUDIT_RETENTION_MS : (stryCov_9fa48("5005"), Date.parse(canonicalTimestamp(this.#now())) - AUDIT_RETENTION_MS)).toISOString();
      try {
        if (stryMutAct_9fa48("5006")) {
          {}
        } else {
          stryCov_9fa48("5006");
          return this.#database.prepare(stryMutAct_9fa48("5007") ? "" : (stryCov_9fa48("5007"), 'DELETE FROM vault_audit WHERE timestamp <= ?')).run(cutoff).changes;
        }
      } catch {
        if (stryMutAct_9fa48("5008")) {
          {}
        } else {
          stryCov_9fa48("5008");
          throw new SecretBrokerError(stryMutAct_9fa48("5009") ? "" : (stryCov_9fa48("5009"), 'audit retention failed'));
        }
      }
    }
  }
  close(): void {
    if (stryMutAct_9fa48("5010")) {
      {}
    } else {
      stryCov_9fa48("5010");
      if (stryMutAct_9fa48("5012") ? false : stryMutAct_9fa48("5011") ? true : (stryCov_9fa48("5011", "5012"), this.#closed)) return;
      this.#masterKey.fill(0);
      this.#database.close();
      this.#closed = stryMutAct_9fa48("5013") ? false : (stryCov_9fa48("5013"), true);
    }
  }
  [RECORD_DENIAL](action: SecretAuditEvent['action'], name: string, requester: string, reasonCode: string): void {
    if (stryMutAct_9fa48("5014")) {
      {}
    } else {
      stryCov_9fa48("5014");
      this.#assertOpen();
      const safeName = (stryMutAct_9fa48("5017") ? name === '*' && NAME_PATTERN.test(name) : stryMutAct_9fa48("5016") ? false : stryMutAct_9fa48("5015") ? true : (stryCov_9fa48("5015", "5016", "5017"), (stryMutAct_9fa48("5019") ? name !== '*' : stryMutAct_9fa48("5018") ? false : (stryCov_9fa48("5018", "5019"), name === (stryMutAct_9fa48("5020") ? "" : (stryCov_9fa48("5020"), '*')))) || NAME_PATTERN.test(name))) ? name : stryMutAct_9fa48("5021") ? "" : (stryCov_9fa48("5021"), '<invalid>');
      const safeRequester = REQUESTER_PATTERN.test(requester) ? requester : stryMutAct_9fa48("5022") ? "" : (stryCov_9fa48("5022"), 'anonymous');
      this.#writeAudit(action, safeName, safeRequester, stryMutAct_9fa48("5023") ? "" : (stryCov_9fa48("5023"), 'deny'), reasonCode);
    }
  }
  #initializeVault(database: Database.Database, password: string, tenantId: string): Buffer {
    if (stryMutAct_9fa48("5024")) {
      {}
    } else {
      stryCov_9fa48("5024");
      const salt = requireBytes(this.#randomBytes(KDF_SALT_BYTES), stryMutAct_9fa48("5025") ? "" : (stryCov_9fa48("5025"), 'vault entropy'), KDF_SALT_BYTES);
      const passwordBytes = Buffer.from(password);
      let key: Buffer | undefined;
      let nonce: Buffer | undefined;
      let encrypted: {
        ciphertext: Buffer;
        authTag: Buffer;
      } | undefined;
      let initialized = stryMutAct_9fa48("5026") ? true : (stryCov_9fa48("5026"), false);
      try {
        if (stryMutAct_9fa48("5027")) {
          {}
        } else {
          stryCov_9fa48("5027");
          key = pbkdf2Sync(passwordBytes, salt, PBKDF2_ITERATIONS, MASTER_KEY_BYTES, stryMutAct_9fa48("5028") ? "" : (stryCov_9fa48("5028"), 'sha256'));
          nonce = requireBytes(this.#randomBytes(GCM_NONCE_BYTES), stryMutAct_9fa48("5029") ? "" : (stryCov_9fa48("5029"), 'vault entropy'), GCM_NONCE_BYTES);
          encrypted = encrypt(key, KEY_CHECK_PLAINTEXT, nonce, KEY_CHECK_AAD);
          const values: Array<[string, Buffer]> = stryMutAct_9fa48("5030") ? [] : (stryCov_9fa48("5030"), [stryMutAct_9fa48("5031") ? [] : (stryCov_9fa48("5031"), [stryMutAct_9fa48("5032") ? "" : (stryCov_9fa48("5032"), 'schema_version'), Buffer.from(stryMutAct_9fa48("5033") ? "" : (stryCov_9fa48("5033"), '1'))]), stryMutAct_9fa48("5034") ? [] : (stryCov_9fa48("5034"), [stryMutAct_9fa48("5035") ? "" : (stryCov_9fa48("5035"), 'cipher_algorithm'), Buffer.from(stryMutAct_9fa48("5036") ? "" : (stryCov_9fa48("5036"), 'AES-256-GCM'))]), stryMutAct_9fa48("5037") ? [] : (stryCov_9fa48("5037"), [stryMutAct_9fa48("5038") ? "" : (stryCov_9fa48("5038"), 'kdf_algorithm'), Buffer.from(stryMutAct_9fa48("5039") ? "" : (stryCov_9fa48("5039"), 'PBKDF2-SHA256'))]), stryMutAct_9fa48("5040") ? [] : (stryCov_9fa48("5040"), [stryMutAct_9fa48("5041") ? "" : (stryCov_9fa48("5041"), 'kdf_iterations'), Buffer.from(String(PBKDF2_ITERATIONS))]), stryMutAct_9fa48("5042") ? [] : (stryCov_9fa48("5042"), [stryMutAct_9fa48("5043") ? "" : (stryCov_9fa48("5043"), 'kdf_salt'), salt]), stryMutAct_9fa48("5044") ? [] : (stryCov_9fa48("5044"), [stryMutAct_9fa48("5045") ? "" : (stryCov_9fa48("5045"), 'tenant_id_hash'), Buffer.from(createHash(stryMutAct_9fa48("5046") ? "" : (stryCov_9fa48("5046"), 'sha256')).update(tenantId).digest(stryMutAct_9fa48("5047") ? "" : (stryCov_9fa48("5047"), 'hex')))]), stryMutAct_9fa48("5048") ? [] : (stryCov_9fa48("5048"), [stryMutAct_9fa48("5049") ? "" : (stryCov_9fa48("5049"), 'key_check_nonce'), nonce]), stryMutAct_9fa48("5050") ? [] : (stryCov_9fa48("5050"), [stryMutAct_9fa48("5051") ? "" : (stryCov_9fa48("5051"), 'key_check_ciphertext'), encrypted.ciphertext]), stryMutAct_9fa48("5052") ? [] : (stryCov_9fa48("5052"), [stryMutAct_9fa48("5053") ? "" : (stryCov_9fa48("5053"), 'key_check_auth_tag'), encrypted.authTag])]);
          const initialize = database.transaction(() => {
            if (stryMutAct_9fa48("5054")) {
              {}
            } else {
              stryCov_9fa48("5054");
              const insert = database.prepare(stryMutAct_9fa48("5055") ? "" : (stryCov_9fa48("5055"), 'INSERT INTO vault_metadata(key, value) VALUES (?, ?)'));
              for (const [metadataKey, value] of values) insert.run(metadataKey, value);
              database.prepare(stryMutAct_9fa48("5056") ? "" : (stryCov_9fa48("5056"), 'INSERT INTO vault_nonces(nonce) VALUES (?)')).run(nonce);
            }
          });
          initialize.immediate();
          initialized = stryMutAct_9fa48("5057") ? false : (stryCov_9fa48("5057"), true);
          return key;
        }
      } finally {
        if (stryMutAct_9fa48("5058")) {
          {}
        } else {
          stryCov_9fa48("5058");
          if (stryMutAct_9fa48("5061") ? false : stryMutAct_9fa48("5060") ? true : stryMutAct_9fa48("5059") ? initialized : (stryCov_9fa48("5059", "5060", "5061"), !initialized)) stryMutAct_9fa48("5062") ? key.fill(0) : (stryCov_9fa48("5062"), key?.fill(0));
          passwordBytes.fill(0);
          salt.fill(0);
          stryMutAct_9fa48("5063") ? nonce.fill(0) : (stryCov_9fa48("5063"), nonce?.fill(0));
          stryMutAct_9fa48("5064") ? encrypted.ciphertext.fill(0) : (stryCov_9fa48("5064"), encrypted?.ciphertext.fill(0));
          stryMutAct_9fa48("5065") ? encrypted.authTag.fill(0) : (stryCov_9fa48("5065"), encrypted?.authTag.fill(0));
        }
      }
    }
  }
  #unlockVault(database: Database.Database, rows: MetadataRow[], password: string, tenantId: string): Buffer {
    if (stryMutAct_9fa48("5066")) {
      {}
    } else {
      stryCov_9fa48("5066");
      const metadata = new Map(rows.map(stryMutAct_9fa48("5067") ? () => undefined : (stryCov_9fa48("5067"), row => stryMutAct_9fa48("5068") ? [] : (stryCov_9fa48("5068"), [row.key, Buffer.from(row.value)]))));
      const required = stryMutAct_9fa48("5069") ? [] : (stryCov_9fa48("5069"), [stryMutAct_9fa48("5070") ? "" : (stryCov_9fa48("5070"), 'schema_version'), stryMutAct_9fa48("5071") ? "" : (stryCov_9fa48("5071"), 'cipher_algorithm'), stryMutAct_9fa48("5072") ? "" : (stryCov_9fa48("5072"), 'kdf_algorithm'), stryMutAct_9fa48("5073") ? "" : (stryCov_9fa48("5073"), 'kdf_iterations'), stryMutAct_9fa48("5074") ? "" : (stryCov_9fa48("5074"), 'kdf_salt'), stryMutAct_9fa48("5075") ? "" : (stryCov_9fa48("5075"), 'tenant_id_hash'), stryMutAct_9fa48("5076") ? "" : (stryCov_9fa48("5076"), 'key_check_nonce'), stryMutAct_9fa48("5077") ? "" : (stryCov_9fa48("5077"), 'key_check_ciphertext'), stryMutAct_9fa48("5078") ? "" : (stryCov_9fa48("5078"), 'key_check_auth_tag')]);
      if (stryMutAct_9fa48("5081") ? (metadata.size !== required.length || required.some(key => !metadata.has(key)) || metadata.get('schema_version')!.toString() !== '1' || metadata.get('cipher_algorithm')!.toString() !== 'AES-256-GCM' || metadata.get('kdf_algorithm')!.toString() !== 'PBKDF2-SHA256' || metadata.get('kdf_iterations')!.toString() !== String(PBKDF2_ITERATIONS) || metadata.get('kdf_salt')!.byteLength !== KDF_SALT_BYTES) && metadata.get('tenant_id_hash')!.toString() !== createHash('sha256').update(tenantId).digest('hex') : stryMutAct_9fa48("5080") ? false : stryMutAct_9fa48("5079") ? true : (stryCov_9fa48("5079", "5080", "5081"), (stryMutAct_9fa48("5083") ? (metadata.size !== required.length || required.some(key => !metadata.has(key)) || metadata.get('schema_version')!.toString() !== '1' || metadata.get('cipher_algorithm')!.toString() !== 'AES-256-GCM' || metadata.get('kdf_algorithm')!.toString() !== 'PBKDF2-SHA256' || metadata.get('kdf_iterations')!.toString() !== String(PBKDF2_ITERATIONS)) && metadata.get('kdf_salt')!.byteLength !== KDF_SALT_BYTES : stryMutAct_9fa48("5082") ? false : (stryCov_9fa48("5082", "5083"), (stryMutAct_9fa48("5085") ? (metadata.size !== required.length || required.some(key => !metadata.has(key)) || metadata.get('schema_version')!.toString() !== '1' || metadata.get('cipher_algorithm')!.toString() !== 'AES-256-GCM' || metadata.get('kdf_algorithm')!.toString() !== 'PBKDF2-SHA256') && metadata.get('kdf_iterations')!.toString() !== String(PBKDF2_ITERATIONS) : stryMutAct_9fa48("5084") ? false : (stryCov_9fa48("5084", "5085"), (stryMutAct_9fa48("5087") ? (metadata.size !== required.length || required.some(key => !metadata.has(key)) || metadata.get('schema_version')!.toString() !== '1' || metadata.get('cipher_algorithm')!.toString() !== 'AES-256-GCM') && metadata.get('kdf_algorithm')!.toString() !== 'PBKDF2-SHA256' : stryMutAct_9fa48("5086") ? false : (stryCov_9fa48("5086", "5087"), (stryMutAct_9fa48("5089") ? (metadata.size !== required.length || required.some(key => !metadata.has(key)) || metadata.get('schema_version')!.toString() !== '1') && metadata.get('cipher_algorithm')!.toString() !== 'AES-256-GCM' : stryMutAct_9fa48("5088") ? false : (stryCov_9fa48("5088", "5089"), (stryMutAct_9fa48("5091") ? (metadata.size !== required.length || required.some(key => !metadata.has(key))) && metadata.get('schema_version')!.toString() !== '1' : stryMutAct_9fa48("5090") ? false : (stryCov_9fa48("5090", "5091"), (stryMutAct_9fa48("5093") ? metadata.size !== required.length && required.some(key => !metadata.has(key)) : stryMutAct_9fa48("5092") ? false : (stryCov_9fa48("5092", "5093"), (stryMutAct_9fa48("5095") ? metadata.size === required.length : stryMutAct_9fa48("5094") ? false : (stryCov_9fa48("5094", "5095"), metadata.size !== required.length)) || (stryMutAct_9fa48("5096") ? required.every(key => !metadata.has(key)) : (stryCov_9fa48("5096"), required.some(stryMutAct_9fa48("5097") ? () => undefined : (stryCov_9fa48("5097"), key => stryMutAct_9fa48("5098") ? metadata.has(key) : (stryCov_9fa48("5098"), !metadata.has(key)))))))) || (stryMutAct_9fa48("5100") ? metadata.get('schema_version')!.toString() === '1' : stryMutAct_9fa48("5099") ? false : (stryCov_9fa48("5099", "5100"), metadata.get(stryMutAct_9fa48("5101") ? "" : (stryCov_9fa48("5101"), 'schema_version'))!.toString() !== (stryMutAct_9fa48("5102") ? "" : (stryCov_9fa48("5102"), '1')))))) || (stryMutAct_9fa48("5104") ? metadata.get('cipher_algorithm')!.toString() === 'AES-256-GCM' : stryMutAct_9fa48("5103") ? false : (stryCov_9fa48("5103", "5104"), metadata.get(stryMutAct_9fa48("5105") ? "" : (stryCov_9fa48("5105"), 'cipher_algorithm'))!.toString() !== (stryMutAct_9fa48("5106") ? "" : (stryCov_9fa48("5106"), 'AES-256-GCM')))))) || (stryMutAct_9fa48("5108") ? metadata.get('kdf_algorithm')!.toString() === 'PBKDF2-SHA256' : stryMutAct_9fa48("5107") ? false : (stryCov_9fa48("5107", "5108"), metadata.get(stryMutAct_9fa48("5109") ? "" : (stryCov_9fa48("5109"), 'kdf_algorithm'))!.toString() !== (stryMutAct_9fa48("5110") ? "" : (stryCov_9fa48("5110"), 'PBKDF2-SHA256')))))) || (stryMutAct_9fa48("5112") ? metadata.get('kdf_iterations')!.toString() === String(PBKDF2_ITERATIONS) : stryMutAct_9fa48("5111") ? false : (stryCov_9fa48("5111", "5112"), metadata.get(stryMutAct_9fa48("5113") ? "" : (stryCov_9fa48("5113"), 'kdf_iterations'))!.toString() !== String(PBKDF2_ITERATIONS))))) || (stryMutAct_9fa48("5115") ? metadata.get('kdf_salt')!.byteLength === KDF_SALT_BYTES : stryMutAct_9fa48("5114") ? false : (stryCov_9fa48("5114", "5115"), metadata.get(stryMutAct_9fa48("5116") ? "" : (stryCov_9fa48("5116"), 'kdf_salt'))!.byteLength !== KDF_SALT_BYTES)))) || (stryMutAct_9fa48("5118") ? metadata.get('tenant_id_hash')!.toString() === createHash('sha256').update(tenantId).digest('hex') : stryMutAct_9fa48("5117") ? false : (stryCov_9fa48("5117", "5118"), metadata.get(stryMutAct_9fa48("5119") ? "" : (stryCov_9fa48("5119"), 'tenant_id_hash'))!.toString() !== createHash(stryMutAct_9fa48("5120") ? "" : (stryCov_9fa48("5120"), 'sha256')).update(tenantId).digest(stryMutAct_9fa48("5121") ? "" : (stryCov_9fa48("5121"), 'hex')))))) {
        if (stryMutAct_9fa48("5122")) {
          {}
        } else {
          stryCov_9fa48("5122");
          for (const value of metadata.values()) value.fill(0);
          throw new SecretAccessDeniedError(stryMutAct_9fa48("5123") ? "" : (stryCov_9fa48("5123"), 'vault unlock failed'));
        }
      }
      const passwordBytes = Buffer.from(password);
      const key = pbkdf2Sync(passwordBytes, metadata.get(stryMutAct_9fa48("5124") ? "" : (stryCov_9fa48("5124"), 'kdf_salt'))!, PBKDF2_ITERATIONS, MASTER_KEY_BYTES, stryMutAct_9fa48("5125") ? "" : (stryCov_9fa48("5125"), 'sha256'));
      passwordBytes.fill(0);
      try {
        if (stryMutAct_9fa48("5126")) {
          {}
        } else {
          stryCov_9fa48("5126");
          const plaintext = decrypt(key, stryMutAct_9fa48("5127") ? {} : (stryCov_9fa48("5127"), {
            nonce: metadata.get(stryMutAct_9fa48("5128") ? "" : (stryCov_9fa48("5128"), 'key_check_nonce'))!,
            ciphertext: metadata.get(stryMutAct_9fa48("5129") ? "" : (stryCov_9fa48("5129"), 'key_check_ciphertext'))!,
            auth_tag: metadata.get(stryMutAct_9fa48("5130") ? "" : (stryCov_9fa48("5130"), 'key_check_auth_tag'))!
          }), KEY_CHECK_AAD);
          const valid = stryMutAct_9fa48("5133") ? plaintext.length === KEY_CHECK_PLAINTEXT.length || plaintext.equals(KEY_CHECK_PLAINTEXT) : stryMutAct_9fa48("5132") ? false : stryMutAct_9fa48("5131") ? true : (stryCov_9fa48("5131", "5132", "5133"), (stryMutAct_9fa48("5135") ? plaintext.length !== KEY_CHECK_PLAINTEXT.length : stryMutAct_9fa48("5134") ? true : (stryCov_9fa48("5134", "5135"), plaintext.length === KEY_CHECK_PLAINTEXT.length)) && plaintext.equals(KEY_CHECK_PLAINTEXT));
          plaintext.fill(0);
          if (stryMutAct_9fa48("5138") ? false : stryMutAct_9fa48("5137") ? true : stryMutAct_9fa48("5136") ? valid : (stryCov_9fa48("5136", "5137", "5138"), !valid)) throw new SecretAccessDeniedError(stryMutAct_9fa48("5139") ? "" : (stryCov_9fa48("5139"), 'vault unlock failed'));
          database.prepare(stryMutAct_9fa48("5140") ? "" : (stryCov_9fa48("5140"), 'INSERT OR IGNORE INTO vault_nonces(nonce) VALUES (?)')).run(metadata.get(stryMutAct_9fa48("5141") ? "" : (stryCov_9fa48("5141"), 'key_check_nonce'))!);
          return key;
        }
      } catch {
        if (stryMutAct_9fa48("5142")) {
          {}
        } else {
          stryCov_9fa48("5142");
          key.fill(0);
          throw new SecretAccessDeniedError(stryMutAct_9fa48("5143") ? "" : (stryCov_9fa48("5143"), 'vault unlock failed'));
        }
      } finally {
        if (stryMutAct_9fa48("5144")) {
          {}
        } else {
          stryCov_9fa48("5144");
          for (const value of metadata.values()) value.fill(0);
        }
      }
    }
  }
  #uniqueNonce(): Buffer {
    if (stryMutAct_9fa48("5145")) {
      {}
    } else {
      stryCov_9fa48("5145");
      for (let attempt = 0; stryMutAct_9fa48("5148") ? attempt >= 4 : stryMutAct_9fa48("5147") ? attempt <= 4 : stryMutAct_9fa48("5146") ? false : (stryCov_9fa48("5146", "5147", "5148"), attempt < 4); stryMutAct_9fa48("5149") ? attempt -= 1 : (stryCov_9fa48("5149"), attempt += 1)) {
        if (stryMutAct_9fa48("5150")) {
          {}
        } else {
          stryCov_9fa48("5150");
          const nonce = requireBytes(this.#randomBytes(GCM_NONCE_BYTES), stryMutAct_9fa48("5151") ? "" : (stryCov_9fa48("5151"), 'vault entropy'), GCM_NONCE_BYTES);
          const existing = this.#database.prepare(stryMutAct_9fa48("5152") ? "" : (stryCov_9fa48("5152"), 'SELECT 1 FROM vault_nonces WHERE nonce = ?')).get(nonce);
          if (stryMutAct_9fa48("5155") ? existing !== undefined : stryMutAct_9fa48("5154") ? false : stryMutAct_9fa48("5153") ? true : (stryCov_9fa48("5153", "5154", "5155"), existing === undefined)) return nonce;
          nonce.fill(0);
        }
      }
      throw new SecretBrokerError(stryMutAct_9fa48("5156") ? "" : (stryCov_9fa48("5156"), 'unable to generate a unique nonce'));
    }
  }
  #exchange(name: string, requester: string, context: CredentialExchangeContext): ExchangeResult {
    if (stryMutAct_9fa48("5157")) {
      {}
    } else {
      stryCov_9fa48("5157");
      const exchange = this.#database.transaction((): ExchangeResult => {
        if (stryMutAct_9fa48("5158")) {
          {}
        } else {
          stryCov_9fa48("5158");
          const now = canonicalTimestamp(this.#now());
          const replay = this.#database.prepare(stryMutAct_9fa48("5159") ? "" : (stryCov_9fa48("5159"), 'SELECT 1 FROM vault_exchanges WHERE token_id = ?')).get(context.token_id);
          if (stryMutAct_9fa48("5162") ? replay === undefined : stryMutAct_9fa48("5161") ? false : stryMutAct_9fa48("5160") ? true : (stryCov_9fa48("5160", "5161", "5162"), replay !== undefined)) {
            if (stryMutAct_9fa48("5163")) {
              {}
            } else {
              stryCov_9fa48("5163");
              this.#insertAudit(now, stryMutAct_9fa48("5164") ? "" : (stryCov_9fa48("5164"), 'get'), name, requester, stryMutAct_9fa48("5165") ? "" : (stryCov_9fa48("5165"), 'deny'), stryMutAct_9fa48("5166") ? "" : (stryCov_9fa48("5166"), 'exchange_replay'));
              return stryMutAct_9fa48("5167") ? {} : (stryCov_9fa48("5167"), {
                kind: stryMutAct_9fa48("5168") ? "" : (stryCov_9fa48("5168"), 'replay')
              });
            }
          }
          this.#database.prepare(stryMutAct_9fa48("5169") ? "" : (stryCov_9fa48("5169"), 'INSERT INTO vault_exchanges(token_id, operation_id, attempt_id, secret_name, exchanged_at) VALUES (?, ?, ?, ?, ?)')).run(context.token_id, context.operation_id, context.attempt_id, name, now);
          const row = this.#database.prepare('SELECT nonce, ciphertext, auth_tag FROM vault_secrets WHERE name = ?').get(name) as EncryptedSecretRow | undefined;
          if (stryMutAct_9fa48("5172") ? row !== undefined : stryMutAct_9fa48("5171") ? false : stryMutAct_9fa48("5170") ? true : (stryCov_9fa48("5170", "5171", "5172"), row === undefined)) {
            if (stryMutAct_9fa48("5173")) {
              {}
            } else {
              stryCov_9fa48("5173");
              this.#insertAudit(now, stryMutAct_9fa48("5174") ? "" : (stryCov_9fa48("5174"), 'get'), name, requester, stryMutAct_9fa48("5175") ? "" : (stryCov_9fa48("5175"), 'deny'), stryMutAct_9fa48("5176") ? "" : (stryCov_9fa48("5176"), 'not_found'));
              return stryMutAct_9fa48("5177") ? {} : (stryCov_9fa48("5177"), {
                kind: stryMutAct_9fa48("5178") ? "" : (stryCov_9fa48("5178"), 'missing')
              });
            }
          }
          try {
            if (stryMutAct_9fa48("5179")) {
              {}
            } else {
              stryCov_9fa48("5179");
              const value = decrypt(this.#masterKey, row, secretAad(name));
              this.#insertAudit(now, stryMutAct_9fa48("5180") ? "" : (stryCov_9fa48("5180"), 'get'), name, requester, stryMutAct_9fa48("5181") ? "" : (stryCov_9fa48("5181"), 'grant'), stryMutAct_9fa48("5182") ? "" : (stryCov_9fa48("5182"), 'exchanged'));
              return stryMutAct_9fa48("5183") ? {} : (stryCov_9fa48("5183"), {
                kind: stryMutAct_9fa48("5184") ? "" : (stryCov_9fa48("5184"), 'success'),
                value
              });
            }
          } catch {
            if (stryMutAct_9fa48("5185")) {
              {}
            } else {
              stryCov_9fa48("5185");
              this.#insertAudit(now, stryMutAct_9fa48("5186") ? "" : (stryCov_9fa48("5186"), 'get'), name, requester, stryMutAct_9fa48("5187") ? "" : (stryCov_9fa48("5187"), 'deny'), stryMutAct_9fa48("5188") ? "" : (stryCov_9fa48("5188"), 'integrity_failure'));
              return stryMutAct_9fa48("5189") ? {} : (stryCov_9fa48("5189"), {
                kind: stryMutAct_9fa48("5190") ? "" : (stryCov_9fa48("5190"), 'integrity')
              });
            }
          }
        }
      });
      try {
        if (stryMutAct_9fa48("5191")) {
          {}
        } else {
          stryCov_9fa48("5191");
          return exchange.immediate();
        }
      } catch {
        if (stryMutAct_9fa48("5192")) {
          {}
        } else {
          stryCov_9fa48("5192");
          throw new SecretAccessDeniedError();
        }
      }
    }
  }
  #writeAudit(action: SecretAuditEvent['action'], name: string, requester: string, outcome: SecretAuditEvent['outcome'], reasonCode: string): void {
    if (stryMutAct_9fa48("5193")) {
      {}
    } else {
      stryCov_9fa48("5193");
      try {
        if (stryMutAct_9fa48("5194")) {
          {}
        } else {
          stryCov_9fa48("5194");
          this.#insertAudit(canonicalTimestamp(this.#now()), action, name, requester, outcome, reasonCode);
        }
      } catch {
        if (stryMutAct_9fa48("5195")) {
          {}
        } else {
          stryCov_9fa48("5195");
          throw new SecretBrokerError(stryMutAct_9fa48("5196") ? "" : (stryCov_9fa48("5196"), 'audit write failed'));
        }
      }
    }
  }
  #insertAudit(timestamp: string, action: SecretAuditEvent['action'], name: string, requester: string, outcome: SecretAuditEvent['outcome'], reasonCode: string): void {
    if (stryMutAct_9fa48("5197")) {
      {}
    } else {
      stryCov_9fa48("5197");
      this.#database.prepare(stryMutAct_9fa48("5198") ? "" : (stryCov_9fa48("5198"), 'INSERT INTO vault_audit(timestamp, action, secret_name, requester, outcome, reason_code) VALUES (?, ?, ?, ?, ?, ?)')).run(timestamp, action, name, requester, outcome, reasonCode);
    }
  }
  #assertOpen(): void {
    if (stryMutAct_9fa48("5199")) {
      {}
    } else {
      stryCov_9fa48("5199");
      if (stryMutAct_9fa48("5201") ? false : stryMutAct_9fa48("5200") ? true : (stryCov_9fa48("5200", "5201"), this.#closed)) throw new SecretBrokerError(stryMutAct_9fa48("5202") ? "" : (stryCov_9fa48("5202"), 'secret broker is closed'));
    }
  }
}
export class SecretsBrokerApi {
  readonly #broker: SecretsBroker;
  readonly #authenticateSession: (token: string | undefined) => Promise<string | undefined>;
  constructor(options: {
    readonly broker: SecretsBroker;
    readonly authenticate_session: (token: string | undefined) => Promise<string | undefined>;
  }) {
    if (stryMutAct_9fa48("5203")) {
      {}
    } else {
      stryCov_9fa48("5203");
      if (stryMutAct_9fa48("5206") ? !isRecord(options) && !(options.broker instanceof SecretsBroker) : stryMutAct_9fa48("5205") ? false : stryMutAct_9fa48("5204") ? true : (stryCov_9fa48("5204", "5205", "5206"), (stryMutAct_9fa48("5207") ? isRecord(options) : (stryCov_9fa48("5207"), !isRecord(options))) || (stryMutAct_9fa48("5208") ? options.broker instanceof SecretsBroker : (stryCov_9fa48("5208"), !(options.broker instanceof SecretsBroker))))) {
        if (stryMutAct_9fa48("5209")) {
          {}
        } else {
          stryCov_9fa48("5209");
          throw new SecretBrokerError(stryMutAct_9fa48("5210") ? "" : (stryCov_9fa48("5210"), 'broker is required'));
        }
      }
      if (stryMutAct_9fa48("5213") ? typeof options.authenticate_session === 'function' : stryMutAct_9fa48("5212") ? false : stryMutAct_9fa48("5211") ? true : (stryCov_9fa48("5211", "5212", "5213"), typeof options.authenticate_session !== (stryMutAct_9fa48("5214") ? "" : (stryCov_9fa48("5214"), 'function')))) {
        if (stryMutAct_9fa48("5215")) {
          {}
        } else {
          stryCov_9fa48("5215");
          throw new SecretBrokerError(stryMutAct_9fa48("5216") ? "" : (stryCov_9fa48("5216"), 'session authenticator is required'));
        }
      }
      this.#broker = options.broker;
      this.#authenticateSession = options.authenticate_session;
    }
  }
  async handle(request: SecretsBrokerApiRequest): Promise<SecretsBrokerApiResponse> {
    if (stryMutAct_9fa48("5217")) {
      {}
    } else {
      stryCov_9fa48("5217");
      try {
        if (stryMutAct_9fa48("5218")) {
          {}
        } else {
          stryCov_9fa48("5218");
          if (stryMutAct_9fa48("5221") ? (!isRecord(request) || typeof request.method !== 'string') && typeof request.path !== 'string' : stryMutAct_9fa48("5220") ? false : stryMutAct_9fa48("5219") ? true : (stryCov_9fa48("5219", "5220", "5221"), (stryMutAct_9fa48("5223") ? !isRecord(request) && typeof request.method !== 'string' : stryMutAct_9fa48("5222") ? false : (stryCov_9fa48("5222", "5223"), (stryMutAct_9fa48("5224") ? isRecord(request) : (stryCov_9fa48("5224"), !isRecord(request))) || (stryMutAct_9fa48("5226") ? typeof request.method === 'string' : stryMutAct_9fa48("5225") ? false : (stryCov_9fa48("5225", "5226"), typeof request.method !== (stryMutAct_9fa48("5227") ? "" : (stryCov_9fa48("5227"), 'string')))))) || (stryMutAct_9fa48("5229") ? typeof request.path === 'string' : stryMutAct_9fa48("5228") ? false : (stryCov_9fa48("5228", "5229"), typeof request.path !== (stryMutAct_9fa48("5230") ? "" : (stryCov_9fa48("5230"), 'string')))))) {
            if (stryMutAct_9fa48("5231")) {
              {}
            } else {
              stryCov_9fa48("5231");
              return this.#response(400, stryMutAct_9fa48("5232") ? {} : (stryCov_9fa48("5232"), {
                error: stryMutAct_9fa48("5233") ? "" : (stryCov_9fa48("5233"), 'invalid_request')
              }));
            }
          }
          if (stryMutAct_9fa48("5236") ? request.method === 'GET' || request.path === '/vault/secrets' : stryMutAct_9fa48("5235") ? false : stryMutAct_9fa48("5234") ? true : (stryCov_9fa48("5234", "5235", "5236"), (stryMutAct_9fa48("5238") ? request.method !== 'GET' : stryMutAct_9fa48("5237") ? true : (stryCov_9fa48("5237", "5238"), request.method === (stryMutAct_9fa48("5239") ? "" : (stryCov_9fa48("5239"), 'GET')))) && (stryMutAct_9fa48("5241") ? request.path !== '/vault/secrets' : stryMutAct_9fa48("5240") ? true : (stryCov_9fa48("5240", "5241"), request.path === (stryMutAct_9fa48("5242") ? "" : (stryCov_9fa48("5242"), '/vault/secrets')))))) {
            if (stryMutAct_9fa48("5243")) {
              {}
            } else {
              stryCov_9fa48("5243");
              const requester = await this.#requireSession(request.session_token, stryMutAct_9fa48("5244") ? "" : (stryCov_9fa48("5244"), 'list'), stryMutAct_9fa48("5245") ? "" : (stryCov_9fa48("5245"), '*'));
              return this.#response(200, this.#broker.listSecrets(requester));
            }
          }
          const name = this.#itemName(request.path);
          if (stryMutAct_9fa48("5248") ? name !== undefined : stryMutAct_9fa48("5247") ? false : stryMutAct_9fa48("5246") ? true : (stryCov_9fa48("5246", "5247", "5248"), name === undefined)) return this.#response(404, stryMutAct_9fa48("5249") ? {} : (stryCov_9fa48("5249"), {
            error: stryMutAct_9fa48("5250") ? "" : (stryCov_9fa48("5250"), 'not_found')
          }));
          if (stryMutAct_9fa48("5253") ? request.method !== 'PUT' : stryMutAct_9fa48("5252") ? false : stryMutAct_9fa48("5251") ? true : (stryCov_9fa48("5251", "5252", "5253"), request.method === (stryMutAct_9fa48("5254") ? "" : (stryCov_9fa48("5254"), 'PUT')))) {
            if (stryMutAct_9fa48("5255")) {
              {}
            } else {
              stryCov_9fa48("5255");
              const requester = await this.#requireSession(request.session_token, stryMutAct_9fa48("5256") ? "" : (stryCov_9fa48("5256"), 'put'), name);
              if (stryMutAct_9fa48("5259") ? (!isRecord(request.body) || Object.keys(request.body).join(',') !== 'value') && typeof request.body.value !== 'string' : stryMutAct_9fa48("5258") ? false : stryMutAct_9fa48("5257") ? true : (stryCov_9fa48("5257", "5258", "5259"), (stryMutAct_9fa48("5261") ? !isRecord(request.body) && Object.keys(request.body).join(',') !== 'value' : stryMutAct_9fa48("5260") ? false : (stryCov_9fa48("5260", "5261"), (stryMutAct_9fa48("5262") ? isRecord(request.body) : (stryCov_9fa48("5262"), !isRecord(request.body))) || (stryMutAct_9fa48("5264") ? Object.keys(request.body).join(',') === 'value' : stryMutAct_9fa48("5263") ? false : (stryCov_9fa48("5263", "5264"), Object.keys(request.body).join(stryMutAct_9fa48("5265") ? "" : (stryCov_9fa48("5265"), ',')) !== (stryMutAct_9fa48("5266") ? "" : (stryCov_9fa48("5266"), 'value')))))) || (stryMutAct_9fa48("5268") ? typeof request.body.value === 'string' : stryMutAct_9fa48("5267") ? false : (stryCov_9fa48("5267", "5268"), typeof request.body.value !== (stryMutAct_9fa48("5269") ? "" : (stryCov_9fa48("5269"), 'string')))))) {
                if (stryMutAct_9fa48("5270")) {
                  {}
                } else {
                  stryCov_9fa48("5270");
                  this.#broker[RECORD_DENIAL](stryMutAct_9fa48("5271") ? "" : (stryCov_9fa48("5271"), 'put'), name, requester, stryMutAct_9fa48("5272") ? "" : (stryCov_9fa48("5272"), 'invalid_request'));
                  return this.#response(400, stryMutAct_9fa48("5273") ? {} : (stryCov_9fa48("5273"), {
                    error: stryMutAct_9fa48("5274") ? "" : (stryCov_9fa48("5274"), 'invalid_request')
                  }));
                }
              }
              const value = Buffer.from(request.body.value);
              try {
                if (stryMutAct_9fa48("5275")) {
                  {}
                } else {
                  stryCov_9fa48("5275");
                  this.#broker.putSecret(name, value, requester);
                }
              } finally {
                if (stryMutAct_9fa48("5276")) {
                  {}
                } else {
                  stryCov_9fa48("5276");
                  value.fill(0);
                }
              }
              return this.#response(201, stryMutAct_9fa48("5277") ? {} : (stryCov_9fa48("5277"), {
                stored: stryMutAct_9fa48("5278") ? false : (stryCov_9fa48("5278"), true)
              }));
            }
          }
          if (stryMutAct_9fa48("5281") ? request.method !== 'DELETE' : stryMutAct_9fa48("5280") ? false : stryMutAct_9fa48("5279") ? true : (stryCov_9fa48("5279", "5280", "5281"), request.method === (stryMutAct_9fa48("5282") ? "" : (stryCov_9fa48("5282"), 'DELETE')))) {
            if (stryMutAct_9fa48("5283")) {
              {}
            } else {
              stryCov_9fa48("5283");
              const requester = await this.#requireSession(request.session_token, stryMutAct_9fa48("5284") ? "" : (stryCov_9fa48("5284"), 'delete'), name);
              return this.#broker.deleteSecret(name, requester) ? this.#response(204, null) : this.#response(404, stryMutAct_9fa48("5285") ? {} : (stryCov_9fa48("5285"), {
                error: stryMutAct_9fa48("5286") ? "" : (stryCov_9fa48("5286"), 'secret_not_found')
              }));
            }
          }
          if (stryMutAct_9fa48("5289") ? request.method !== 'GET' : stryMutAct_9fa48("5288") ? false : stryMutAct_9fa48("5287") ? true : (stryCov_9fa48("5287", "5288", "5289"), request.method === (stryMutAct_9fa48("5290") ? "" : (stryCov_9fa48("5290"), 'GET')))) {
            if (stryMutAct_9fa48("5291")) {
              {}
            } else {
              stryCov_9fa48("5291");
              if (stryMutAct_9fa48("5294") ? request.capability === undefined && request.confirmation_key_thumbprint === undefined : stryMutAct_9fa48("5293") ? false : stryMutAct_9fa48("5292") ? true : (stryCov_9fa48("5292", "5293", "5294"), (stryMutAct_9fa48("5296") ? request.capability !== undefined : stryMutAct_9fa48("5295") ? false : (stryCov_9fa48("5295", "5296"), request.capability === undefined)) || (stryMutAct_9fa48("5298") ? request.confirmation_key_thumbprint !== undefined : stryMutAct_9fa48("5297") ? false : (stryCov_9fa48("5297", "5298"), request.confirmation_key_thumbprint === undefined)))) {
                if (stryMutAct_9fa48("5299")) {
                  {}
                } else {
                  stryCov_9fa48("5299");
                  this.#broker[RECORD_DENIAL](stryMutAct_9fa48("5300") ? "" : (stryCov_9fa48("5300"), 'get'), name, stryMutAct_9fa48("5301") ? "" : (stryCov_9fa48("5301"), 'anonymous'), stryMutAct_9fa48("5302") ? "" : (stryCov_9fa48("5302"), 'capability_required'));
                  return this.#response(403, stryMutAct_9fa48("5303") ? {} : (stryCov_9fa48("5303"), {
                    error: stryMutAct_9fa48("5304") ? "" : (stryCov_9fa48("5304"), 'capability_required')
                  }));
                }
              }
              const requester = (stryMutAct_9fa48("5307") ? isRecord(request.capability.claims) || typeof request.capability.claims.subject_workload === 'string' : stryMutAct_9fa48("5306") ? false : stryMutAct_9fa48("5305") ? true : (stryCov_9fa48("5305", "5306", "5307"), isRecord(request.capability.claims) && (stryMutAct_9fa48("5309") ? typeof request.capability.claims.subject_workload !== 'string' : stryMutAct_9fa48("5308") ? true : (stryCov_9fa48("5308", "5309"), typeof request.capability.claims.subject_workload === (stryMutAct_9fa48("5310") ? "" : (stryCov_9fa48("5310"), 'string')))))) ? request.capability.claims.subject_workload : stryMutAct_9fa48("5311") ? "" : (stryCov_9fa48("5311"), 'anonymous');
              const value = await this.#broker.dispatchWithSecret(stryMutAct_9fa48("5312") ? {} : (stryCov_9fa48("5312"), {
                name,
                requester,
                capability: request.capability,
                confirmation_key_thumbprint: request.confirmation_key_thumbprint,
                dispatch: stryMutAct_9fa48("5313") ? () => undefined : (stryCov_9fa48("5313"), async credential => Buffer.from(credential).toString(stryMutAct_9fa48("5314") ? "" : (stryCov_9fa48("5314"), 'utf8')))
              }));
              return this.#response(200, stryMutAct_9fa48("5315") ? {} : (stryCov_9fa48("5315"), {
                value,
                expires_at: request.capability.claims.expires_at
              }), stryMutAct_9fa48("5316") ? {} : (stryCov_9fa48("5316"), {
                'cache-control': stryMutAct_9fa48("5317") ? "" : (stryCov_9fa48("5317"), 'no-store'),
                pragma: stryMutAct_9fa48("5318") ? "" : (stryCov_9fa48("5318"), 'no-cache')
              }));
            }
          }
          return this.#response(404, stryMutAct_9fa48("5319") ? {} : (stryCov_9fa48("5319"), {
            error: stryMutAct_9fa48("5320") ? "" : (stryCov_9fa48("5320"), 'not_found')
          }));
        }
      } catch (error) {
        if (stryMutAct_9fa48("5321")) {
          {}
        } else {
          stryCov_9fa48("5321");
          if (stryMutAct_9fa48("5323") ? false : stryMutAct_9fa48("5322") ? true : (stryCov_9fa48("5322", "5323"), error instanceof SessionRequiredError)) {
            if (stryMutAct_9fa48("5324")) {
              {}
            } else {
              stryCov_9fa48("5324");
              return this.#response(401, stryMutAct_9fa48("5325") ? {} : (stryCov_9fa48("5325"), {
                error: stryMutAct_9fa48("5326") ? "" : (stryCov_9fa48("5326"), 'authentication_required')
              }));
            }
          }
          if (stryMutAct_9fa48("5328") ? false : stryMutAct_9fa48("5327") ? true : (stryCov_9fa48("5327", "5328"), error instanceof SecretNotFoundError)) {
            if (stryMutAct_9fa48("5329")) {
              {}
            } else {
              stryCov_9fa48("5329");
              return this.#response(404, stryMutAct_9fa48("5330") ? {} : (stryCov_9fa48("5330"), {
                error: stryMutAct_9fa48("5331") ? "" : (stryCov_9fa48("5331"), 'secret_not_found')
              }));
            }
          }
          if (stryMutAct_9fa48("5334") ? (error instanceof SecretAccessDeniedError || error instanceof SecretIntegrityError) && error instanceof CredentialDispatchError : stryMutAct_9fa48("5333") ? false : stryMutAct_9fa48("5332") ? true : (stryCov_9fa48("5332", "5333", "5334"), (stryMutAct_9fa48("5336") ? error instanceof SecretAccessDeniedError && error instanceof SecretIntegrityError : stryMutAct_9fa48("5335") ? false : (stryCov_9fa48("5335", "5336"), error instanceof SecretAccessDeniedError || error instanceof SecretIntegrityError)) || error instanceof CredentialDispatchError)) {
            if (stryMutAct_9fa48("5337")) {
              {}
            } else {
              stryCov_9fa48("5337");
              return this.#response(403, stryMutAct_9fa48("5338") ? {} : (stryCov_9fa48("5338"), {
                error: stryMutAct_9fa48("5339") ? "" : (stryCov_9fa48("5339"), 'access_denied')
              }));
            }
          }
          if (stryMutAct_9fa48("5341") ? false : stryMutAct_9fa48("5340") ? true : (stryCov_9fa48("5340", "5341"), error instanceof SecretBrokerError)) {
            if (stryMutAct_9fa48("5342")) {
              {}
            } else {
              stryCov_9fa48("5342");
              return this.#response(400, stryMutAct_9fa48("5343") ? {} : (stryCov_9fa48("5343"), {
                error: stryMutAct_9fa48("5344") ? "" : (stryCov_9fa48("5344"), 'invalid_request')
              }));
            }
          }
          return this.#response(500, stryMutAct_9fa48("5345") ? {} : (stryCov_9fa48("5345"), {
            error: stryMutAct_9fa48("5346") ? "" : (stryCov_9fa48("5346"), 'vault_unavailable')
          }));
        }
      }
    }
  }
  async #requireSession(token: string | undefined, action: SecretAuditEvent['action'], name: string): Promise<string> {
    if (stryMutAct_9fa48("5347")) {
      {}
    } else {
      stryCov_9fa48("5347");
      let requester: string | undefined;
      try {
        if (stryMutAct_9fa48("5348")) {
          {}
        } else {
          stryCov_9fa48("5348");
          requester = await this.#authenticateSession(token);
        }
      } catch {
        if (stryMutAct_9fa48("5349")) {
          {}
        } else {
          stryCov_9fa48("5349");
          requester = undefined;
        }
      }
      if (stryMutAct_9fa48("5352") ? requester === undefined && !REQUESTER_PATTERN.test(requester) : stryMutAct_9fa48("5351") ? false : stryMutAct_9fa48("5350") ? true : (stryCov_9fa48("5350", "5351", "5352"), (stryMutAct_9fa48("5354") ? requester !== undefined : stryMutAct_9fa48("5353") ? false : (stryCov_9fa48("5353", "5354"), requester === undefined)) || (stryMutAct_9fa48("5355") ? REQUESTER_PATTERN.test(requester) : (stryCov_9fa48("5355"), !REQUESTER_PATTERN.test(requester))))) {
        if (stryMutAct_9fa48("5356")) {
          {}
        } else {
          stryCov_9fa48("5356");
          this.#broker[RECORD_DENIAL](action, name, stryMutAct_9fa48("5357") ? "" : (stryCov_9fa48("5357"), 'anonymous'), stryMutAct_9fa48("5358") ? "" : (stryCov_9fa48("5358"), 'authentication_required'));
          throw new SessionRequiredError();
        }
      }
      return requester;
    }
  }
  #itemName(path: string): string | undefined {
    if (stryMutAct_9fa48("5359")) {
      {}
    } else {
      stryCov_9fa48("5359");
      const match = (stryMutAct_9fa48("5363") ? /^\/vault\/secrets\/([/]+)$/u : stryMutAct_9fa48("5362") ? /^\/vault\/secrets\/([^/])$/u : stryMutAct_9fa48("5361") ? /^\/vault\/secrets\/([^/]+)/u : stryMutAct_9fa48("5360") ? /\/vault\/secrets\/([^/]+)$/u : (stryCov_9fa48("5360", "5361", "5362", "5363"), /^\/vault\/secrets\/([^/]+)$/u)).exec(path);
      if (stryMutAct_9fa48("5366") ? match !== null : stryMutAct_9fa48("5365") ? false : stryMutAct_9fa48("5364") ? true : (stryCov_9fa48("5364", "5365", "5366"), match === null)) return undefined;
      try {
        if (stryMutAct_9fa48("5367")) {
          {}
        } else {
          stryCov_9fa48("5367");
          const name = decodeURIComponent(match[1]!);
          validateName(name);
          return name;
        }
      } catch {
        if (stryMutAct_9fa48("5368")) {
          {}
        } else {
          stryCov_9fa48("5368");
          throw new SecretBrokerError(stryMutAct_9fa48("5369") ? "" : (stryCov_9fa48("5369"), 'invalid secret name'));
        }
      }
    }
  }
  #response(status: number, body: unknown, headers: Record<string, string> = {}): SecretsBrokerApiResponse {
    if (stryMutAct_9fa48("5370")) {
      {}
    } else {
      stryCov_9fa48("5370");
      return Object.freeze(stryMutAct_9fa48("5371") ? {} : (stryCov_9fa48("5371"), {
        status,
        headers: Object.freeze(stryMutAct_9fa48("5372") ? {} : (stryCov_9fa48("5372"), {
          ...headers
        })),
        body: structuredClone(body)
      }));
    }
  }
}
class SessionRequiredError extends Error {}