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
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse, type AuthenticationResponseJSON, type GenerateAuthenticationOptionsOpts, type GenerateRegistrationOptionsOpts, type PublicKeyCredentialRequestOptionsJSON, type PublicKeyCredentialCreationOptionsJSON, type RegistrationResponseJSON, type VerifiedAuthenticationResponse, type VerifiedRegistrationResponse, type VerifyAuthenticationResponseOpts, type VerifyRegistrationResponseOpts, type WebAuthnCredential } from '@simplewebauthn/server';
import bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'node:crypto';
const DAY_MS = stryMutAct_9fa48("1235") ? 24 * 60 * 60 / 1000 : (stryCov_9fa48("1235"), (stryMutAct_9fa48("1236") ? 24 * 60 / 60 : (stryCov_9fa48("1236"), (stryMutAct_9fa48("1237") ? 24 / 60 : (stryCov_9fa48("1237"), 24 * 60)) * 60)) * 1000);
const SESSION_LIFETIME_MS = DAY_MS;
const CHALLENGE_LIFETIME_MS = stryMutAct_9fa48("1238") ? 5 * 60 / 1000 : (stryCov_9fa48("1238"), (stryMutAct_9fa48("1239") ? 5 / 60 : (stryCov_9fa48("1239"), 5 * 60)) * 1000);
const RATE_LIMIT_MS = stryMutAct_9fa48("1240") ? 15 * 60 / 1000 : (stryCov_9fa48("1240"), (stryMutAct_9fa48("1241") ? 15 / 60 : (stryCov_9fa48("1241"), 15 * 60)) * 1000);
const AUDIT_RETENTION_MS = stryMutAct_9fa48("1242") ? 90 / DAY_MS : (stryCov_9fa48("1242"), 90 * DAY_MS);
const MAX_FAILED_ATTEMPTS = 5;
const MAX_ACTIVE_CHALLENGES = 1024;
const BCRYPT_COST = 12;
const SESSION_COOKIE = stryMutAct_9fa48("1243") ? "" : (stryCov_9fa48("1243"), '__Host-harness_session');
const WEBAUTHN_COOKIE = stryMutAct_9fa48("1244") ? "" : (stryCov_9fa48("1244"), '__Host-harness_webauthn');
type AuthErrorCode = 'authentication_failed' | 'authentication_required' | 'invalid_request' | 'not_found' | 'rate_limited' | 'webauthn_verification_failed';
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly status: number;
  constructor(code: AuthErrorCode, status: number) {
    if (stryMutAct_9fa48("1245")) {
      {}
    } else {
      stryCov_9fa48("1245");
      super(code);
      this.name = stryMutAct_9fa48("1246") ? "" : (stryCov_9fa48("1246"), 'AuthError');
      this.code = code;
      this.status = status;
    }
  }
}
export interface AuthUserRecord {
  readonly user_id: string;
  readonly email: string;
  readonly password_hash: string;
  readonly webauthn_credentials: readonly WebAuthnCredential[];
}
interface SessionRecord {
  readonly token_hash: string;
  readonly user_id: string;
  readonly issued_at: string;
  readonly expires_at: string;
  revoked_at?: string;
}
interface ChallengeRecord {
  readonly key_hash: string;
  readonly kind: 'registration' | 'authentication';
  readonly user_id?: string;
  readonly challenge: string;
  readonly expires_at: string;
  consumed_at?: string;
}
interface ConsumedChallenge {
  readonly record: ChallengeRecord;
  readonly accepted: boolean;
}
export interface AuthAuditEvent {
  readonly timestamp: string;
  readonly action: 'login' | 'logout' | 'session_check' | 'webauthn_register' | 'webauthn_authenticate' | 'webauthn_verify';
  readonly outcome: 'allowed' | 'denied';
  readonly subject_ref: string;
  readonly reason_code: string;
}
interface FailedAttemptState {
  attempts: number;
  blocked_until?: string;
}
export interface WebAuthnPort {
  generateRegistrationOptions(options: GenerateRegistrationOptionsOpts): Promise<PublicKeyCredentialCreationOptionsJSON>;
  verifyRegistrationResponse(options: VerifyRegistrationResponseOpts): Promise<VerifiedRegistrationResponse>;
  generateAuthenticationOptions(options: GenerateAuthenticationOptionsOpts): Promise<PublicKeyCredentialRequestOptionsJSON>;
  verifyAuthenticationResponse(options: VerifyAuthenticationResponseOpts): Promise<VerifiedAuthenticationResponse>;
}
export interface AuthServiceOptions {
  readonly store: InMemoryAuthStore;
  readonly rp_id: string;
  readonly rp_name: string;
  readonly origin: string;
  readonly now?: () => string;
  readonly random_bytes?: (length: number) => Uint8Array;
  readonly webauthn?: WebAuthnPort;
}
export interface RegisterPasswordUserInput {
  readonly user_id: string;
  readonly email: string;
  readonly password: string;
}
export interface AuthSession {
  readonly token: string;
  readonly cookie: string;
  readonly user_id: string;
}
export interface WebAuthnCeremony<TOptions> {
  readonly options: TOptions;
  readonly cookie: string;
}
export interface AuthApiRequest {
  readonly method: string;
  readonly path: string;
  readonly client_id?: string;
  readonly cookie?: string;
  readonly body?: unknown;
}
export interface AuthApiResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}
function sha256(value: string): string {
  if (stryMutAct_9fa48("1247")) {
    {}
  } else {
    stryCov_9fa48("1247");
    return createHash(stryMutAct_9fa48("1248") ? "" : (stryCov_9fa48("1248"), 'sha256')).update(value).digest(stryMutAct_9fa48("1249") ? "" : (stryCov_9fa48("1249"), 'hex'));
  }
}
function cloneCredential(credential: WebAuthnCredential): WebAuthnCredential {
  if (stryMutAct_9fa48("1250")) {
    {}
  } else {
    stryCov_9fa48("1250");
    return stryMutAct_9fa48("1251") ? {} : (stryCov_9fa48("1251"), {
      id: credential.id,
      publicKey: new Uint8Array(credential.publicKey),
      counter: credential.counter,
      ...((stryMutAct_9fa48("1254") ? credential.transports !== undefined : stryMutAct_9fa48("1253") ? false : stryMutAct_9fa48("1252") ? true : (stryCov_9fa48("1252", "1253", "1254"), credential.transports === undefined)) ? {} : stryMutAct_9fa48("1255") ? {} : (stryCov_9fa48("1255"), {
        transports: stryMutAct_9fa48("1256") ? [] : (stryCov_9fa48("1256"), [...credential.transports])
      }))
    });
  }
}
function validateCredential(credential: WebAuthnCredential): void {
  if (stryMutAct_9fa48("1257")) {
    {}
  } else {
    stryCov_9fa48("1257");
    if (stryMutAct_9fa48("1260") ? (typeof credential.id !== 'string' || credential.id.length === 0 || credential.id.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(credential.id) || !(credential.publicKey instanceof Uint8Array) || credential.publicKey.byteLength === 0 || credential.publicKey.byteLength > 4096 || !Number.isSafeInteger(credential.counter) || credential.counter < 0) && credential.transports !== undefined && !Array.isArray(credential.transports) : stryMutAct_9fa48("1259") ? false : stryMutAct_9fa48("1258") ? true : (stryCov_9fa48("1258", "1259", "1260"), (stryMutAct_9fa48("1262") ? (typeof credential.id !== 'string' || credential.id.length === 0 || credential.id.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(credential.id) || !(credential.publicKey instanceof Uint8Array) || credential.publicKey.byteLength === 0 || credential.publicKey.byteLength > 4096 || !Number.isSafeInteger(credential.counter)) && credential.counter < 0 : stryMutAct_9fa48("1261") ? false : (stryCov_9fa48("1261", "1262"), (stryMutAct_9fa48("1264") ? (typeof credential.id !== 'string' || credential.id.length === 0 || credential.id.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(credential.id) || !(credential.publicKey instanceof Uint8Array) || credential.publicKey.byteLength === 0 || credential.publicKey.byteLength > 4096) && !Number.isSafeInteger(credential.counter) : stryMutAct_9fa48("1263") ? false : (stryCov_9fa48("1263", "1264"), (stryMutAct_9fa48("1266") ? (typeof credential.id !== 'string' || credential.id.length === 0 || credential.id.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(credential.id) || !(credential.publicKey instanceof Uint8Array) || credential.publicKey.byteLength === 0) && credential.publicKey.byteLength > 4096 : stryMutAct_9fa48("1265") ? false : (stryCov_9fa48("1265", "1266"), (stryMutAct_9fa48("1268") ? (typeof credential.id !== 'string' || credential.id.length === 0 || credential.id.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(credential.id) || !(credential.publicKey instanceof Uint8Array)) && credential.publicKey.byteLength === 0 : stryMutAct_9fa48("1267") ? false : (stryCov_9fa48("1267", "1268"), (stryMutAct_9fa48("1270") ? (typeof credential.id !== 'string' || credential.id.length === 0 || credential.id.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(credential.id)) && !(credential.publicKey instanceof Uint8Array) : stryMutAct_9fa48("1269") ? false : (stryCov_9fa48("1269", "1270"), (stryMutAct_9fa48("1272") ? (typeof credential.id !== 'string' || credential.id.length === 0 || credential.id.length > 1024) && !/^[A-Za-z0-9_-]+$/u.test(credential.id) : stryMutAct_9fa48("1271") ? false : (stryCov_9fa48("1271", "1272"), (stryMutAct_9fa48("1274") ? (typeof credential.id !== 'string' || credential.id.length === 0) && credential.id.length > 1024 : stryMutAct_9fa48("1273") ? false : (stryCov_9fa48("1273", "1274"), (stryMutAct_9fa48("1276") ? typeof credential.id !== 'string' && credential.id.length === 0 : stryMutAct_9fa48("1275") ? false : (stryCov_9fa48("1275", "1276"), (stryMutAct_9fa48("1278") ? typeof credential.id === 'string' : stryMutAct_9fa48("1277") ? false : (stryCov_9fa48("1277", "1278"), typeof credential.id !== (stryMutAct_9fa48("1279") ? "" : (stryCov_9fa48("1279"), 'string')))) || (stryMutAct_9fa48("1281") ? credential.id.length !== 0 : stryMutAct_9fa48("1280") ? false : (stryCov_9fa48("1280", "1281"), credential.id.length === 0)))) || (stryMutAct_9fa48("1284") ? credential.id.length <= 1024 : stryMutAct_9fa48("1283") ? credential.id.length >= 1024 : stryMutAct_9fa48("1282") ? false : (stryCov_9fa48("1282", "1283", "1284"), credential.id.length > 1024)))) || (stryMutAct_9fa48("1285") ? /^[A-Za-z0-9_-]+$/u.test(credential.id) : (stryCov_9fa48("1285"), !(stryMutAct_9fa48("1289") ? /^[^A-Za-z0-9_-]+$/u : stryMutAct_9fa48("1288") ? /^[A-Za-z0-9_-]$/u : stryMutAct_9fa48("1287") ? /^[A-Za-z0-9_-]+/u : stryMutAct_9fa48("1286") ? /[A-Za-z0-9_-]+$/u : (stryCov_9fa48("1286", "1287", "1288", "1289"), /^[A-Za-z0-9_-]+$/u)).test(credential.id))))) || (stryMutAct_9fa48("1290") ? credential.publicKey instanceof Uint8Array : (stryCov_9fa48("1290"), !(credential.publicKey instanceof Uint8Array))))) || (stryMutAct_9fa48("1292") ? credential.publicKey.byteLength !== 0 : stryMutAct_9fa48("1291") ? false : (stryCov_9fa48("1291", "1292"), credential.publicKey.byteLength === 0)))) || (stryMutAct_9fa48("1295") ? credential.publicKey.byteLength <= 4096 : stryMutAct_9fa48("1294") ? credential.publicKey.byteLength >= 4096 : stryMutAct_9fa48("1293") ? false : (stryCov_9fa48("1293", "1294", "1295"), credential.publicKey.byteLength > 4096)))) || (stryMutAct_9fa48("1296") ? Number.isSafeInteger(credential.counter) : (stryCov_9fa48("1296"), !Number.isSafeInteger(credential.counter))))) || (stryMutAct_9fa48("1299") ? credential.counter >= 0 : stryMutAct_9fa48("1298") ? credential.counter <= 0 : stryMutAct_9fa48("1297") ? false : (stryCov_9fa48("1297", "1298", "1299"), credential.counter < 0)))) || (stryMutAct_9fa48("1301") ? credential.transports !== undefined || !Array.isArray(credential.transports) : stryMutAct_9fa48("1300") ? false : (stryCov_9fa48("1300", "1301"), (stryMutAct_9fa48("1303") ? credential.transports === undefined : stryMutAct_9fa48("1302") ? true : (stryCov_9fa48("1302", "1303"), credential.transports !== undefined)) && (stryMutAct_9fa48("1304") ? Array.isArray(credential.transports) : (stryCov_9fa48("1304"), !Array.isArray(credential.transports))))))) {
      if (stryMutAct_9fa48("1305")) {
        {}
      } else {
        stryCov_9fa48("1305");
        throw new AuthError(stryMutAct_9fa48("1306") ? "" : (stryCov_9fa48("1306"), 'webauthn_verification_failed'), 400);
      }
    }
  }
}
function cloneUser(user: AuthUserRecord): AuthUserRecord {
  if (stryMutAct_9fa48("1307")) {
    {}
  } else {
    stryCov_9fa48("1307");
    return stryMutAct_9fa48("1308") ? {} : (stryCov_9fa48("1308"), {
      user_id: user.user_id,
      email: user.email,
      password_hash: user.password_hash,
      webauthn_credentials: user.webauthn_credentials.map(cloneCredential)
    });
  }
}
function normalizeEmail(value: unknown): string {
  if (stryMutAct_9fa48("1309")) {
    {}
  } else {
    stryCov_9fa48("1309");
    if (stryMutAct_9fa48("1312") ? typeof value === 'string' : stryMutAct_9fa48("1311") ? false : stryMutAct_9fa48("1310") ? true : (stryCov_9fa48("1310", "1311", "1312"), typeof value !== (stryMutAct_9fa48("1313") ? "" : (stryCov_9fa48("1313"), 'string')))) throw new AuthError(stryMutAct_9fa48("1314") ? "" : (stryCov_9fa48("1314"), 'invalid_request'), 400);
    const normalized = stryMutAct_9fa48("1316") ? value.toLowerCase() : stryMutAct_9fa48("1315") ? value.trim().toUpperCase() : (stryCov_9fa48("1315", "1316"), value.trim().toLowerCase());
    if (stryMutAct_9fa48("1319") ? normalized.length > 254 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized) : stryMutAct_9fa48("1318") ? false : stryMutAct_9fa48("1317") ? true : (stryCov_9fa48("1317", "1318", "1319"), (stryMutAct_9fa48("1322") ? normalized.length <= 254 : stryMutAct_9fa48("1321") ? normalized.length >= 254 : stryMutAct_9fa48("1320") ? false : (stryCov_9fa48("1320", "1321", "1322"), normalized.length > 254)) || (stryMutAct_9fa48("1323") ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized) : (stryCov_9fa48("1323"), !(stryMutAct_9fa48("1334") ? /^[^\s@]+@[^\s@]+\.[^\S@]+$/u : stryMutAct_9fa48("1333") ? /^[^\s@]+@[^\s@]+\.[\s@]+$/u : stryMutAct_9fa48("1332") ? /^[^\s@]+@[^\s@]+\.[^\s@]$/u : stryMutAct_9fa48("1331") ? /^[^\s@]+@[^\S@]+\.[^\s@]+$/u : stryMutAct_9fa48("1330") ? /^[^\s@]+@[\s@]+\.[^\s@]+$/u : stryMutAct_9fa48("1329") ? /^[^\s@]+@[^\s@]\.[^\s@]+$/u : stryMutAct_9fa48("1328") ? /^[^\S@]+@[^\s@]+\.[^\s@]+$/u : stryMutAct_9fa48("1327") ? /^[\s@]+@[^\s@]+\.[^\s@]+$/u : stryMutAct_9fa48("1326") ? /^[^\s@]@[^\s@]+\.[^\s@]+$/u : stryMutAct_9fa48("1325") ? /^[^\s@]+@[^\s@]+\.[^\s@]+/u : stryMutAct_9fa48("1324") ? /[^\s@]+@[^\s@]+\.[^\s@]+$/u : (stryCov_9fa48("1324", "1325", "1326", "1327", "1328", "1329", "1330", "1331", "1332", "1333", "1334"), /^[^\s@]+@[^\s@]+\.[^\s@]+$/u)).test(normalized))))) {
      if (stryMutAct_9fa48("1335")) {
        {}
      } else {
        stryCov_9fa48("1335");
        throw new AuthError(stryMutAct_9fa48("1336") ? "" : (stryCov_9fa48("1336"), 'invalid_request'), 400);
      }
    }
    return normalized;
  }
}
function requireString(value: unknown, maximum: number): string {
  if (stryMutAct_9fa48("1337")) {
    {}
  } else {
    stryCov_9fa48("1337");
    if (stryMutAct_9fa48("1340") ? (typeof value !== 'string' || value.length === 0) && value.length > maximum : stryMutAct_9fa48("1339") ? false : stryMutAct_9fa48("1338") ? true : (stryCov_9fa48("1338", "1339", "1340"), (stryMutAct_9fa48("1342") ? typeof value !== 'string' && value.length === 0 : stryMutAct_9fa48("1341") ? false : (stryCov_9fa48("1341", "1342"), (stryMutAct_9fa48("1344") ? typeof value === 'string' : stryMutAct_9fa48("1343") ? false : (stryCov_9fa48("1343", "1344"), typeof value !== (stryMutAct_9fa48("1345") ? "" : (stryCov_9fa48("1345"), 'string')))) || (stryMutAct_9fa48("1347") ? value.length !== 0 : stryMutAct_9fa48("1346") ? false : (stryCov_9fa48("1346", "1347"), value.length === 0)))) || (stryMutAct_9fa48("1350") ? value.length <= maximum : stryMutAct_9fa48("1349") ? value.length >= maximum : stryMutAct_9fa48("1348") ? false : (stryCov_9fa48("1348", "1349", "1350"), value.length > maximum)))) {
      if (stryMutAct_9fa48("1351")) {
        {}
      } else {
        stryCov_9fa48("1351");
        throw new AuthError(stryMutAct_9fa48("1352") ? "" : (stryCov_9fa48("1352"), 'invalid_request'), 400);
      }
    }
    return value;
  }
}
function instant(value: string): number {
  if (stryMutAct_9fa48("1353")) {
    {}
  } else {
    stryCov_9fa48("1353");
    const parsed = Date.parse(value);
    if (stryMutAct_9fa48("1356") ? false : stryMutAct_9fa48("1355") ? true : stryMutAct_9fa48("1354") ? Number.isFinite(parsed) : (stryCov_9fa48("1354", "1355", "1356"), !Number.isFinite(parsed))) throw new Error(stryMutAct_9fa48("1357") ? "" : (stryCov_9fa48("1357"), 'invalid clock value'));
    return parsed;
  }
}
function parseCookie(cookie: string | undefined, expectedName: string): string | undefined {
  if (stryMutAct_9fa48("1358")) {
    {}
  } else {
    stryCov_9fa48("1358");
    if (stryMutAct_9fa48("1361") ? cookie !== undefined : stryMutAct_9fa48("1360") ? false : stryMutAct_9fa48("1359") ? true : (stryCov_9fa48("1359", "1360", "1361"), cookie === undefined)) return undefined;
    let token: string | undefined;
    for (const part of cookie.split(stryMutAct_9fa48("1362") ? "" : (stryCov_9fa48("1362"), ';'))) {
      if (stryMutAct_9fa48("1363")) {
        {}
      } else {
        stryCov_9fa48("1363");
        const [name, ...rest] = stryMutAct_9fa48("1364") ? part.split('=') : (stryCov_9fa48("1364"), part.trim().split(stryMutAct_9fa48("1365") ? "" : (stryCov_9fa48("1365"), '=')));
        if (stryMutAct_9fa48("1368") ? name === expectedName : stryMutAct_9fa48("1367") ? false : stryMutAct_9fa48("1366") ? true : (stryCov_9fa48("1366", "1367", "1368"), name !== expectedName)) continue;
        if (stryMutAct_9fa48("1371") ? (token !== undefined || rest.length !== 1) && !/^[A-Za-z0-9_-]{43}$/u.test(rest[0] ?? '') : stryMutAct_9fa48("1370") ? false : stryMutAct_9fa48("1369") ? true : (stryCov_9fa48("1369", "1370", "1371"), (stryMutAct_9fa48("1373") ? token !== undefined && rest.length !== 1 : stryMutAct_9fa48("1372") ? false : (stryCov_9fa48("1372", "1373"), (stryMutAct_9fa48("1375") ? token === undefined : stryMutAct_9fa48("1374") ? false : (stryCov_9fa48("1374", "1375"), token !== undefined)) || (stryMutAct_9fa48("1377") ? rest.length === 1 : stryMutAct_9fa48("1376") ? false : (stryCov_9fa48("1376", "1377"), rest.length !== 1)))) || (stryMutAct_9fa48("1378") ? /^[A-Za-z0-9_-]{43}$/u.test(rest[0] ?? '') : (stryCov_9fa48("1378"), !(stryMutAct_9fa48("1382") ? /^[^A-Za-z0-9_-]{43}$/u : stryMutAct_9fa48("1381") ? /^[A-Za-z0-9_-]$/u : stryMutAct_9fa48("1380") ? /^[A-Za-z0-9_-]{43}/u : stryMutAct_9fa48("1379") ? /[A-Za-z0-9_-]{43}$/u : (stryCov_9fa48("1379", "1380", "1381", "1382"), /^[A-Za-z0-9_-]{43}$/u)).test(stryMutAct_9fa48("1383") ? rest[0] && '' : (stryCov_9fa48("1383"), rest[0] ?? (stryMutAct_9fa48("1384") ? "Stryker was here!" : (stryCov_9fa48("1384"), '')))))))) {
          if (stryMutAct_9fa48("1385")) {
            {}
          } else {
            stryCov_9fa48("1385");
            return undefined;
          }
        }
        token = rest[0];
      }
    }
    return token;
  }
}
function parseSessionCookie(cookie: string | undefined): string | undefined {
  if (stryMutAct_9fa48("1386")) {
    {}
  } else {
    stryCov_9fa48("1386");
    return parseCookie(cookie, SESSION_COOKIE);
  }
}
function parseWebAuthnCookie(cookie: string | undefined): string | undefined {
  if (stryMutAct_9fa48("1387")) {
    {}
  } else {
    stryCov_9fa48("1387");
    return parseCookie(cookie, WEBAUTHN_COOKIE);
  }
}
export class InMemoryAuthStore {
  readonly #usersByEmail = new Map<string, AuthUserRecord>();
  readonly #usersById = new Map<string, AuthUserRecord>();
  readonly #credentialOwners = new Map<string, string>();
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #challenges = new Map<string, ChallengeRecord>();
  async createUser(user: AuthUserRecord): Promise<void> {
    if (stryMutAct_9fa48("1388")) {
      {}
    } else {
      stryCov_9fa48("1388");
      if (stryMutAct_9fa48("1391") ? this.#usersByEmail.has(user.email) && this.#usersById.has(user.user_id) : stryMutAct_9fa48("1390") ? false : stryMutAct_9fa48("1389") ? true : (stryCov_9fa48("1389", "1390", "1391"), this.#usersByEmail.has(user.email) || this.#usersById.has(user.user_id))) {
        if (stryMutAct_9fa48("1392")) {
          {}
        } else {
          stryCov_9fa48("1392");
          throw new AuthError(stryMutAct_9fa48("1393") ? "" : (stryCov_9fa48("1393"), 'invalid_request'), 400);
        }
      }
      const credentialIds = new Set<string>();
      for (const credential of user.webauthn_credentials) {
        if (stryMutAct_9fa48("1394")) {
          {}
        } else {
          stryCov_9fa48("1394");
          validateCredential(credential);
          if (stryMutAct_9fa48("1397") ? credentialIds.has(credential.id) && this.#credentialOwners.has(credential.id) : stryMutAct_9fa48("1396") ? false : stryMutAct_9fa48("1395") ? true : (stryCov_9fa48("1395", "1396", "1397"), credentialIds.has(credential.id) || this.#credentialOwners.has(credential.id))) {
            if (stryMutAct_9fa48("1398")) {
              {}
            } else {
              stryCov_9fa48("1398");
              throw new AuthError(stryMutAct_9fa48("1399") ? "" : (stryCov_9fa48("1399"), 'invalid_request'), 400);
            }
          }
          credentialIds.add(credential.id);
        }
      }
      const stored = cloneUser(user);
      this.#usersByEmail.set(user.email, stored);
      this.#usersById.set(user.user_id, stored);
      for (const credentialId of credentialIds) this.#credentialOwners.set(credentialId, user.user_id);
    }
  }
  async findUserByEmail(email: string): Promise<AuthUserRecord | undefined> {
    if (stryMutAct_9fa48("1400")) {
      {}
    } else {
      stryCov_9fa48("1400");
      const user = this.#usersByEmail.get(email);
      return (stryMutAct_9fa48("1403") ? user !== undefined : stryMutAct_9fa48("1402") ? false : stryMutAct_9fa48("1401") ? true : (stryCov_9fa48("1401", "1402", "1403"), user === undefined)) ? undefined : cloneUser(user);
    }
  }
  getUser(userId: string): AuthUserRecord | undefined {
    if (stryMutAct_9fa48("1404")) {
      {}
    } else {
      stryCov_9fa48("1404");
      const user = this.#usersById.get(userId);
      return (stryMutAct_9fa48("1407") ? user !== undefined : stryMutAct_9fa48("1406") ? false : stryMutAct_9fa48("1405") ? true : (stryCov_9fa48("1405", "1406", "1407"), user === undefined)) ? undefined : cloneUser(user);
    }
  }
  async addWebAuthnCredential(userId: string, credential: WebAuthnCredential): Promise<void> {
    if (stryMutAct_9fa48("1408")) {
      {}
    } else {
      stryCov_9fa48("1408");
      validateCredential(credential);
      const current = this.#usersById.get(userId);
      if (stryMutAct_9fa48("1411") ? current === undefined && this.#credentialOwners.has(credential.id) : stryMutAct_9fa48("1410") ? false : stryMutAct_9fa48("1409") ? true : (stryCov_9fa48("1409", "1410", "1411"), (stryMutAct_9fa48("1413") ? current !== undefined : stryMutAct_9fa48("1412") ? false : (stryCov_9fa48("1412", "1413"), current === undefined)) || this.#credentialOwners.has(credential.id))) {
        if (stryMutAct_9fa48("1414")) {
          {}
        } else {
          stryCov_9fa48("1414");
          throw new AuthError(stryMutAct_9fa48("1415") ? "" : (stryCov_9fa48("1415"), 'webauthn_verification_failed'), 400);
        }
      }
      const updated: AuthUserRecord = stryMutAct_9fa48("1416") ? {} : (stryCov_9fa48("1416"), {
        ...current,
        webauthn_credentials: stryMutAct_9fa48("1417") ? [] : (stryCov_9fa48("1417"), [...current.webauthn_credentials.map(cloneCredential), cloneCredential(credential)])
      });
      this.#usersById.set(userId, updated);
      this.#usersByEmail.set(current.email, updated);
      this.#credentialOwners.set(credential.id, userId);
    }
  }
  findWebAuthnCredential(credentialId: string): {
    readonly user: AuthUserRecord;
    readonly credential: WebAuthnCredential;
  } | undefined {
    if (stryMutAct_9fa48("1418")) {
      {}
    } else {
      stryCov_9fa48("1418");
      const userId = this.#credentialOwners.get(credentialId);
      const user = (stryMutAct_9fa48("1421") ? userId !== undefined : stryMutAct_9fa48("1420") ? false : stryMutAct_9fa48("1419") ? true : (stryCov_9fa48("1419", "1420", "1421"), userId === undefined)) ? undefined : this.#usersById.get(userId);
      const credential = stryMutAct_9fa48("1422") ? user.webauthn_credentials.find(candidate => candidate.id === credentialId) : (stryCov_9fa48("1422"), user?.webauthn_credentials.find(stryMutAct_9fa48("1423") ? () => undefined : (stryCov_9fa48("1423"), candidate => stryMutAct_9fa48("1426") ? candidate.id !== credentialId : stryMutAct_9fa48("1425") ? false : stryMutAct_9fa48("1424") ? true : (stryCov_9fa48("1424", "1425", "1426"), candidate.id === credentialId))));
      if (stryMutAct_9fa48("1429") ? user === undefined && credential === undefined : stryMutAct_9fa48("1428") ? false : stryMutAct_9fa48("1427") ? true : (stryCov_9fa48("1427", "1428", "1429"), (stryMutAct_9fa48("1431") ? user !== undefined : stryMutAct_9fa48("1430") ? false : (stryCov_9fa48("1430", "1431"), user === undefined)) || (stryMutAct_9fa48("1433") ? credential !== undefined : stryMutAct_9fa48("1432") ? false : (stryCov_9fa48("1432", "1433"), credential === undefined)))) return undefined;
      return Object.freeze(stryMutAct_9fa48("1434") ? {} : (stryCov_9fa48("1434"), {
        user: cloneUser(user),
        credential: cloneCredential(credential)
      }));
    }
  }
  updateWebAuthnCounter(userId: string, credentialId: string, expectedCounter: number, newCounter: number): boolean {
    if (stryMutAct_9fa48("1435")) {
      {}
    } else {
      stryCov_9fa48("1435");
      if (stryMutAct_9fa48("1438") ? !Number.isSafeInteger(newCounter) && newCounter < 0 : stryMutAct_9fa48("1437") ? false : stryMutAct_9fa48("1436") ? true : (stryCov_9fa48("1436", "1437", "1438"), (stryMutAct_9fa48("1439") ? Number.isSafeInteger(newCounter) : (stryCov_9fa48("1439"), !Number.isSafeInteger(newCounter))) || (stryMutAct_9fa48("1442") ? newCounter >= 0 : stryMutAct_9fa48("1441") ? newCounter <= 0 : stryMutAct_9fa48("1440") ? false : (stryCov_9fa48("1440", "1441", "1442"), newCounter < 0)))) return stryMutAct_9fa48("1443") ? true : (stryCov_9fa48("1443"), false);
      const current = this.#usersById.get(userId);
      const index = stryMutAct_9fa48("1444") ? current?.webauthn_credentials.findIndex(credential => credential.id === credentialId) && -1 : (stryCov_9fa48("1444"), (stryMutAct_9fa48("1445") ? current.webauthn_credentials.findIndex(credential => credential.id === credentialId) : (stryCov_9fa48("1445"), current?.webauthn_credentials.findIndex(stryMutAct_9fa48("1446") ? () => undefined : (stryCov_9fa48("1446"), credential => stryMutAct_9fa48("1449") ? credential.id !== credentialId : stryMutAct_9fa48("1448") ? false : stryMutAct_9fa48("1447") ? true : (stryCov_9fa48("1447", "1448", "1449"), credential.id === credentialId))))) ?? (stryMutAct_9fa48("1450") ? +1 : (stryCov_9fa48("1450"), -1)));
      const credential = (stryMutAct_9fa48("1454") ? index >= 0 : stryMutAct_9fa48("1453") ? index <= 0 : stryMutAct_9fa48("1452") ? false : stryMutAct_9fa48("1451") ? true : (stryCov_9fa48("1451", "1452", "1453", "1454"), index < 0)) ? undefined : stryMutAct_9fa48("1455") ? current.webauthn_credentials[index] : (stryCov_9fa48("1455"), current?.webauthn_credentials[index]);
      if (stryMutAct_9fa48("1458") ? (current === undefined || credential === undefined || credential.counter !== expectedCounter) && expectedCounter !== 0 && newCounter <= expectedCounter : stryMutAct_9fa48("1457") ? false : stryMutAct_9fa48("1456") ? true : (stryCov_9fa48("1456", "1457", "1458"), (stryMutAct_9fa48("1460") ? (current === undefined || credential === undefined) && credential.counter !== expectedCounter : stryMutAct_9fa48("1459") ? false : (stryCov_9fa48("1459", "1460"), (stryMutAct_9fa48("1462") ? current === undefined && credential === undefined : stryMutAct_9fa48("1461") ? false : (stryCov_9fa48("1461", "1462"), (stryMutAct_9fa48("1464") ? current !== undefined : stryMutAct_9fa48("1463") ? false : (stryCov_9fa48("1463", "1464"), current === undefined)) || (stryMutAct_9fa48("1466") ? credential !== undefined : stryMutAct_9fa48("1465") ? false : (stryCov_9fa48("1465", "1466"), credential === undefined)))) || (stryMutAct_9fa48("1468") ? credential.counter === expectedCounter : stryMutAct_9fa48("1467") ? false : (stryCov_9fa48("1467", "1468"), credential.counter !== expectedCounter)))) || (stryMutAct_9fa48("1470") ? expectedCounter !== 0 || newCounter <= expectedCounter : stryMutAct_9fa48("1469") ? false : (stryCov_9fa48("1469", "1470"), (stryMutAct_9fa48("1472") ? expectedCounter === 0 : stryMutAct_9fa48("1471") ? true : (stryCov_9fa48("1471", "1472"), expectedCounter !== 0)) && (stryMutAct_9fa48("1475") ? newCounter > expectedCounter : stryMutAct_9fa48("1474") ? newCounter < expectedCounter : stryMutAct_9fa48("1473") ? true : (stryCov_9fa48("1473", "1474", "1475"), newCounter <= expectedCounter)))))) {
        if (stryMutAct_9fa48("1476")) {
          {}
        } else {
          stryCov_9fa48("1476");
          return stryMutAct_9fa48("1477") ? true : (stryCov_9fa48("1477"), false);
        }
      }
      const credentials = current.webauthn_credentials.map(stryMutAct_9fa48("1478") ? () => undefined : (stryCov_9fa48("1478"), (item, credentialIndex) => (stryMutAct_9fa48("1481") ? credentialIndex !== index : stryMutAct_9fa48("1480") ? false : stryMutAct_9fa48("1479") ? true : (stryCov_9fa48("1479", "1480", "1481"), credentialIndex === index)) ? cloneCredential(stryMutAct_9fa48("1482") ? {} : (stryCov_9fa48("1482"), {
        ...item,
        counter: newCounter
      })) : cloneCredential(item)));
      const updated: AuthUserRecord = stryMutAct_9fa48("1483") ? {} : (stryCov_9fa48("1483"), {
        ...current,
        webauthn_credentials: credentials
      });
      this.#usersById.set(userId, updated);
      this.#usersByEmail.set(current.email, updated);
      return stryMutAct_9fa48("1484") ? false : (stryCov_9fa48("1484"), true);
    }
  }
  createSession(record: SessionRecord): void {
    if (stryMutAct_9fa48("1485")) {
      {}
    } else {
      stryCov_9fa48("1485");
      if (stryMutAct_9fa48("1487") ? false : stryMutAct_9fa48("1486") ? true : (stryCov_9fa48("1486", "1487"), this.#sessions.has(record.token_hash))) throw new AuthError(stryMutAct_9fa48("1488") ? "" : (stryCov_9fa48("1488"), 'authentication_failed'), 401);
      this.#sessions.set(record.token_hash, stryMutAct_9fa48("1489") ? {} : (stryCov_9fa48("1489"), {
        ...record
      }));
    }
  }
  findSession(tokenHash: string): SessionRecord | undefined {
    if (stryMutAct_9fa48("1490")) {
      {}
    } else {
      stryCov_9fa48("1490");
      const record = this.#sessions.get(tokenHash);
      return (stryMutAct_9fa48("1493") ? record !== undefined : stryMutAct_9fa48("1492") ? false : stryMutAct_9fa48("1491") ? true : (stryCov_9fa48("1491", "1492", "1493"), record === undefined)) ? undefined : stryMutAct_9fa48("1494") ? {} : (stryCov_9fa48("1494"), {
        ...record
      });
    }
  }
  revokeSession(tokenHash: string, revokedAt: string): boolean {
    if (stryMutAct_9fa48("1495")) {
      {}
    } else {
      stryCov_9fa48("1495");
      const record = this.#sessions.get(tokenHash);
      if (stryMutAct_9fa48("1498") ? record === undefined && record.revoked_at !== undefined : stryMutAct_9fa48("1497") ? false : stryMutAct_9fa48("1496") ? true : (stryCov_9fa48("1496", "1497", "1498"), (stryMutAct_9fa48("1500") ? record !== undefined : stryMutAct_9fa48("1499") ? false : (stryCov_9fa48("1499", "1500"), record === undefined)) || (stryMutAct_9fa48("1502") ? record.revoked_at === undefined : stryMutAct_9fa48("1501") ? false : (stryCov_9fa48("1501", "1502"), record.revoked_at !== undefined)))) return stryMutAct_9fa48("1503") ? true : (stryCov_9fa48("1503"), false);
      record.revoked_at = revokedAt;
      return stryMutAct_9fa48("1504") ? false : (stryCov_9fa48("1504"), true);
    }
  }
  createChallenge(record: ChallengeRecord, now: string): void {
    if (stryMutAct_9fa48("1505")) {
      {}
    } else {
      stryCov_9fa48("1505");
      for (const [keyHash, challenge] of this.#challenges) {
        if (stryMutAct_9fa48("1506")) {
          {}
        } else {
          stryCov_9fa48("1506");
          if (stryMutAct_9fa48("1509") ? challenge.consumed_at !== undefined && instant(now) >= instant(challenge.expires_at) : stryMutAct_9fa48("1508") ? false : stryMutAct_9fa48("1507") ? true : (stryCov_9fa48("1507", "1508", "1509"), (stryMutAct_9fa48("1511") ? challenge.consumed_at === undefined : stryMutAct_9fa48("1510") ? false : (stryCov_9fa48("1510", "1511"), challenge.consumed_at !== undefined)) || (stryMutAct_9fa48("1514") ? instant(now) < instant(challenge.expires_at) : stryMutAct_9fa48("1513") ? instant(now) > instant(challenge.expires_at) : stryMutAct_9fa48("1512") ? false : (stryCov_9fa48("1512", "1513", "1514"), instant(now) >= instant(challenge.expires_at))))) {
            if (stryMutAct_9fa48("1515")) {
              {}
            } else {
              stryCov_9fa48("1515");
              this.#challenges.delete(keyHash);
            }
          }
        }
      }
      if (stryMutAct_9fa48("1519") ? this.#challenges.size < MAX_ACTIVE_CHALLENGES : stryMutAct_9fa48("1518") ? this.#challenges.size > MAX_ACTIVE_CHALLENGES : stryMutAct_9fa48("1517") ? false : stryMutAct_9fa48("1516") ? true : (stryCov_9fa48("1516", "1517", "1518", "1519"), this.#challenges.size >= MAX_ACTIVE_CHALLENGES)) throw new AuthError(stryMutAct_9fa48("1520") ? "" : (stryCov_9fa48("1520"), 'rate_limited'), 429);
      if (stryMutAct_9fa48("1522") ? false : stryMutAct_9fa48("1521") ? true : (stryCov_9fa48("1521", "1522"), this.#challenges.has(record.key_hash))) throw new AuthError(stryMutAct_9fa48("1523") ? "" : (stryCov_9fa48("1523"), 'authentication_failed'), 401);
      this.#challenges.set(record.key_hash, stryMutAct_9fa48("1524") ? {} : (stryCov_9fa48("1524"), {
        ...record
      }));
    }
  }
  consumeChallenge(keyHash: string, now: string): ConsumedChallenge | undefined {
    if (stryMutAct_9fa48("1525")) {
      {}
    } else {
      stryCov_9fa48("1525");
      const record = this.#challenges.get(keyHash);
      if (stryMutAct_9fa48("1528") ? record !== undefined : stryMutAct_9fa48("1527") ? false : stryMutAct_9fa48("1526") ? true : (stryCov_9fa48("1526", "1527", "1528"), record === undefined)) return undefined;
      const accepted = stryMutAct_9fa48("1531") ? record.consumed_at === undefined || instant(now) < instant(record.expires_at) : stryMutAct_9fa48("1530") ? false : stryMutAct_9fa48("1529") ? true : (stryCov_9fa48("1529", "1530", "1531"), (stryMutAct_9fa48("1533") ? record.consumed_at !== undefined : stryMutAct_9fa48("1532") ? true : (stryCov_9fa48("1532", "1533"), record.consumed_at === undefined)) && (stryMutAct_9fa48("1536") ? instant(now) >= instant(record.expires_at) : stryMutAct_9fa48("1535") ? instant(now) <= instant(record.expires_at) : stryMutAct_9fa48("1534") ? true : (stryCov_9fa48("1534", "1535", "1536"), instant(now) < instant(record.expires_at))));
      if (stryMutAct_9fa48("1539") ? false : stryMutAct_9fa48("1538") ? true : stryMutAct_9fa48("1537") ? accepted : (stryCov_9fa48("1537", "1538", "1539"), !accepted)) return Object.freeze(stryMutAct_9fa48("1540") ? {} : (stryCov_9fa48("1540"), {
        record: stryMutAct_9fa48("1541") ? {} : (stryCov_9fa48("1541"), {
          ...record
        }),
        accepted: stryMutAct_9fa48("1542") ? true : (stryCov_9fa48("1542"), false)
      }));
      record.consumed_at = now;
      return Object.freeze(stryMutAct_9fa48("1543") ? {} : (stryCov_9fa48("1543"), {
        record: stryMutAct_9fa48("1544") ? {} : (stryCov_9fa48("1544"), {
          ...record
        }),
        accepted: stryMutAct_9fa48("1545") ? false : (stryCov_9fa48("1545"), true)
      }));
    }
  }
  async inspectSessions(): Promise<readonly Readonly<SessionRecord>[]> {
    if (stryMutAct_9fa48("1546")) {
      {}
    } else {
      stryCov_9fa48("1546");
      return (stryMutAct_9fa48("1547") ? [] : (stryCov_9fa48("1547"), [...this.#sessions.values()])).map(stryMutAct_9fa48("1548") ? () => undefined : (stryCov_9fa48("1548"), record => Object.freeze(stryMutAct_9fa48("1549") ? {} : (stryCov_9fa48("1549"), {
        ...record
      }))));
    }
  }
}
const defaultWebAuthn: WebAuthnPort = stryMutAct_9fa48("1550") ? {} : (stryCov_9fa48("1550"), {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
});
export class AuthService {
  readonly #store: InMemoryAuthStore;
  readonly #rpId: string;
  readonly #rpName: string;
  readonly #origin: string;
  readonly #now: () => string;
  readonly #randomBytes: (length: number) => Uint8Array;
  readonly #webauthn: WebAuthnPort;
  readonly #failedAttempts = new Map<string, FailedAttemptState>();
  readonly #audit: AuthAuditEvent[] = stryMutAct_9fa48("1551") ? ["Stryker was here"] : (stryCov_9fa48("1551"), []);
  #dummyPasswordHash: Promise<string> | undefined;
  constructor(options: AuthServiceOptions) {
    if (stryMutAct_9fa48("1552")) {
      {}
    } else {
      stryCov_9fa48("1552");
      this.#store = options.store;
      this.#rpId = requireString(options.rp_id, 253);
      this.#rpName = requireString(options.rp_name, 128);
      this.#origin = requireString(options.origin, 2048);
      this.#now = stryMutAct_9fa48("1553") ? options.now && (() => new Date().toISOString()) : (stryCov_9fa48("1553"), options.now ?? (stryMutAct_9fa48("1554") ? () => undefined : (stryCov_9fa48("1554"), () => new Date().toISOString())));
      this.#randomBytes = stryMutAct_9fa48("1555") ? options.random_bytes && randomBytes : (stryCov_9fa48("1555"), options.random_bytes ?? randomBytes);
      this.#webauthn = stryMutAct_9fa48("1556") ? options.webauthn && defaultWebAuthn : (stryCov_9fa48("1556"), options.webauthn ?? defaultWebAuthn);
      const origin = new URL(this.#origin);
      if (stryMutAct_9fa48("1559") ? origin.protocol !== 'https:' || origin.hostname !== 'localhost' : stryMutAct_9fa48("1558") ? false : stryMutAct_9fa48("1557") ? true : (stryCov_9fa48("1557", "1558", "1559"), (stryMutAct_9fa48("1561") ? origin.protocol === 'https:' : stryMutAct_9fa48("1560") ? true : (stryCov_9fa48("1560", "1561"), origin.protocol !== (stryMutAct_9fa48("1562") ? "" : (stryCov_9fa48("1562"), 'https:')))) && (stryMutAct_9fa48("1564") ? origin.hostname === 'localhost' : stryMutAct_9fa48("1563") ? true : (stryCov_9fa48("1563", "1564"), origin.hostname !== (stryMutAct_9fa48("1565") ? "" : (stryCov_9fa48("1565"), 'localhost')))))) {
        if (stryMutAct_9fa48("1566")) {
          {}
        } else {
          stryCov_9fa48("1566");
          throw new AuthError(stryMutAct_9fa48("1567") ? "" : (stryCov_9fa48("1567"), 'invalid_request'), 400);
        }
      }
    }
  }
  get auditEvents(): readonly AuthAuditEvent[] {
    if (stryMutAct_9fa48("1568")) {
      {}
    } else {
      stryCov_9fa48("1568");
      return Object.freeze(this.#audit.map(stryMutAct_9fa48("1569") ? () => undefined : (stryCov_9fa48("1569"), event => Object.freeze(stryMutAct_9fa48("1570") ? {} : (stryCov_9fa48("1570"), {
        ...event
      })))));
    }
  }
  async registerPasswordUser(input: RegisterPasswordUserInput): Promise<void> {
    if (stryMutAct_9fa48("1571")) {
      {}
    } else {
      stryCov_9fa48("1571");
      const userId = requireString(input.user_id, 128);
      const email = normalizeEmail(input.email);
      const password = requireString(input.password, 128);
      if (stryMutAct_9fa48("1575") ? Buffer.byteLength(password, 'utf8') <= 72 : stryMutAct_9fa48("1574") ? Buffer.byteLength(password, 'utf8') >= 72 : stryMutAct_9fa48("1573") ? false : stryMutAct_9fa48("1572") ? true : (stryCov_9fa48("1572", "1573", "1574", "1575"), Buffer.byteLength(password, stryMutAct_9fa48("1576") ? "" : (stryCov_9fa48("1576"), 'utf8')) > 72)) throw new AuthError(stryMutAct_9fa48("1577") ? "" : (stryCov_9fa48("1577"), 'invalid_request'), 400);
      await this.#store.createUser(stryMutAct_9fa48("1578") ? {} : (stryCov_9fa48("1578"), {
        user_id: userId,
        email,
        password_hash: await bcrypt.hash(password, BCRYPT_COST),
        webauthn_credentials: stryMutAct_9fa48("1579") ? ["Stryker was here"] : (stryCov_9fa48("1579"), [])
      }));
    }
  }
  async login(emailValue: unknown, passwordValue: unknown, clientIdValue: unknown): Promise<AuthSession> {
    if (stryMutAct_9fa48("1580")) {
      {}
    } else {
      stryCov_9fa48("1580");
      const email = normalizeEmail(emailValue);
      const password = requireString(passwordValue, 128);
      if (stryMutAct_9fa48("1584") ? Buffer.byteLength(password, 'utf8') <= 72 : stryMutAct_9fa48("1583") ? Buffer.byteLength(password, 'utf8') >= 72 : stryMutAct_9fa48("1582") ? false : stryMutAct_9fa48("1581") ? true : (stryCov_9fa48("1581", "1582", "1583", "1584"), Buffer.byteLength(password, stryMutAct_9fa48("1585") ? "" : (stryCov_9fa48("1585"), 'utf8')) > 72)) throw new AuthError(stryMutAct_9fa48("1586") ? "" : (stryCov_9fa48("1586"), 'invalid_request'), 400);
      const clientId = requireString(clientIdValue, 256);
      const accountRateKey = sha256(stryMutAct_9fa48("1587") ? `` : (stryCov_9fa48("1587"), `account\u0000${email}`));
      const clientRateKey = sha256(stryMutAct_9fa48("1588") ? `` : (stryCov_9fa48("1588"), `client\u0000${clientId}`));
      const rateKeys = stryMutAct_9fa48("1589") ? [] : (stryCov_9fa48("1589"), [accountRateKey, clientRateKey]);
      const subjectRef = sha256(email);
      const nowMs = instant(this.#now());
      for (const rateKey of rateKeys) {
        if (stryMutAct_9fa48("1590")) {
          {}
        } else {
          stryCov_9fa48("1590");
          const state = this.#failedAttempts.get(rateKey);
          if (stryMutAct_9fa48("1593") ? state?.blocked_until !== undefined || nowMs < instant(state.blocked_until) : stryMutAct_9fa48("1592") ? false : stryMutAct_9fa48("1591") ? true : (stryCov_9fa48("1591", "1592", "1593"), (stryMutAct_9fa48("1595") ? state?.blocked_until === undefined : stryMutAct_9fa48("1594") ? true : (stryCov_9fa48("1594", "1595"), (stryMutAct_9fa48("1596") ? state.blocked_until : (stryCov_9fa48("1596"), state?.blocked_until)) !== undefined)) && (stryMutAct_9fa48("1599") ? nowMs >= instant(state.blocked_until) : stryMutAct_9fa48("1598") ? nowMs <= instant(state.blocked_until) : stryMutAct_9fa48("1597") ? true : (stryCov_9fa48("1597", "1598", "1599"), nowMs < instant(state.blocked_until))))) {
            if (stryMutAct_9fa48("1600")) {
              {}
            } else {
              stryCov_9fa48("1600");
              this.#recordAudit(stryMutAct_9fa48("1601") ? "" : (stryCov_9fa48("1601"), 'login'), stryMutAct_9fa48("1602") ? "" : (stryCov_9fa48("1602"), 'denied'), subjectRef, stryMutAct_9fa48("1603") ? "" : (stryCov_9fa48("1603"), 'rate_limited'));
              throw new AuthError(stryMutAct_9fa48("1604") ? "" : (stryCov_9fa48("1604"), 'rate_limited'), 429);
            }
          }
          if (stryMutAct_9fa48("1607") ? state?.blocked_until === undefined : stryMutAct_9fa48("1606") ? false : stryMutAct_9fa48("1605") ? true : (stryCov_9fa48("1605", "1606", "1607"), (stryMutAct_9fa48("1608") ? state.blocked_until : (stryCov_9fa48("1608"), state?.blocked_until)) !== undefined)) this.#failedAttempts.delete(rateKey);
        }
      }
      const user = await this.#store.findUserByEmail(email);
      stryMutAct_9fa48("1609") ? this.#dummyPasswordHash &&= bcrypt.hash(Buffer.from(this.#randomBytes(32)).toString('base64url'), BCRYPT_COST) : (stryCov_9fa48("1609"), this.#dummyPasswordHash ??= bcrypt.hash(Buffer.from(this.#randomBytes(32)).toString(stryMutAct_9fa48("1610") ? "" : (stryCov_9fa48("1610"), 'base64url')), BCRYPT_COST));
      const valid = await bcrypt.compare(password, stryMutAct_9fa48("1611") ? user?.password_hash && (await this.#dummyPasswordHash) : (stryCov_9fa48("1611"), (stryMutAct_9fa48("1612") ? user.password_hash : (stryCov_9fa48("1612"), user?.password_hash)) ?? (await this.#dummyPasswordHash)));
      if (stryMutAct_9fa48("1615") ? !valid && user === undefined : stryMutAct_9fa48("1614") ? false : stryMutAct_9fa48("1613") ? true : (stryCov_9fa48("1613", "1614", "1615"), (stryMutAct_9fa48("1616") ? valid : (stryCov_9fa48("1616"), !valid)) || (stryMutAct_9fa48("1618") ? user !== undefined : stryMutAct_9fa48("1617") ? false : (stryCov_9fa48("1617", "1618"), user === undefined)))) {
        if (stryMutAct_9fa48("1619")) {
          {}
        } else {
          stryCov_9fa48("1619");
          for (const rateKey of rateKeys) {
            if (stryMutAct_9fa48("1620")) {
              {}
            } else {
              stryCov_9fa48("1620");
              const attempts = stryMutAct_9fa48("1621") ? (this.#failedAttempts.get(rateKey)?.attempts ?? 0) - 1 : (stryCov_9fa48("1621"), (stryMutAct_9fa48("1622") ? this.#failedAttempts.get(rateKey)?.attempts && 0 : (stryCov_9fa48("1622"), (stryMutAct_9fa48("1623") ? this.#failedAttempts.get(rateKey).attempts : (stryCov_9fa48("1623"), this.#failedAttempts.get(rateKey)?.attempts)) ?? 0)) + 1);
              this.#failedAttempts.set(rateKey, stryMutAct_9fa48("1624") ? {} : (stryCov_9fa48("1624"), {
                attempts,
                ...((stryMutAct_9fa48("1628") ? attempts < MAX_FAILED_ATTEMPTS : stryMutAct_9fa48("1627") ? attempts > MAX_FAILED_ATTEMPTS : stryMutAct_9fa48("1626") ? false : stryMutAct_9fa48("1625") ? true : (stryCov_9fa48("1625", "1626", "1627", "1628"), attempts >= MAX_FAILED_ATTEMPTS)) ? stryMutAct_9fa48("1629") ? {} : (stryCov_9fa48("1629"), {
                  blocked_until: new Date(stryMutAct_9fa48("1630") ? nowMs - RATE_LIMIT_MS : (stryCov_9fa48("1630"), nowMs + RATE_LIMIT_MS)).toISOString()
                }) : {})
              }));
            }
          }
          this.#recordAudit(stryMutAct_9fa48("1631") ? "" : (stryCov_9fa48("1631"), 'login'), stryMutAct_9fa48("1632") ? "" : (stryCov_9fa48("1632"), 'denied'), subjectRef, stryMutAct_9fa48("1633") ? "" : (stryCov_9fa48("1633"), 'authentication_failed'));
          throw new AuthError(stryMutAct_9fa48("1634") ? "" : (stryCov_9fa48("1634"), 'authentication_failed'), 401);
        }
      }
      this.#failedAttempts.delete(accountRateKey);
      this.#recordAudit(stryMutAct_9fa48("1635") ? "" : (stryCov_9fa48("1635"), 'login'), stryMutAct_9fa48("1636") ? "" : (stryCov_9fa48("1636"), 'allowed'), sha256(user.user_id), stryMutAct_9fa48("1637") ? "" : (stryCov_9fa48("1637"), 'authenticated'));
      return this.#issueSession(user.user_id);
    }
  }
  authenticate(sessionToken: string | undefined): AuthUserRecord {
    if (stryMutAct_9fa48("1638")) {
      {}
    } else {
      stryCov_9fa48("1638");
      if (stryMutAct_9fa48("1641") ? sessionToken === undefined && sessionToken.length === 0 : stryMutAct_9fa48("1640") ? false : stryMutAct_9fa48("1639") ? true : (stryCov_9fa48("1639", "1640", "1641"), (stryMutAct_9fa48("1643") ? sessionToken !== undefined : stryMutAct_9fa48("1642") ? false : (stryCov_9fa48("1642", "1643"), sessionToken === undefined)) || (stryMutAct_9fa48("1645") ? sessionToken.length !== 0 : stryMutAct_9fa48("1644") ? false : (stryCov_9fa48("1644", "1645"), sessionToken.length === 0)))) {
        if (stryMutAct_9fa48("1646")) {
          {}
        } else {
          stryCov_9fa48("1646");
          this.#recordAudit(stryMutAct_9fa48("1647") ? "" : (stryCov_9fa48("1647"), 'session_check'), stryMutAct_9fa48("1648") ? "" : (stryCov_9fa48("1648"), 'denied'), sha256(stryMutAct_9fa48("1649") ? "" : (stryCov_9fa48("1649"), 'anonymous')), stryMutAct_9fa48("1650") ? "" : (stryCov_9fa48("1650"), 'authentication_required'));
          throw new AuthError(stryMutAct_9fa48("1651") ? "" : (stryCov_9fa48("1651"), 'authentication_required'), 401);
        }
      }
      const session = this.#store.findSession(sha256(sessionToken));
      const user = (stryMutAct_9fa48("1654") ? session !== undefined : stryMutAct_9fa48("1653") ? false : stryMutAct_9fa48("1652") ? true : (stryCov_9fa48("1652", "1653", "1654"), session === undefined)) ? undefined : this.#store.getUser(session.user_id);
      if (stryMutAct_9fa48("1657") ? (session === undefined || session.revoked_at !== undefined || instant(this.#now()) >= instant(session.expires_at)) && user === undefined : stryMutAct_9fa48("1656") ? false : stryMutAct_9fa48("1655") ? true : (stryCov_9fa48("1655", "1656", "1657"), (stryMutAct_9fa48("1659") ? (session === undefined || session.revoked_at !== undefined) && instant(this.#now()) >= instant(session.expires_at) : stryMutAct_9fa48("1658") ? false : (stryCov_9fa48("1658", "1659"), (stryMutAct_9fa48("1661") ? session === undefined && session.revoked_at !== undefined : stryMutAct_9fa48("1660") ? false : (stryCov_9fa48("1660", "1661"), (stryMutAct_9fa48("1663") ? session !== undefined : stryMutAct_9fa48("1662") ? false : (stryCov_9fa48("1662", "1663"), session === undefined)) || (stryMutAct_9fa48("1665") ? session.revoked_at === undefined : stryMutAct_9fa48("1664") ? false : (stryCov_9fa48("1664", "1665"), session.revoked_at !== undefined)))) || (stryMutAct_9fa48("1668") ? instant(this.#now()) < instant(session.expires_at) : stryMutAct_9fa48("1667") ? instant(this.#now()) > instant(session.expires_at) : stryMutAct_9fa48("1666") ? false : (stryCov_9fa48("1666", "1667", "1668"), instant(this.#now()) >= instant(session.expires_at))))) || (stryMutAct_9fa48("1670") ? user !== undefined : stryMutAct_9fa48("1669") ? false : (stryCov_9fa48("1669", "1670"), user === undefined)))) {
        if (stryMutAct_9fa48("1671")) {
          {}
        } else {
          stryCov_9fa48("1671");
          this.#recordAudit(stryMutAct_9fa48("1672") ? "" : (stryCov_9fa48("1672"), 'session_check'), stryMutAct_9fa48("1673") ? "" : (stryCov_9fa48("1673"), 'denied'), sha256(stryMutAct_9fa48("1674") ? "" : (stryCov_9fa48("1674"), 'invalid-session')), stryMutAct_9fa48("1675") ? "" : (stryCov_9fa48("1675"), 'authentication_required'));
          throw new AuthError(stryMutAct_9fa48("1676") ? "" : (stryCov_9fa48("1676"), 'authentication_required'), 401);
        }
      }
      this.#recordAudit(stryMutAct_9fa48("1677") ? "" : (stryCov_9fa48("1677"), 'session_check'), stryMutAct_9fa48("1678") ? "" : (stryCov_9fa48("1678"), 'allowed'), sha256(user.user_id), stryMutAct_9fa48("1679") ? "" : (stryCov_9fa48("1679"), 'authenticated'));
      return user;
    }
  }
  logout(sessionToken: string | undefined): void {
    if (stryMutAct_9fa48("1680")) {
      {}
    } else {
      stryCov_9fa48("1680");
      if (stryMutAct_9fa48("1683") ? sessionToken === undefined && !this.#store.revokeSession(sha256(sessionToken), this.#now()) : stryMutAct_9fa48("1682") ? false : stryMutAct_9fa48("1681") ? true : (stryCov_9fa48("1681", "1682", "1683"), (stryMutAct_9fa48("1685") ? sessionToken !== undefined : stryMutAct_9fa48("1684") ? false : (stryCov_9fa48("1684", "1685"), sessionToken === undefined)) || (stryMutAct_9fa48("1686") ? this.#store.revokeSession(sha256(sessionToken), this.#now()) : (stryCov_9fa48("1686"), !this.#store.revokeSession(sha256(sessionToken), this.#now()))))) {
        if (stryMutAct_9fa48("1687")) {
          {}
        } else {
          stryCov_9fa48("1687");
          this.#recordAudit(stryMutAct_9fa48("1688") ? "" : (stryCov_9fa48("1688"), 'logout'), stryMutAct_9fa48("1689") ? "" : (stryCov_9fa48("1689"), 'denied'), sha256(stryMutAct_9fa48("1690") ? "" : (stryCov_9fa48("1690"), 'invalid-session')), stryMutAct_9fa48("1691") ? "" : (stryCov_9fa48("1691"), 'authentication_required'));
          throw new AuthError(stryMutAct_9fa48("1692") ? "" : (stryCov_9fa48("1692"), 'authentication_required'), 401);
        }
      }
      this.#recordAudit(stryMutAct_9fa48("1693") ? "" : (stryCov_9fa48("1693"), 'logout'), stryMutAct_9fa48("1694") ? "" : (stryCov_9fa48("1694"), 'allowed'), sha256(sessionToken), stryMutAct_9fa48("1695") ? "" : (stryCov_9fa48("1695"), 'session_revoked'));
    }
  }
  async beginWebAuthnRegistration(sessionToken: string | undefined): Promise<WebAuthnCeremony<PublicKeyCredentialCreationOptionsJSON>> {
    if (stryMutAct_9fa48("1696")) {
      {}
    } else {
      stryCov_9fa48("1696");
      const user = this.authenticate(sessionToken);
      const options = await this.#webauthn.generateRegistrationOptions(stryMutAct_9fa48("1697") ? {} : (stryCov_9fa48("1697"), {
        rpName: this.#rpName,
        rpID: this.#rpId,
        userID: new TextEncoder().encode(user.user_id),
        userName: user.email,
        userDisplayName: stryMutAct_9fa48("1698") ? "" : (stryCov_9fa48("1698"), 'Harness user'),
        timeout: CHALLENGE_LIFETIME_MS,
        attestationType: stryMutAct_9fa48("1699") ? "" : (stryCov_9fa48("1699"), 'none'),
        excludeCredentials: user.webauthn_credentials.map(stryMutAct_9fa48("1700") ? () => undefined : (stryCov_9fa48("1700"), credential => stryMutAct_9fa48("1701") ? {} : (stryCov_9fa48("1701"), {
          id: credential.id,
          ...((stryMutAct_9fa48("1704") ? credential.transports !== undefined : stryMutAct_9fa48("1703") ? false : stryMutAct_9fa48("1702") ? true : (stryCov_9fa48("1702", "1703", "1704"), credential.transports === undefined)) ? {} : stryMutAct_9fa48("1705") ? {} : (stryCov_9fa48("1705"), {
            transports: stryMutAct_9fa48("1706") ? [] : (stryCov_9fa48("1706"), [...credential.transports])
          }))
        }))),
        authenticatorSelection: stryMutAct_9fa48("1707") ? {} : (stryCov_9fa48("1707"), {
          residentKey: stryMutAct_9fa48("1708") ? "" : (stryCov_9fa48("1708"), 'preferred'),
          userVerification: stryMutAct_9fa48("1709") ? "" : (stryCov_9fa48("1709"), 'required')
        })
      }));
      const challenge = requireString(options.challenge, 1024);
      const now = this.#now();
      const ceremonyToken = this.#createOpaqueToken();
      this.#store.createChallenge(stryMutAct_9fa48("1710") ? {} : (stryCov_9fa48("1710"), {
        key_hash: sha256(ceremonyToken),
        kind: stryMutAct_9fa48("1711") ? "" : (stryCov_9fa48("1711"), 'registration'),
        user_id: user.user_id,
        challenge,
        expires_at: new Date(stryMutAct_9fa48("1712") ? instant(now) - CHALLENGE_LIFETIME_MS : (stryCov_9fa48("1712"), instant(now) + CHALLENGE_LIFETIME_MS)).toISOString()
      }), now);
      this.#recordAudit(stryMutAct_9fa48("1713") ? "" : (stryCov_9fa48("1713"), 'webauthn_register'), stryMutAct_9fa48("1714") ? "" : (stryCov_9fa48("1714"), 'allowed'), sha256(user.user_id), stryMutAct_9fa48("1715") ? "" : (stryCov_9fa48("1715"), 'challenge_issued'));
      return Object.freeze(stryMutAct_9fa48("1716") ? {} : (stryCov_9fa48("1716"), {
        options: structuredClone(options),
        cookie: this.#ceremonyCookie(ceremonyToken)
      }));
    }
  }
  async beginWebAuthnAuthentication(): Promise<WebAuthnCeremony<PublicKeyCredentialRequestOptionsJSON>> {
    if (stryMutAct_9fa48("1717")) {
      {}
    } else {
      stryCov_9fa48("1717");
      const options = await this.#webauthn.generateAuthenticationOptions(stryMutAct_9fa48("1718") ? {} : (stryCov_9fa48("1718"), {
        rpID: this.#rpId,
        timeout: CHALLENGE_LIFETIME_MS,
        userVerification: stryMutAct_9fa48("1719") ? "" : (stryCov_9fa48("1719"), 'required')
      }));
      const challenge = requireString(options.challenge, 1024);
      const now = this.#now();
      const ceremonyToken = this.#createOpaqueToken();
      this.#store.createChallenge(stryMutAct_9fa48("1720") ? {} : (stryCov_9fa48("1720"), {
        key_hash: sha256(ceremonyToken),
        kind: stryMutAct_9fa48("1721") ? "" : (stryCov_9fa48("1721"), 'authentication'),
        challenge,
        expires_at: new Date(stryMutAct_9fa48("1722") ? instant(now) - CHALLENGE_LIFETIME_MS : (stryCov_9fa48("1722"), instant(now) + CHALLENGE_LIFETIME_MS)).toISOString()
      }), now);
      this.#recordAudit(stryMutAct_9fa48("1723") ? "" : (stryCov_9fa48("1723"), 'webauthn_authenticate'), stryMutAct_9fa48("1724") ? "" : (stryCov_9fa48("1724"), 'allowed'), sha256(stryMutAct_9fa48("1725") ? "" : (stryCov_9fa48("1725"), 'anonymous')), stryMutAct_9fa48("1726") ? "" : (stryCov_9fa48("1726"), 'challenge_issued'));
      return Object.freeze(stryMutAct_9fa48("1727") ? {} : (stryCov_9fa48("1727"), {
        options: structuredClone(options),
        cookie: this.#ceremonyCookie(ceremonyToken)
      }));
    }
  }
  async verifyWebAuthnCeremony(ceremonyToken: string | undefined, response: unknown): Promise<AuthSession> {
    if (stryMutAct_9fa48("1728")) {
      {}
    } else {
      stryCov_9fa48("1728");
      if (stryMutAct_9fa48("1731") ? ceremonyToken !== undefined : stryMutAct_9fa48("1730") ? false : stryMutAct_9fa48("1729") ? true : (stryCov_9fa48("1729", "1730", "1731"), ceremonyToken === undefined)) {
        if (stryMutAct_9fa48("1732")) {
          {}
        } else {
          stryCov_9fa48("1732");
          this.#recordAudit(stryMutAct_9fa48("1733") ? "" : (stryCov_9fa48("1733"), 'webauthn_verify'), stryMutAct_9fa48("1734") ? "" : (stryCov_9fa48("1734"), 'denied'), sha256(stryMutAct_9fa48("1735") ? "" : (stryCov_9fa48("1735"), 'anonymous')), stryMutAct_9fa48("1736") ? "" : (stryCov_9fa48("1736"), 'challenge_invalid'));
          throw new AuthError(stryMutAct_9fa48("1737") ? "" : (stryCov_9fa48("1737"), 'authentication_failed'), 401);
        }
      }
      const consumed = this.#store.consumeChallenge(sha256(ceremonyToken), this.#now());
      if (stryMutAct_9fa48("1740") ? consumed !== undefined : stryMutAct_9fa48("1739") ? false : stryMutAct_9fa48("1738") ? true : (stryCov_9fa48("1738", "1739", "1740"), consumed === undefined)) {
        if (stryMutAct_9fa48("1741")) {
          {}
        } else {
          stryCov_9fa48("1741");
          this.#recordAudit(stryMutAct_9fa48("1742") ? "" : (stryCov_9fa48("1742"), 'webauthn_verify'), stryMutAct_9fa48("1743") ? "" : (stryCov_9fa48("1743"), 'denied'), sha256(stryMutAct_9fa48("1744") ? "" : (stryCov_9fa48("1744"), 'anonymous')), stryMutAct_9fa48("1745") ? "" : (stryCov_9fa48("1745"), 'challenge_invalid'));
          throw new AuthError(stryMutAct_9fa48("1746") ? "" : (stryCov_9fa48("1746"), 'authentication_failed'), 401);
        }
      }
      const failure = (): never => {
        if (stryMutAct_9fa48("1747")) {
          {}
        } else {
          stryCov_9fa48("1747");
          const registration = stryMutAct_9fa48("1750") ? consumed.record.kind !== 'registration' : stryMutAct_9fa48("1749") ? false : stryMutAct_9fa48("1748") ? true : (stryCov_9fa48("1748", "1749", "1750"), consumed.record.kind === (stryMutAct_9fa48("1751") ? "" : (stryCov_9fa48("1751"), 'registration')));
          const subject = (stryMutAct_9fa48("1754") ? consumed.record.user_id !== undefined : stryMutAct_9fa48("1753") ? false : stryMutAct_9fa48("1752") ? true : (stryCov_9fa48("1752", "1753", "1754"), consumed.record.user_id === undefined)) ? stryMutAct_9fa48("1755") ? "" : (stryCov_9fa48("1755"), 'anonymous') : consumed.record.user_id;
          this.#recordAudit(stryMutAct_9fa48("1756") ? "" : (stryCov_9fa48("1756"), 'webauthn_verify'), stryMutAct_9fa48("1757") ? "" : (stryCov_9fa48("1757"), 'denied'), sha256(subject), stryMutAct_9fa48("1758") ? "" : (stryCov_9fa48("1758"), 'verification_failed'));
          throw new AuthError(registration ? stryMutAct_9fa48("1759") ? "" : (stryCov_9fa48("1759"), 'webauthn_verification_failed') : stryMutAct_9fa48("1760") ? "" : (stryCov_9fa48("1760"), 'authentication_failed'), registration ? 400 : 401);
        }
      };
      if (stryMutAct_9fa48("1763") ? (!consumed.accepted || typeof response !== 'object' || response === null) && Array.isArray(response) : stryMutAct_9fa48("1762") ? false : stryMutAct_9fa48("1761") ? true : (stryCov_9fa48("1761", "1762", "1763"), (stryMutAct_9fa48("1765") ? (!consumed.accepted || typeof response !== 'object') && response === null : stryMutAct_9fa48("1764") ? false : (stryCov_9fa48("1764", "1765"), (stryMutAct_9fa48("1767") ? !consumed.accepted && typeof response !== 'object' : stryMutAct_9fa48("1766") ? false : (stryCov_9fa48("1766", "1767"), (stryMutAct_9fa48("1768") ? consumed.accepted : (stryCov_9fa48("1768"), !consumed.accepted)) || (stryMutAct_9fa48("1770") ? typeof response === 'object' : stryMutAct_9fa48("1769") ? false : (stryCov_9fa48("1769", "1770"), typeof response !== (stryMutAct_9fa48("1771") ? "" : (stryCov_9fa48("1771"), 'object')))))) || (stryMutAct_9fa48("1773") ? response !== null : stryMutAct_9fa48("1772") ? false : (stryCov_9fa48("1772", "1773"), response === null)))) || Array.isArray(response))) {
        if (stryMutAct_9fa48("1774")) {
          {}
        } else {
          stryCov_9fa48("1774");
          return failure();
        }
      }
      if (stryMutAct_9fa48("1777") ? consumed.record.kind !== 'registration' : stryMutAct_9fa48("1776") ? false : stryMutAct_9fa48("1775") ? true : (stryCov_9fa48("1775", "1776", "1777"), consumed.record.kind === (stryMutAct_9fa48("1778") ? "" : (stryCov_9fa48("1778"), 'registration')))) {
        if (stryMutAct_9fa48("1779")) {
          {}
        } else {
          stryCov_9fa48("1779");
          return this.#verifyWebAuthnRegistration(consumed.record, response, failure);
        }
      }
      return this.#verifyWebAuthnAuthentication(consumed.record, response, failure);
    }
  }
  async #verifyWebAuthnRegistration(challenge: ChallengeRecord, response: unknown, failure: () => never): Promise<AuthSession> {
    if (stryMutAct_9fa48("1780")) {
      {}
    } else {
      stryCov_9fa48("1780");
      const user = (stryMutAct_9fa48("1783") ? challenge.user_id !== undefined : stryMutAct_9fa48("1782") ? false : stryMutAct_9fa48("1781") ? true : (stryCov_9fa48("1781", "1782", "1783"), challenge.user_id === undefined)) ? undefined : this.#store.getUser(challenge.user_id);
      if (stryMutAct_9fa48("1786") ? user !== undefined : stryMutAct_9fa48("1785") ? false : stryMutAct_9fa48("1784") ? true : (stryCov_9fa48("1784", "1785", "1786"), user === undefined)) return failure();
      let result: VerifiedRegistrationResponse;
      try {
        if (stryMutAct_9fa48("1787")) {
          {}
        } else {
          stryCov_9fa48("1787");
          result = await this.#webauthn.verifyRegistrationResponse(stryMutAct_9fa48("1788") ? {} : (stryCov_9fa48("1788"), {
            response: response as RegistrationResponseJSON,
            expectedChallenge: challenge.challenge,
            expectedOrigin: this.#origin,
            expectedRPID: this.#rpId,
            requireUserPresence: stryMutAct_9fa48("1789") ? false : (stryCov_9fa48("1789"), true),
            requireUserVerification: stryMutAct_9fa48("1790") ? false : (stryCov_9fa48("1790"), true)
          }));
        }
      } catch {
        if (stryMutAct_9fa48("1791")) {
          {}
        } else {
          stryCov_9fa48("1791");
          return failure();
        }
      }
      if (stryMutAct_9fa48("1794") ? (!result.verified || !result.registrationInfo.userVerified || result.registrationInfo.origin !== this.#origin) && result.registrationInfo.rpID !== this.#rpId : stryMutAct_9fa48("1793") ? false : stryMutAct_9fa48("1792") ? true : (stryCov_9fa48("1792", "1793", "1794"), (stryMutAct_9fa48("1796") ? (!result.verified || !result.registrationInfo.userVerified) && result.registrationInfo.origin !== this.#origin : stryMutAct_9fa48("1795") ? false : (stryCov_9fa48("1795", "1796"), (stryMutAct_9fa48("1798") ? !result.verified && !result.registrationInfo.userVerified : stryMutAct_9fa48("1797") ? false : (stryCov_9fa48("1797", "1798"), (stryMutAct_9fa48("1799") ? result.verified : (stryCov_9fa48("1799"), !result.verified)) || (stryMutAct_9fa48("1800") ? result.registrationInfo.userVerified : (stryCov_9fa48("1800"), !result.registrationInfo.userVerified)))) || (stryMutAct_9fa48("1802") ? result.registrationInfo.origin === this.#origin : stryMutAct_9fa48("1801") ? false : (stryCov_9fa48("1801", "1802"), result.registrationInfo.origin !== this.#origin)))) || (stryMutAct_9fa48("1804") ? result.registrationInfo.rpID === this.#rpId : stryMutAct_9fa48("1803") ? false : (stryCov_9fa48("1803", "1804"), result.registrationInfo.rpID !== this.#rpId)))) {
        if (stryMutAct_9fa48("1805")) {
          {}
        } else {
          stryCov_9fa48("1805");
          return failure();
        }
      }
      try {
        if (stryMutAct_9fa48("1806")) {
          {}
        } else {
          stryCov_9fa48("1806");
          await this.#store.addWebAuthnCredential(user.user_id, result.registrationInfo.credential);
        }
      } catch {
        if (stryMutAct_9fa48("1807")) {
          {}
        } else {
          stryCov_9fa48("1807");
          return failure();
        }
      }
      this.#recordAudit(stryMutAct_9fa48("1808") ? "" : (stryCov_9fa48("1808"), 'webauthn_verify'), stryMutAct_9fa48("1809") ? "" : (stryCov_9fa48("1809"), 'allowed'), sha256(user.user_id), stryMutAct_9fa48("1810") ? "" : (stryCov_9fa48("1810"), 'credential_registered'));
      return this.#issueSession(user.user_id);
    }
  }
  async #verifyWebAuthnAuthentication(challenge: ChallengeRecord, response: unknown, failure: () => never): Promise<AuthSession> {
    if (stryMutAct_9fa48("1811")) {
      {}
    } else {
      stryCov_9fa48("1811");
      const credentialId = (response as Record<string, unknown>).id;
      if (stryMutAct_9fa48("1814") ? (typeof credentialId !== 'string' || credentialId.length === 0) && credentialId.length > 1024 : stryMutAct_9fa48("1813") ? false : stryMutAct_9fa48("1812") ? true : (stryCov_9fa48("1812", "1813", "1814"), (stryMutAct_9fa48("1816") ? typeof credentialId !== 'string' && credentialId.length === 0 : stryMutAct_9fa48("1815") ? false : (stryCov_9fa48("1815", "1816"), (stryMutAct_9fa48("1818") ? typeof credentialId === 'string' : stryMutAct_9fa48("1817") ? false : (stryCov_9fa48("1817", "1818"), typeof credentialId !== (stryMutAct_9fa48("1819") ? "" : (stryCov_9fa48("1819"), 'string')))) || (stryMutAct_9fa48("1821") ? credentialId.length !== 0 : stryMutAct_9fa48("1820") ? false : (stryCov_9fa48("1820", "1821"), credentialId.length === 0)))) || (stryMutAct_9fa48("1824") ? credentialId.length <= 1024 : stryMutAct_9fa48("1823") ? credentialId.length >= 1024 : stryMutAct_9fa48("1822") ? false : (stryCov_9fa48("1822", "1823", "1824"), credentialId.length > 1024)))) {
        if (stryMutAct_9fa48("1825")) {
          {}
        } else {
          stryCov_9fa48("1825");
          return failure();
        }
      }
      const match = this.#store.findWebAuthnCredential(credentialId);
      if (stryMutAct_9fa48("1828") ? match !== undefined : stryMutAct_9fa48("1827") ? false : stryMutAct_9fa48("1826") ? true : (stryCov_9fa48("1826", "1827", "1828"), match === undefined)) return failure();
      let result: VerifiedAuthenticationResponse;
      try {
        if (stryMutAct_9fa48("1829")) {
          {}
        } else {
          stryCov_9fa48("1829");
          result = await this.#webauthn.verifyAuthenticationResponse(stryMutAct_9fa48("1830") ? {} : (stryCov_9fa48("1830"), {
            response: response as AuthenticationResponseJSON,
            expectedChallenge: challenge.challenge,
            expectedOrigin: this.#origin,
            expectedRPID: this.#rpId,
            credential: match.credential,
            expectedType: stryMutAct_9fa48("1831") ? "" : (stryCov_9fa48("1831"), 'webauthn.get'),
            requireUserVerification: stryMutAct_9fa48("1832") ? false : (stryCov_9fa48("1832"), true)
          }));
        }
      } catch {
        if (stryMutAct_9fa48("1833")) {
          {}
        } else {
          stryCov_9fa48("1833");
          return failure();
        }
      }
      const info = result.authenticationInfo;
      if (stryMutAct_9fa48("1836") ? (!result.verified || !info.userVerified || info.credentialID !== credentialId || info.origin !== this.#origin || info.rpID !== this.#rpId) && !this.#store.updateWebAuthnCounter(match.user.user_id, credentialId, match.credential.counter, info.newCounter) : stryMutAct_9fa48("1835") ? false : stryMutAct_9fa48("1834") ? true : (stryCov_9fa48("1834", "1835", "1836"), (stryMutAct_9fa48("1838") ? (!result.verified || !info.userVerified || info.credentialID !== credentialId || info.origin !== this.#origin) && info.rpID !== this.#rpId : stryMutAct_9fa48("1837") ? false : (stryCov_9fa48("1837", "1838"), (stryMutAct_9fa48("1840") ? (!result.verified || !info.userVerified || info.credentialID !== credentialId) && info.origin !== this.#origin : stryMutAct_9fa48("1839") ? false : (stryCov_9fa48("1839", "1840"), (stryMutAct_9fa48("1842") ? (!result.verified || !info.userVerified) && info.credentialID !== credentialId : stryMutAct_9fa48("1841") ? false : (stryCov_9fa48("1841", "1842"), (stryMutAct_9fa48("1844") ? !result.verified && !info.userVerified : stryMutAct_9fa48("1843") ? false : (stryCov_9fa48("1843", "1844"), (stryMutAct_9fa48("1845") ? result.verified : (stryCov_9fa48("1845"), !result.verified)) || (stryMutAct_9fa48("1846") ? info.userVerified : (stryCov_9fa48("1846"), !info.userVerified)))) || (stryMutAct_9fa48("1848") ? info.credentialID === credentialId : stryMutAct_9fa48("1847") ? false : (stryCov_9fa48("1847", "1848"), info.credentialID !== credentialId)))) || (stryMutAct_9fa48("1850") ? info.origin === this.#origin : stryMutAct_9fa48("1849") ? false : (stryCov_9fa48("1849", "1850"), info.origin !== this.#origin)))) || (stryMutAct_9fa48("1852") ? info.rpID === this.#rpId : stryMutAct_9fa48("1851") ? false : (stryCov_9fa48("1851", "1852"), info.rpID !== this.#rpId)))) || (stryMutAct_9fa48("1853") ? this.#store.updateWebAuthnCounter(match.user.user_id, credentialId, match.credential.counter, info.newCounter) : (stryCov_9fa48("1853"), !this.#store.updateWebAuthnCounter(match.user.user_id, credentialId, match.credential.counter, info.newCounter))))) {
        if (stryMutAct_9fa48("1854")) {
          {}
        } else {
          stryCov_9fa48("1854");
          return failure();
        }
      }
      this.#recordAudit(stryMutAct_9fa48("1855") ? "" : (stryCov_9fa48("1855"), 'webauthn_verify'), stryMutAct_9fa48("1856") ? "" : (stryCov_9fa48("1856"), 'allowed'), sha256(match.user.user_id), stryMutAct_9fa48("1857") ? "" : (stryCov_9fa48("1857"), 'authenticated'));
      return this.#issueSession(match.user.user_id);
    }
  }
  purgeExpiredAuditEvents(): number {
    if (stryMutAct_9fa48("1858")) {
      {}
    } else {
      stryCov_9fa48("1858");
      const cutoff = stryMutAct_9fa48("1859") ? instant(this.#now()) + AUDIT_RETENTION_MS : (stryCov_9fa48("1859"), instant(this.#now()) - AUDIT_RETENTION_MS);
      const retained = stryMutAct_9fa48("1860") ? this.#audit : (stryCov_9fa48("1860"), this.#audit.filter(stryMutAct_9fa48("1861") ? () => undefined : (stryCov_9fa48("1861"), event => stryMutAct_9fa48("1865") ? instant(event.timestamp) < cutoff : stryMutAct_9fa48("1864") ? instant(event.timestamp) > cutoff : stryMutAct_9fa48("1863") ? false : stryMutAct_9fa48("1862") ? true : (stryCov_9fa48("1862", "1863", "1864", "1865"), instant(event.timestamp) >= cutoff))));
      const removed = stryMutAct_9fa48("1866") ? this.#audit.length + retained.length : (stryCov_9fa48("1866"), this.#audit.length - retained.length);
      this.#audit.splice(0, this.#audit.length, ...retained);
      return removed;
    }
  }
  #issueSession(userId: string): AuthSession {
    if (stryMutAct_9fa48("1867")) {
      {}
    } else {
      stryCov_9fa48("1867");
      const token = this.#createOpaqueToken();
      const now = this.#now();
      this.#store.createSession(stryMutAct_9fa48("1868") ? {} : (stryCov_9fa48("1868"), {
        token_hash: sha256(token),
        user_id: userId,
        issued_at: now,
        expires_at: new Date(stryMutAct_9fa48("1869") ? instant(now) - SESSION_LIFETIME_MS : (stryCov_9fa48("1869"), instant(now) + SESSION_LIFETIME_MS)).toISOString()
      }));
      return stryMutAct_9fa48("1870") ? {} : (stryCov_9fa48("1870"), {
        token,
        user_id: userId,
        cookie: stryMutAct_9fa48("1871") ? `` : (stryCov_9fa48("1871"), `${SESSION_COOKIE}=${token}; Max-Age=86400; Path=/; HttpOnly; Secure; SameSite=Strict`)
      });
    }
  }
  #createOpaqueToken(): string {
    if (stryMutAct_9fa48("1872")) {
      {}
    } else {
      stryCov_9fa48("1872");
      const bytes = this.#randomBytes(32);
      if (stryMutAct_9fa48("1875") ? !(bytes instanceof Uint8Array) && bytes.byteLength !== 32 : stryMutAct_9fa48("1874") ? false : stryMutAct_9fa48("1873") ? true : (stryCov_9fa48("1873", "1874", "1875"), (stryMutAct_9fa48("1876") ? bytes instanceof Uint8Array : (stryCov_9fa48("1876"), !(bytes instanceof Uint8Array))) || (stryMutAct_9fa48("1878") ? bytes.byteLength === 32 : stryMutAct_9fa48("1877") ? false : (stryCov_9fa48("1877", "1878"), bytes.byteLength !== 32)))) {
        if (stryMutAct_9fa48("1879")) {
          {}
        } else {
          stryCov_9fa48("1879");
          throw new AuthError(stryMutAct_9fa48("1880") ? "" : (stryCov_9fa48("1880"), 'authentication_failed'), 401);
        }
      }
      return Buffer.from(bytes).toString(stryMutAct_9fa48("1881") ? "" : (stryCov_9fa48("1881"), 'base64url'));
    }
  }
  #ceremonyCookie(token: string): string {
    if (stryMutAct_9fa48("1882")) {
      {}
    } else {
      stryCov_9fa48("1882");
      return stryMutAct_9fa48("1883") ? `` : (stryCov_9fa48("1883"), `${WEBAUTHN_COOKIE}=${token}; Max-Age=300; Path=/; HttpOnly; Secure; SameSite=Strict`);
    }
  }
  #recordAudit(action: AuthAuditEvent['action'], outcome: AuthAuditEvent['outcome'], subjectRef: string, reasonCode: string): void {
    if (stryMutAct_9fa48("1884")) {
      {}
    } else {
      stryCov_9fa48("1884");
      this.#audit.push(Object.freeze(stryMutAct_9fa48("1885") ? {} : (stryCov_9fa48("1885"), {
        timestamp: this.#now(),
        action,
        outcome,
        subject_ref: subjectRef,
        reason_code: reasonCode
      })));
    }
  }
}
export class AuthApi {
  readonly #service: AuthService;
  constructor(service: AuthService) {
    if (stryMutAct_9fa48("1886")) {
      {}
    } else {
      stryCov_9fa48("1886");
      this.#service = service;
    }
  }
  async handle(request: AuthApiRequest): Promise<AuthApiResponse> {
    if (stryMutAct_9fa48("1887")) {
      {}
    } else {
      stryCov_9fa48("1887");
      try {
        if (stryMutAct_9fa48("1888")) {
          {}
        } else {
          stryCov_9fa48("1888");
          if (stryMutAct_9fa48("1891") ? request.method === 'POST' || request.path === '/auth/login' : stryMutAct_9fa48("1890") ? false : stryMutAct_9fa48("1889") ? true : (stryCov_9fa48("1889", "1890", "1891"), (stryMutAct_9fa48("1893") ? request.method !== 'POST' : stryMutAct_9fa48("1892") ? true : (stryCov_9fa48("1892", "1893"), request.method === (stryMutAct_9fa48("1894") ? "" : (stryCov_9fa48("1894"), 'POST')))) && (stryMutAct_9fa48("1896") ? request.path !== '/auth/login' : stryMutAct_9fa48("1895") ? true : (stryCov_9fa48("1895", "1896"), request.path === (stryMutAct_9fa48("1897") ? "" : (stryCov_9fa48("1897"), '/auth/login')))))) {
            if (stryMutAct_9fa48("1898")) {
              {}
            } else {
              stryCov_9fa48("1898");
              if (stryMutAct_9fa48("1901") ? (typeof request.body !== 'object' || request.body === null) && Array.isArray(request.body) : stryMutAct_9fa48("1900") ? false : stryMutAct_9fa48("1899") ? true : (stryCov_9fa48("1899", "1900", "1901"), (stryMutAct_9fa48("1903") ? typeof request.body !== 'object' && request.body === null : stryMutAct_9fa48("1902") ? false : (stryCov_9fa48("1902", "1903"), (stryMutAct_9fa48("1905") ? typeof request.body === 'object' : stryMutAct_9fa48("1904") ? false : (stryCov_9fa48("1904", "1905"), typeof request.body !== (stryMutAct_9fa48("1906") ? "" : (stryCov_9fa48("1906"), 'object')))) || (stryMutAct_9fa48("1908") ? request.body !== null : stryMutAct_9fa48("1907") ? false : (stryCov_9fa48("1907", "1908"), request.body === null)))) || Array.isArray(request.body))) {
                if (stryMutAct_9fa48("1909")) {
                  {}
                } else {
                  stryCov_9fa48("1909");
                  throw new AuthError(stryMutAct_9fa48("1910") ? "" : (stryCov_9fa48("1910"), 'invalid_request'), 400);
                }
              }
              const body = request.body as Record<string, unknown>;
              let session: AuthSession;
              if (stryMutAct_9fa48("1913") ? body.method !== 'password' : stryMutAct_9fa48("1912") ? false : stryMutAct_9fa48("1911") ? true : (stryCov_9fa48("1911", "1912", "1913"), body.method === (stryMutAct_9fa48("1914") ? "" : (stryCov_9fa48("1914"), 'password')))) {
                if (stryMutAct_9fa48("1915")) {
                  {}
                } else {
                  stryCov_9fa48("1915");
                  session = await this.#service.login(body.email, body.password, request.client_id);
                }
              } else if (stryMutAct_9fa48("1918") ? body.method !== 'webauthn' : stryMutAct_9fa48("1917") ? false : stryMutAct_9fa48("1916") ? true : (stryCov_9fa48("1916", "1917", "1918"), body.method === (stryMutAct_9fa48("1919") ? "" : (stryCov_9fa48("1919"), 'webauthn')))) {
                if (stryMutAct_9fa48("1920")) {
                  {}
                } else {
                  stryCov_9fa48("1920");
                  session = await this.#service.verifyWebAuthnCeremony(parseWebAuthnCookie(request.cookie), body.webauthn_assertion);
                }
              } else {
                if (stryMutAct_9fa48("1921")) {
                  {}
                } else {
                  stryCov_9fa48("1921");
                  throw new AuthError(stryMutAct_9fa48("1922") ? "" : (stryCov_9fa48("1922"), 'invalid_request'), 400);
                }
              }
              return this.#response(200, stryMutAct_9fa48("1923") ? {} : (stryCov_9fa48("1923"), {
                authenticated: stryMutAct_9fa48("1924") ? false : (stryCov_9fa48("1924"), true)
              }), stryMutAct_9fa48("1925") ? {} : (stryCov_9fa48("1925"), {
                'set-cookie': session.cookie
              }));
            }
          }
          if (stryMutAct_9fa48("1928") ? request.method === 'GET' || request.path === '/auth/me' : stryMutAct_9fa48("1927") ? false : stryMutAct_9fa48("1926") ? true : (stryCov_9fa48("1926", "1927", "1928"), (stryMutAct_9fa48("1930") ? request.method !== 'GET' : stryMutAct_9fa48("1929") ? true : (stryCov_9fa48("1929", "1930"), request.method === (stryMutAct_9fa48("1931") ? "" : (stryCov_9fa48("1931"), 'GET')))) && (stryMutAct_9fa48("1933") ? request.path !== '/auth/me' : stryMutAct_9fa48("1932") ? true : (stryCov_9fa48("1932", "1933"), request.path === (stryMutAct_9fa48("1934") ? "" : (stryCov_9fa48("1934"), '/auth/me')))))) {
            if (stryMutAct_9fa48("1935")) {
              {}
            } else {
              stryCov_9fa48("1935");
              const user = this.#service.authenticate(parseSessionCookie(request.cookie));
              return this.#response(200, stryMutAct_9fa48("1936") ? {} : (stryCov_9fa48("1936"), {
                user_id: user.user_id
              }));
            }
          }
          if (stryMutAct_9fa48("1939") ? request.method === 'POST' || request.path === '/auth/logout' : stryMutAct_9fa48("1938") ? false : stryMutAct_9fa48("1937") ? true : (stryCov_9fa48("1937", "1938", "1939"), (stryMutAct_9fa48("1941") ? request.method !== 'POST' : stryMutAct_9fa48("1940") ? true : (stryCov_9fa48("1940", "1941"), request.method === (stryMutAct_9fa48("1942") ? "" : (stryCov_9fa48("1942"), 'POST')))) && (stryMutAct_9fa48("1944") ? request.path !== '/auth/logout' : stryMutAct_9fa48("1943") ? true : (stryCov_9fa48("1943", "1944"), request.path === (stryMutAct_9fa48("1945") ? "" : (stryCov_9fa48("1945"), '/auth/logout')))))) {
            if (stryMutAct_9fa48("1946")) {
              {}
            } else {
              stryCov_9fa48("1946");
              this.#service.logout(parseSessionCookie(request.cookie));
              return this.#response(200, stryMutAct_9fa48("1947") ? {} : (stryCov_9fa48("1947"), {
                authenticated: stryMutAct_9fa48("1948") ? true : (stryCov_9fa48("1948"), false)
              }), stryMutAct_9fa48("1949") ? {} : (stryCov_9fa48("1949"), {
                'set-cookie': stryMutAct_9fa48("1950") ? `` : (stryCov_9fa48("1950"), `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`)
              }));
            }
          }
          if (stryMutAct_9fa48("1953") ? request.method === 'POST' || request.path === '/auth/webauthn/register' : stryMutAct_9fa48("1952") ? false : stryMutAct_9fa48("1951") ? true : (stryCov_9fa48("1951", "1952", "1953"), (stryMutAct_9fa48("1955") ? request.method !== 'POST' : stryMutAct_9fa48("1954") ? true : (stryCov_9fa48("1954", "1955"), request.method === (stryMutAct_9fa48("1956") ? "" : (stryCov_9fa48("1956"), 'POST')))) && (stryMutAct_9fa48("1958") ? request.path !== '/auth/webauthn/register' : stryMutAct_9fa48("1957") ? true : (stryCov_9fa48("1957", "1958"), request.path === (stryMutAct_9fa48("1959") ? "" : (stryCov_9fa48("1959"), '/auth/webauthn/register')))))) {
            if (stryMutAct_9fa48("1960")) {
              {}
            } else {
              stryCov_9fa48("1960");
              const ceremony = await this.#service.beginWebAuthnRegistration(parseSessionCookie(request.cookie));
              return this.#response(200, ceremony.options, stryMutAct_9fa48("1961") ? {} : (stryCov_9fa48("1961"), {
                'set-cookie': ceremony.cookie
              }));
            }
          }
          if (stryMutAct_9fa48("1964") ? request.method === 'POST' || request.path === '/auth/webauthn/authenticate' : stryMutAct_9fa48("1963") ? false : stryMutAct_9fa48("1962") ? true : (stryCov_9fa48("1962", "1963", "1964"), (stryMutAct_9fa48("1966") ? request.method !== 'POST' : stryMutAct_9fa48("1965") ? true : (stryCov_9fa48("1965", "1966"), request.method === (stryMutAct_9fa48("1967") ? "" : (stryCov_9fa48("1967"), 'POST')))) && (stryMutAct_9fa48("1969") ? request.path !== '/auth/webauthn/authenticate' : stryMutAct_9fa48("1968") ? true : (stryCov_9fa48("1968", "1969"), request.path === (stryMutAct_9fa48("1970") ? "" : (stryCov_9fa48("1970"), '/auth/webauthn/authenticate')))))) {
            if (stryMutAct_9fa48("1971")) {
              {}
            } else {
              stryCov_9fa48("1971");
              const ceremony = await this.#service.beginWebAuthnAuthentication();
              return this.#response(200, ceremony.options, stryMutAct_9fa48("1972") ? {} : (stryCov_9fa48("1972"), {
                'set-cookie': ceremony.cookie
              }));
            }
          }
          if (stryMutAct_9fa48("1975") ? request.method === 'POST' || request.path === '/auth/webauthn/verify' : stryMutAct_9fa48("1974") ? false : stryMutAct_9fa48("1973") ? true : (stryCov_9fa48("1973", "1974", "1975"), (stryMutAct_9fa48("1977") ? request.method !== 'POST' : stryMutAct_9fa48("1976") ? true : (stryCov_9fa48("1976", "1977"), request.method === (stryMutAct_9fa48("1978") ? "" : (stryCov_9fa48("1978"), 'POST')))) && (stryMutAct_9fa48("1980") ? request.path !== '/auth/webauthn/verify' : stryMutAct_9fa48("1979") ? true : (stryCov_9fa48("1979", "1980"), request.path === (stryMutAct_9fa48("1981") ? "" : (stryCov_9fa48("1981"), '/auth/webauthn/verify')))))) {
            if (stryMutAct_9fa48("1982")) {
              {}
            } else {
              stryCov_9fa48("1982");
              const body = (stryMutAct_9fa48("1985") ? typeof request.body === 'object' && request.body !== null || !Array.isArray(request.body) : stryMutAct_9fa48("1984") ? false : stryMutAct_9fa48("1983") ? true : (stryCov_9fa48("1983", "1984", "1985"), (stryMutAct_9fa48("1987") ? typeof request.body === 'object' || request.body !== null : stryMutAct_9fa48("1986") ? true : (stryCov_9fa48("1986", "1987"), (stryMutAct_9fa48("1989") ? typeof request.body !== 'object' : stryMutAct_9fa48("1988") ? true : (stryCov_9fa48("1988", "1989"), typeof request.body === (stryMutAct_9fa48("1990") ? "" : (stryCov_9fa48("1990"), 'object')))) && (stryMutAct_9fa48("1992") ? request.body === null : stryMutAct_9fa48("1991") ? true : (stryCov_9fa48("1991", "1992"), request.body !== null)))) && (stryMutAct_9fa48("1993") ? Array.isArray(request.body) : (stryCov_9fa48("1993"), !Array.isArray(request.body))))) ? request.body as Record<string, unknown> : undefined;
              const session = await this.#service.verifyWebAuthnCeremony(parseWebAuthnCookie(request.cookie), stryMutAct_9fa48("1994") ? body.credential : (stryCov_9fa48("1994"), body?.credential));
              return this.#response(200, stryMutAct_9fa48("1995") ? {} : (stryCov_9fa48("1995"), {
                authenticated: stryMutAct_9fa48("1996") ? false : (stryCov_9fa48("1996"), true)
              }), stryMutAct_9fa48("1997") ? {} : (stryCov_9fa48("1997"), {
                'set-cookie': session.cookie
              }));
            }
          }
          return this.#response(404, stryMutAct_9fa48("1998") ? {} : (stryCov_9fa48("1998"), {
            error: stryMutAct_9fa48("1999") ? "" : (stryCov_9fa48("1999"), 'not_found')
          }));
        }
      } catch (error) {
        if (stryMutAct_9fa48("2000")) {
          {}
        } else {
          stryCov_9fa48("2000");
          if (stryMutAct_9fa48("2002") ? false : stryMutAct_9fa48("2001") ? true : (stryCov_9fa48("2001", "2002"), error instanceof AuthError)) return this.#response(error.status, stryMutAct_9fa48("2003") ? {} : (stryCov_9fa48("2003"), {
            error: error.code
          }));
          return this.#response(400, stryMutAct_9fa48("2004") ? {} : (stryCov_9fa48("2004"), {
            error: stryMutAct_9fa48("2005") ? "" : (stryCov_9fa48("2005"), 'invalid_request')
          }));
        }
      }
    }
  }
  #response(status: number, body: unknown, headers: Record<string, string> = {}): AuthApiResponse {
    if (stryMutAct_9fa48("2006")) {
      {}
    } else {
      stryCov_9fa48("2006");
      return Object.freeze(stryMutAct_9fa48("2007") ? {} : (stryCov_9fa48("2007"), {
        status,
        headers: Object.freeze(stryMutAct_9fa48("2008") ? {} : (stryCov_9fa48("2008"), {
          ...headers
        })),
        body: structuredClone(body)
      }));
    }
  }
}