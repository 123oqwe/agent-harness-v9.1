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
import { createHash, sign, verify, type KeyObject } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import type { CapabilityToken } from '../../spec/types/capability-token.js';
export type CapabilityStatus = 'issued' | 'used' | 'revoked';
export interface SignedCapabilityToken {
  readonly algorithm: 'Ed25519';
  readonly claims: CapabilityToken;
  readonly signature: string;
}
export interface CapabilityStateRecord {
  readonly token_hash: string;
  readonly signature: string;
  readonly status: CapabilityStatus;
}
export interface CapabilityStateStore {
  register(tokenId: string, record: CapabilityStateRecord): Promise<void>;
  read(tokenId: string): Promise<CapabilityStateRecord | undefined>;
  consume(tokenId: string, tokenHash: string): Promise<'consumed' | 'used' | 'revoked' | 'missing' | 'mismatch'>;
  revoke(tokenId: string): Promise<boolean>;
}
export class CapabilityError extends Error {
  constructor(message: string) {
    if (stryMutAct_9fa48("2708")) {
      {}
    } else {
      stryCov_9fa48("2708");
      super(message);
      this.name = new.target.name;
    }
  }
}
export class CapabilityInvalidError extends CapabilityError {}
export class CapabilityExpiredError extends CapabilityError {}
export class CapabilityNotYetValidError extends CapabilityError {}
export class CapabilityUsedError extends CapabilityError {}
export class CapabilityRevokedError extends CapabilityError {}
export class CapabilityDelegationError extends CapabilityError {}
export class CredentialDispatchError extends CapabilityError {
  readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    if (stryMutAct_9fa48("2709")) {
      {}
    } else {
      stryCov_9fa48("2709");
      super(message);
      this.cause = cause;
    }
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  if (stryMutAct_9fa48("2710")) {
    {}
  } else {
    stryCov_9fa48("2710");
    return stryMutAct_9fa48("2713") ? typeof value === 'object' && value !== null || !Array.isArray(value) : stryMutAct_9fa48("2712") ? false : stryMutAct_9fa48("2711") ? true : (stryCov_9fa48("2711", "2712", "2713"), (stryMutAct_9fa48("2715") ? typeof value === 'object' || value !== null : stryMutAct_9fa48("2714") ? true : (stryCov_9fa48("2714", "2715"), (stryMutAct_9fa48("2717") ? typeof value !== 'object' : stryMutAct_9fa48("2716") ? true : (stryCov_9fa48("2716", "2717"), typeof value === (stryMutAct_9fa48("2718") ? "" : (stryCov_9fa48("2718"), 'object')))) && (stryMutAct_9fa48("2720") ? value === null : stryMutAct_9fa48("2719") ? true : (stryCov_9fa48("2719", "2720"), value !== null)))) && (stryMutAct_9fa48("2721") ? Array.isArray(value) : (stryCov_9fa48("2721"), !Array.isArray(value))));
  }
}
export function canonicalizeCapabilityValue(value: unknown): unknown {
  if (stryMutAct_9fa48("2722")) {
    {}
  } else {
    stryCov_9fa48("2722");
    if (stryMutAct_9fa48("2724") ? false : stryMutAct_9fa48("2723") ? true : (stryCov_9fa48("2723", "2724"), Array.isArray(value))) return value.map(canonicalizeCapabilityValue);
    if (stryMutAct_9fa48("2727") ? false : stryMutAct_9fa48("2726") ? true : stryMutAct_9fa48("2725") ? isRecord(value) : (stryCov_9fa48("2725", "2726", "2727"), !isRecord(value))) return value;
    return Object.fromEntries(stryMutAct_9fa48("2728") ? Object.keys(value).map(key => [key, canonicalizeCapabilityValue(value[key])]) : (stryCov_9fa48("2728"), Object.keys(value).sort().map(stryMutAct_9fa48("2729") ? () => undefined : (stryCov_9fa48("2729"), key => stryMutAct_9fa48("2730") ? [] : (stryCov_9fa48("2730"), [key, canonicalizeCapabilityValue(value[key])])))));
  }
}
export function hashCapabilityValue(value: unknown): string {
  if (stryMutAct_9fa48("2731")) {
    {}
  } else {
    stryCov_9fa48("2731");
    return createHash(stryMutAct_9fa48("2732") ? "" : (stryCov_9fa48("2732"), 'sha256')).update(JSON.stringify(canonicalizeCapabilityValue(value))).digest(stryMutAct_9fa48("2733") ? "" : (stryCov_9fa48("2733"), 'hex'));
  }
}
export function signCapabilityClaims(claims: CapabilityToken, privateKey: KeyObject): string {
  if (stryMutAct_9fa48("2734")) {
    {}
  } else {
    stryCov_9fa48("2734");
    return sign(null, Buffer.from(JSON.stringify(canonicalizeCapabilityValue(claims))), privateKey).toString(stryMutAct_9fa48("2735") ? "" : (stryCov_9fa48("2735"), 'base64url'));
  }
}
export function verifyCapabilityClaims(claims: CapabilityToken, signature: string, publicKey: KeyObject): boolean {
  if (stryMutAct_9fa48("2736")) {
    {}
  } else {
    stryCov_9fa48("2736");
    if (stryMutAct_9fa48("2739") ? false : stryMutAct_9fa48("2738") ? true : stryMutAct_9fa48("2737") ? /^[A-Za-z0-9_-]+$/u.test(signature) : (stryCov_9fa48("2737", "2738", "2739"), !(stryMutAct_9fa48("2743") ? /^[^A-Za-z0-9_-]+$/u : stryMutAct_9fa48("2742") ? /^[A-Za-z0-9_-]$/u : stryMutAct_9fa48("2741") ? /^[A-Za-z0-9_-]+/u : stryMutAct_9fa48("2740") ? /[A-Za-z0-9_-]+$/u : (stryCov_9fa48("2740", "2741", "2742", "2743"), /^[A-Za-z0-9_-]+$/u)).test(signature))) return stryMutAct_9fa48("2744") ? true : (stryCov_9fa48("2744"), false);
    try {
      if (stryMutAct_9fa48("2745")) {
        {}
      } else {
        stryCov_9fa48("2745");
        return verify(null, Buffer.from(JSON.stringify(canonicalizeCapabilityValue(claims))), publicKey, Buffer.from(signature, stryMutAct_9fa48("2746") ? "" : (stryCov_9fa48("2746"), 'base64url')));
      }
    } catch {
      if (stryMutAct_9fa48("2747")) {
        {}
      } else {
        stryCov_9fa48("2747");
        return stryMutAct_9fa48("2748") ? true : (stryCov_9fa48("2748"), false);
      }
    }
  }
}
function cloneRecord(record: CapabilityStateRecord): CapabilityStateRecord {
  if (stryMutAct_9fa48("2749")) {
    {}
  } else {
    stryCov_9fa48("2749");
    return Object.freeze(stryMutAct_9fa48("2750") ? {} : (stryCov_9fa48("2750"), {
      ...record
    }));
  }
}
class SerialExecutor {
  #tail: Promise<void> = Promise.resolve();
  async run<T>(operation: () => Promise<T> | T): Promise<T> {
    if (stryMutAct_9fa48("2751")) {
      {}
    } else {
      stryCov_9fa48("2751");
      let release!: () => void;
      const previous = this.#tail;
      this.#tail = new Promise<void>(resolve => {
        if (stryMutAct_9fa48("2752")) {
          {}
        } else {
          stryCov_9fa48("2752");
          release = resolve;
        }
      });
      await previous;
      try {
        if (stryMutAct_9fa48("2753")) {
          {}
        } else {
          stryCov_9fa48("2753");
          return await operation();
        }
      } finally {
        if (stryMutAct_9fa48("2754")) {
          {}
        } else {
          stryCov_9fa48("2754");
          release();
        }
      }
    }
  }
}
export class InMemoryCapabilityStateStore implements CapabilityStateStore {
  readonly #records = new Map<string, CapabilityStateRecord>();
  readonly #serial = new SerialExecutor();
  async register(tokenId: string, record: CapabilityStateRecord): Promise<void> {
    if (stryMutAct_9fa48("2755")) {
      {}
    } else {
      stryCov_9fa48("2755");
      await this.#serial.run(() => {
        if (stryMutAct_9fa48("2756")) {
          {}
        } else {
          stryCov_9fa48("2756");
          if (stryMutAct_9fa48("2758") ? false : stryMutAct_9fa48("2757") ? true : (stryCov_9fa48("2757", "2758"), this.#records.has(tokenId))) throw new CapabilityInvalidError(stryMutAct_9fa48("2759") ? "" : (stryCov_9fa48("2759"), 'duplicate capability token id'));
          this.#records.set(tokenId, cloneRecord(record));
        }
      });
    }
  }
  async read(tokenId: string): Promise<CapabilityStateRecord | undefined> {
    if (stryMutAct_9fa48("2760")) {
      {}
    } else {
      stryCov_9fa48("2760");
      return this.#serial.run(() => {
        if (stryMutAct_9fa48("2761")) {
          {}
        } else {
          stryCov_9fa48("2761");
          const record = this.#records.get(tokenId);
          return (stryMutAct_9fa48("2764") ? record !== undefined : stryMutAct_9fa48("2763") ? false : stryMutAct_9fa48("2762") ? true : (stryCov_9fa48("2762", "2763", "2764"), record === undefined)) ? undefined : cloneRecord(record);
        }
      });
    }
  }
  async consume(tokenId: string, tokenHash: string): Promise<'consumed' | 'used' | 'revoked' | 'missing' | 'mismatch'> {
    if (stryMutAct_9fa48("2765")) {
      {}
    } else {
      stryCov_9fa48("2765");
      return this.#serial.run(() => {
        if (stryMutAct_9fa48("2766")) {
          {}
        } else {
          stryCov_9fa48("2766");
          const record = this.#records.get(tokenId);
          if (stryMutAct_9fa48("2769") ? record !== undefined : stryMutAct_9fa48("2768") ? false : stryMutAct_9fa48("2767") ? true : (stryCov_9fa48("2767", "2768", "2769"), record === undefined)) return stryMutAct_9fa48("2770") ? "" : (stryCov_9fa48("2770"), 'missing');
          if (stryMutAct_9fa48("2773") ? record.token_hash === tokenHash : stryMutAct_9fa48("2772") ? false : stryMutAct_9fa48("2771") ? true : (stryCov_9fa48("2771", "2772", "2773"), record.token_hash !== tokenHash)) return stryMutAct_9fa48("2774") ? "" : (stryCov_9fa48("2774"), 'mismatch');
          if (stryMutAct_9fa48("2777") ? record.status !== 'used' : stryMutAct_9fa48("2776") ? false : stryMutAct_9fa48("2775") ? true : (stryCov_9fa48("2775", "2776", "2777"), record.status === (stryMutAct_9fa48("2778") ? "" : (stryCov_9fa48("2778"), 'used')))) return stryMutAct_9fa48("2779") ? "" : (stryCov_9fa48("2779"), 'used');
          if (stryMutAct_9fa48("2782") ? record.status !== 'revoked' : stryMutAct_9fa48("2781") ? false : stryMutAct_9fa48("2780") ? true : (stryCov_9fa48("2780", "2781", "2782"), record.status === (stryMutAct_9fa48("2783") ? "" : (stryCov_9fa48("2783"), 'revoked')))) return stryMutAct_9fa48("2784") ? "" : (stryCov_9fa48("2784"), 'revoked');
          this.#records.set(tokenId, cloneRecord(stryMutAct_9fa48("2785") ? {} : (stryCov_9fa48("2785"), {
            ...record,
            status: stryMutAct_9fa48("2786") ? "" : (stryCov_9fa48("2786"), 'used')
          })));
          return stryMutAct_9fa48("2787") ? "" : (stryCov_9fa48("2787"), 'consumed');
        }
      });
    }
  }
  async revoke(tokenId: string): Promise<boolean> {
    if (stryMutAct_9fa48("2788")) {
      {}
    } else {
      stryCov_9fa48("2788");
      return this.#serial.run(() => {
        if (stryMutAct_9fa48("2789")) {
          {}
        } else {
          stryCov_9fa48("2789");
          const record = this.#records.get(tokenId);
          if (stryMutAct_9fa48("2792") ? record === undefined && record.status === 'revoked' : stryMutAct_9fa48("2791") ? false : stryMutAct_9fa48("2790") ? true : (stryCov_9fa48("2790", "2791", "2792"), (stryMutAct_9fa48("2794") ? record !== undefined : stryMutAct_9fa48("2793") ? false : (stryCov_9fa48("2793", "2794"), record === undefined)) || (stryMutAct_9fa48("2796") ? record.status !== 'revoked' : stryMutAct_9fa48("2795") ? false : (stryCov_9fa48("2795", "2796"), record.status === (stryMutAct_9fa48("2797") ? "" : (stryCov_9fa48("2797"), 'revoked')))))) return stryMutAct_9fa48("2798") ? true : (stryCov_9fa48("2798"), false);
          this.#records.set(tokenId, cloneRecord(stryMutAct_9fa48("2799") ? {} : (stryCov_9fa48("2799"), {
            ...record,
            status: stryMutAct_9fa48("2800") ? "" : (stryCov_9fa48("2800"), 'revoked')
          })));
          return stryMutAct_9fa48("2801") ? false : (stryCov_9fa48("2801"), true);
        }
      });
    }
  }
}
interface PersistedCapabilityState {
  version: 1;
  records: Record<string, CapabilityStateRecord>;
}
function validateStateRecord(value: unknown): asserts value is CapabilityStateRecord {
  if (stryMutAct_9fa48("2802")) {
    {}
  } else {
    stryCov_9fa48("2802");
    if (stryMutAct_9fa48("2805") ? false : stryMutAct_9fa48("2804") ? true : stryMutAct_9fa48("2803") ? isRecord(value) : (stryCov_9fa48("2803", "2804", "2805"), !isRecord(value))) throw new CapabilityInvalidError(stryMutAct_9fa48("2806") ? "" : (stryCov_9fa48("2806"), 'invalid capability state record'));
    const keys = stryMutAct_9fa48("2807") ? Object.keys(value) : (stryCov_9fa48("2807"), Object.keys(value).sort());
    if (stryMutAct_9fa48("2810") ? keys.join(',') === 'signature,status,token_hash' : stryMutAct_9fa48("2809") ? false : stryMutAct_9fa48("2808") ? true : (stryCov_9fa48("2808", "2809", "2810"), keys.join(stryMutAct_9fa48("2811") ? "" : (stryCov_9fa48("2811"), ',')) !== (stryMutAct_9fa48("2812") ? "" : (stryCov_9fa48("2812"), 'signature,status,token_hash')))) {
      if (stryMutAct_9fa48("2813")) {
        {}
      } else {
        stryCov_9fa48("2813");
        throw new CapabilityInvalidError(stryMutAct_9fa48("2814") ? "" : (stryCov_9fa48("2814"), 'invalid capability state record fields'));
      }
    }
    if (stryMutAct_9fa48("2817") ? false : stryMutAct_9fa48("2816") ? true : stryMutAct_9fa48("2815") ? /^[0-9a-f]{64}$/u.test(String(value.token_hash)) : (stryCov_9fa48("2815", "2816", "2817"), !(stryMutAct_9fa48("2821") ? /^[^0-9a-f]{64}$/u : stryMutAct_9fa48("2820") ? /^[0-9a-f]$/u : stryMutAct_9fa48("2819") ? /^[0-9a-f]{64}/u : stryMutAct_9fa48("2818") ? /[0-9a-f]{64}$/u : (stryCov_9fa48("2818", "2819", "2820", "2821"), /^[0-9a-f]{64}$/u)).test(String(value.token_hash)))) {
      if (stryMutAct_9fa48("2822")) {
        {}
      } else {
        stryCov_9fa48("2822");
        throw new CapabilityInvalidError(stryMutAct_9fa48("2823") ? "" : (stryCov_9fa48("2823"), 'invalid capability state token hash'));
      }
    }
    if (stryMutAct_9fa48("2826") ? false : stryMutAct_9fa48("2825") ? true : stryMutAct_9fa48("2824") ? /^[A-Za-z0-9_-]+$/u.test(String(value.signature)) : (stryCov_9fa48("2824", "2825", "2826"), !(stryMutAct_9fa48("2830") ? /^[^A-Za-z0-9_-]+$/u : stryMutAct_9fa48("2829") ? /^[A-Za-z0-9_-]$/u : stryMutAct_9fa48("2828") ? /^[A-Za-z0-9_-]+/u : stryMutAct_9fa48("2827") ? /[A-Za-z0-9_-]+$/u : (stryCov_9fa48("2827", "2828", "2829", "2830"), /^[A-Za-z0-9_-]+$/u)).test(String(value.signature)))) {
      if (stryMutAct_9fa48("2831")) {
        {}
      } else {
        stryCov_9fa48("2831");
        throw new CapabilityInvalidError(stryMutAct_9fa48("2832") ? "" : (stryCov_9fa48("2832"), 'invalid capability state signature'));
      }
    }
    if (stryMutAct_9fa48("2835") ? false : stryMutAct_9fa48("2834") ? true : stryMutAct_9fa48("2833") ? ['issued', 'used', 'revoked'].includes(String(value.status)) : (stryCov_9fa48("2833", "2834", "2835"), !(stryMutAct_9fa48("2836") ? [] : (stryCov_9fa48("2836"), [stryMutAct_9fa48("2837") ? "" : (stryCov_9fa48("2837"), 'issued'), stryMutAct_9fa48("2838") ? "" : (stryCov_9fa48("2838"), 'used'), stryMutAct_9fa48("2839") ? "" : (stryCov_9fa48("2839"), 'revoked')])).includes(String(value.status)))) {
      if (stryMutAct_9fa48("2840")) {
        {}
      } else {
        stryCov_9fa48("2840");
        throw new CapabilityInvalidError(stryMutAct_9fa48("2841") ? "" : (stryCov_9fa48("2841"), 'invalid capability state status'));
      }
    }
  }
}
function parseState(serialized: string): PersistedCapabilityState {
  if (stryMutAct_9fa48("2842")) {
    {}
  } else {
    stryCov_9fa48("2842");
    let parsed: unknown;
    try {
      if (stryMutAct_9fa48("2843")) {
        {}
      } else {
        stryCov_9fa48("2843");
        parsed = JSON.parse(serialized);
      }
    } catch {
      if (stryMutAct_9fa48("2844")) {
        {}
      } else {
        stryCov_9fa48("2844");
        throw new CapabilityInvalidError(stryMutAct_9fa48("2845") ? "" : (stryCov_9fa48("2845"), 'invalid capability state JSON'));
      }
    }
    if (stryMutAct_9fa48("2848") ? (!isRecord(parsed) || parsed.version !== 1) && !isRecord(parsed.records) : stryMutAct_9fa48("2847") ? false : stryMutAct_9fa48("2846") ? true : (stryCov_9fa48("2846", "2847", "2848"), (stryMutAct_9fa48("2850") ? !isRecord(parsed) && parsed.version !== 1 : stryMutAct_9fa48("2849") ? false : (stryCov_9fa48("2849", "2850"), (stryMutAct_9fa48("2851") ? isRecord(parsed) : (stryCov_9fa48("2851"), !isRecord(parsed))) || (stryMutAct_9fa48("2853") ? parsed.version === 1 : stryMutAct_9fa48("2852") ? false : (stryCov_9fa48("2852", "2853"), parsed.version !== 1)))) || (stryMutAct_9fa48("2854") ? isRecord(parsed.records) : (stryCov_9fa48("2854"), !isRecord(parsed.records))))) {
      if (stryMutAct_9fa48("2855")) {
        {}
      } else {
        stryCov_9fa48("2855");
        throw new CapabilityInvalidError(stryMutAct_9fa48("2856") ? "" : (stryCov_9fa48("2856"), 'invalid capability state document'));
      }
    }
    if (stryMutAct_9fa48("2859") ? Object.keys(parsed).sort().join(',') === 'records,version' : stryMutAct_9fa48("2858") ? false : stryMutAct_9fa48("2857") ? true : (stryCov_9fa48("2857", "2858", "2859"), (stryMutAct_9fa48("2860") ? Object.keys(parsed).join(',') : (stryCov_9fa48("2860"), Object.keys(parsed).sort().join(stryMutAct_9fa48("2861") ? "" : (stryCov_9fa48("2861"), ',')))) !== (stryMutAct_9fa48("2862") ? "" : (stryCov_9fa48("2862"), 'records,version')))) {
      if (stryMutAct_9fa48("2863")) {
        {}
      } else {
        stryCov_9fa48("2863");
        throw new CapabilityInvalidError(stryMutAct_9fa48("2864") ? "" : (stryCov_9fa48("2864"), 'invalid capability state fields'));
      }
    }
    for (const [tokenId, record] of Object.entries(parsed.records)) {
      if (stryMutAct_9fa48("2865")) {
        {}
      } else {
        stryCov_9fa48("2865");
        if (stryMutAct_9fa48("2868") ? false : stryMutAct_9fa48("2867") ? true : stryMutAct_9fa48("2866") ? isUuid(tokenId) : (stryCov_9fa48("2866", "2867", "2868"), !isUuid(tokenId))) throw new CapabilityInvalidError(stryMutAct_9fa48("2869") ? "" : (stryCov_9fa48("2869"), 'invalid capability state token id'));
        validateStateRecord(record);
      }
    }
    return parsed as unknown as PersistedCapabilityState;
  }
}
async function wait(delayMs: number): Promise<void> {
  if (stryMutAct_9fa48("2870")) {
    {}
  } else {
    stryCov_9fa48("2870");
    await new Promise<void>(stryMutAct_9fa48("2871") ? () => undefined : (stryCov_9fa48("2871"), resolve => setTimeout(resolve, delayMs)));
  }
}
export class FileCapabilityStateStore implements CapabilityStateStore {
  readonly #path: string;
  readonly #lockPath: string;
  readonly #lockTimeoutMs: number;
  constructor(path: string, options: {
    lock_timeout_ms?: number;
  } = {}) {
    if (stryMutAct_9fa48("2872")) {
      {}
    } else {
      stryCov_9fa48("2872");
      if (stryMutAct_9fa48("2875") ? false : stryMutAct_9fa48("2874") ? true : stryMutAct_9fa48("2873") ? isAbsolute(path) : (stryCov_9fa48("2873", "2874", "2875"), !isAbsolute(path))) throw new CapabilityInvalidError(stryMutAct_9fa48("2876") ? "" : (stryCov_9fa48("2876"), 'capability state path must be absolute'));
      this.#path = path;
      this.#lockPath = stryMutAct_9fa48("2877") ? `` : (stryCov_9fa48("2877"), `${path}.lock`);
      this.#lockTimeoutMs = stryMutAct_9fa48("2878") ? options.lock_timeout_ms && 5_000 : (stryCov_9fa48("2878"), options.lock_timeout_ms ?? 5_000);
      if (stryMutAct_9fa48("2881") ? !Number.isSafeInteger(this.#lockTimeoutMs) && this.#lockTimeoutMs <= 0 : stryMutAct_9fa48("2880") ? false : stryMutAct_9fa48("2879") ? true : (stryCov_9fa48("2879", "2880", "2881"), (stryMutAct_9fa48("2882") ? Number.isSafeInteger(this.#lockTimeoutMs) : (stryCov_9fa48("2882"), !Number.isSafeInteger(this.#lockTimeoutMs))) || (stryMutAct_9fa48("2885") ? this.#lockTimeoutMs > 0 : stryMutAct_9fa48("2884") ? this.#lockTimeoutMs < 0 : stryMutAct_9fa48("2883") ? false : (stryCov_9fa48("2883", "2884", "2885"), this.#lockTimeoutMs <= 0)))) {
        if (stryMutAct_9fa48("2886")) {
          {}
        } else {
          stryCov_9fa48("2886");
          throw new CapabilityInvalidError(stryMutAct_9fa48("2887") ? "" : (stryCov_9fa48("2887"), 'lock_timeout_ms must be a positive safe integer'));
        }
      }
    }
  }
  async register(tokenId: string, record: CapabilityStateRecord): Promise<void> {
    if (stryMutAct_9fa48("2888")) {
      {}
    } else {
      stryCov_9fa48("2888");
      await this.#mutate(state => {
        if (stryMutAct_9fa48("2889")) {
          {}
        } else {
          stryCov_9fa48("2889");
          if (stryMutAct_9fa48("2892") ? state.records[tokenId] === undefined : stryMutAct_9fa48("2891") ? false : stryMutAct_9fa48("2890") ? true : (stryCov_9fa48("2890", "2891", "2892"), state.records[tokenId] !== undefined)) {
            if (stryMutAct_9fa48("2893")) {
              {}
            } else {
              stryCov_9fa48("2893");
              throw new CapabilityInvalidError(stryMutAct_9fa48("2894") ? "" : (stryCov_9fa48("2894"), 'duplicate capability token id'));
            }
          }
          state.records[tokenId] = cloneRecord(record);
        }
      });
    }
  }
  async read(tokenId: string): Promise<CapabilityStateRecord | undefined> {
    if (stryMutAct_9fa48("2895")) {
      {}
    } else {
      stryCov_9fa48("2895");
      return this.#withLock(async () => {
        if (stryMutAct_9fa48("2896")) {
          {}
        } else {
          stryCov_9fa48("2896");
          const state = await this.#load();
          const record = state.records[tokenId];
          return (stryMutAct_9fa48("2899") ? record !== undefined : stryMutAct_9fa48("2898") ? false : stryMutAct_9fa48("2897") ? true : (stryCov_9fa48("2897", "2898", "2899"), record === undefined)) ? undefined : cloneRecord(record);
        }
      });
    }
  }
  async consume(tokenId: string, tokenHash: string): Promise<'consumed' | 'used' | 'revoked' | 'missing' | 'mismatch'> {
    if (stryMutAct_9fa48("2900")) {
      {}
    } else {
      stryCov_9fa48("2900");
      let outcome: 'consumed' | 'used' | 'revoked' | 'missing' | 'mismatch' = stryMutAct_9fa48("2901") ? "" : (stryCov_9fa48("2901"), 'missing');
      await this.#mutate(state => {
        if (stryMutAct_9fa48("2902")) {
          {}
        } else {
          stryCov_9fa48("2902");
          const record = state.records[tokenId];
          if (stryMutAct_9fa48("2905") ? record !== undefined : stryMutAct_9fa48("2904") ? false : stryMutAct_9fa48("2903") ? true : (stryCov_9fa48("2903", "2904", "2905"), record === undefined)) return;
          if (stryMutAct_9fa48("2908") ? record.token_hash === tokenHash : stryMutAct_9fa48("2907") ? false : stryMutAct_9fa48("2906") ? true : (stryCov_9fa48("2906", "2907", "2908"), record.token_hash !== tokenHash)) {
            if (stryMutAct_9fa48("2909")) {
              {}
            } else {
              stryCov_9fa48("2909");
              outcome = stryMutAct_9fa48("2910") ? "" : (stryCov_9fa48("2910"), 'mismatch');
              return;
            }
          }
          if (stryMutAct_9fa48("2913") ? record.status === 'used' && record.status === 'revoked' : stryMutAct_9fa48("2912") ? false : stryMutAct_9fa48("2911") ? true : (stryCov_9fa48("2911", "2912", "2913"), (stryMutAct_9fa48("2915") ? record.status !== 'used' : stryMutAct_9fa48("2914") ? false : (stryCov_9fa48("2914", "2915"), record.status === (stryMutAct_9fa48("2916") ? "" : (stryCov_9fa48("2916"), 'used')))) || (stryMutAct_9fa48("2918") ? record.status !== 'revoked' : stryMutAct_9fa48("2917") ? false : (stryCov_9fa48("2917", "2918"), record.status === (stryMutAct_9fa48("2919") ? "" : (stryCov_9fa48("2919"), 'revoked')))))) {
            if (stryMutAct_9fa48("2920")) {
              {}
            } else {
              stryCov_9fa48("2920");
              outcome = record.status;
              return;
            }
          }
          state.records[tokenId] = cloneRecord(stryMutAct_9fa48("2921") ? {} : (stryCov_9fa48("2921"), {
            ...record,
            status: stryMutAct_9fa48("2922") ? "" : (stryCov_9fa48("2922"), 'used')
          }));
          outcome = stryMutAct_9fa48("2923") ? "" : (stryCov_9fa48("2923"), 'consumed');
        }
      });
      return outcome;
    }
  }
  async revoke(tokenId: string): Promise<boolean> {
    if (stryMutAct_9fa48("2924")) {
      {}
    } else {
      stryCov_9fa48("2924");
      let changed = stryMutAct_9fa48("2925") ? true : (stryCov_9fa48("2925"), false);
      await this.#mutate(state => {
        if (stryMutAct_9fa48("2926")) {
          {}
        } else {
          stryCov_9fa48("2926");
          const record = state.records[tokenId];
          if (stryMutAct_9fa48("2929") ? record === undefined && record.status === 'revoked' : stryMutAct_9fa48("2928") ? false : stryMutAct_9fa48("2927") ? true : (stryCov_9fa48("2927", "2928", "2929"), (stryMutAct_9fa48("2931") ? record !== undefined : stryMutAct_9fa48("2930") ? false : (stryCov_9fa48("2930", "2931"), record === undefined)) || (stryMutAct_9fa48("2933") ? record.status !== 'revoked' : stryMutAct_9fa48("2932") ? false : (stryCov_9fa48("2932", "2933"), record.status === (stryMutAct_9fa48("2934") ? "" : (stryCov_9fa48("2934"), 'revoked')))))) return;
          state.records[tokenId] = cloneRecord(stryMutAct_9fa48("2935") ? {} : (stryCov_9fa48("2935"), {
            ...record,
            status: stryMutAct_9fa48("2936") ? "" : (stryCov_9fa48("2936"), 'revoked')
          }));
          changed = stryMutAct_9fa48("2937") ? false : (stryCov_9fa48("2937"), true);
        }
      });
      return changed;
    }
  }
  async #mutate(operation: (state: PersistedCapabilityState) => void): Promise<void> {
    if (stryMutAct_9fa48("2938")) {
      {}
    } else {
      stryCov_9fa48("2938");
      await this.#withLock(async () => {
        if (stryMutAct_9fa48("2939")) {
          {}
        } else {
          stryCov_9fa48("2939");
          const state = await this.#load();
          operation(state);
          await this.#save(state);
        }
      });
    }
  }
  async #load(): Promise<PersistedCapabilityState> {
    if (stryMutAct_9fa48("2940")) {
      {}
    } else {
      stryCov_9fa48("2940");
      try {
        if (stryMutAct_9fa48("2941")) {
          {}
        } else {
          stryCov_9fa48("2941");
          return parseState(await readFile(this.#path, stryMutAct_9fa48("2942") ? "" : (stryCov_9fa48("2942"), 'utf8')));
        }
      } catch (error) {
        if (stryMutAct_9fa48("2943")) {
          {}
        } else {
          stryCov_9fa48("2943");
          if (stryMutAct_9fa48("2946") ? isRecord(error) || error.code === 'ENOENT' : stryMutAct_9fa48("2945") ? false : stryMutAct_9fa48("2944") ? true : (stryCov_9fa48("2944", "2945", "2946"), isRecord(error) && (stryMutAct_9fa48("2948") ? error.code !== 'ENOENT' : stryMutAct_9fa48("2947") ? true : (stryCov_9fa48("2947", "2948"), error.code === (stryMutAct_9fa48("2949") ? "" : (stryCov_9fa48("2949"), 'ENOENT')))))) return stryMutAct_9fa48("2950") ? {} : (stryCov_9fa48("2950"), {
            version: 1,
            records: {}
          });
          throw error;
        }
      }
    }
  }
  async #save(state: PersistedCapabilityState): Promise<void> {
    if (stryMutAct_9fa48("2951")) {
      {}
    } else {
      stryCov_9fa48("2951");
      await mkdir(dirname(this.#path), stryMutAct_9fa48("2952") ? {} : (stryCov_9fa48("2952"), {
        recursive: stryMutAct_9fa48("2953") ? false : (stryCov_9fa48("2953"), true),
        mode: 0o700
      }));
      const temporaryPath = stryMutAct_9fa48("2954") ? `` : (stryCov_9fa48("2954"), `${this.#path}.tmp-${process.pid}-${Date.now()}`);
      const handle = await open(temporaryPath, stryMutAct_9fa48("2955") ? "" : (stryCov_9fa48("2955"), 'wx'), 0o600);
      try {
        if (stryMutAct_9fa48("2956")) {
          {}
        } else {
          stryCov_9fa48("2956");
          await handle.writeFile(JSON.stringify(canonicalizeCapabilityValue(state)));
          await handle.sync();
        }
      } finally {
        if (stryMutAct_9fa48("2957")) {
          {}
        } else {
          stryCov_9fa48("2957");
          await handle.close();
        }
      }
      await rename(temporaryPath, this.#path);
    }
  }
  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    if (stryMutAct_9fa48("2958")) {
      {}
    } else {
      stryCov_9fa48("2958");
      await mkdir(dirname(this.#path), stryMutAct_9fa48("2959") ? {} : (stryCov_9fa48("2959"), {
        recursive: stryMutAct_9fa48("2960") ? false : (stryCov_9fa48("2960"), true),
        mode: 0o700
      }));
      const deadline = stryMutAct_9fa48("2961") ? Date.now() - this.#lockTimeoutMs : (stryCov_9fa48("2961"), Date.now() + this.#lockTimeoutMs);
      while (stryMutAct_9fa48("2963") ? false : stryMutAct_9fa48("2962") ? false : (stryCov_9fa48("2962", "2963"), true)) {
        if (stryMutAct_9fa48("2964")) {
          {}
        } else {
          stryCov_9fa48("2964");
          try {
            if (stryMutAct_9fa48("2965")) {
              {}
            } else {
              stryCov_9fa48("2965");
              await mkdir(this.#lockPath, stryMutAct_9fa48("2966") ? {} : (stryCov_9fa48("2966"), {
                mode: 0o700
              }));
              break;
            }
          } catch (error) {
            if (stryMutAct_9fa48("2967")) {
              {}
            } else {
              stryCov_9fa48("2967");
              if (stryMutAct_9fa48("2970") ? !isRecord(error) && error.code !== 'EEXIST' : stryMutAct_9fa48("2969") ? false : stryMutAct_9fa48("2968") ? true : (stryCov_9fa48("2968", "2969", "2970"), (stryMutAct_9fa48("2971") ? isRecord(error) : (stryCov_9fa48("2971"), !isRecord(error))) || (stryMutAct_9fa48("2973") ? error.code === 'EEXIST' : stryMutAct_9fa48("2972") ? false : (stryCov_9fa48("2972", "2973"), error.code !== (stryMutAct_9fa48("2974") ? "" : (stryCov_9fa48("2974"), 'EEXIST')))))) throw error;
              if (stryMutAct_9fa48("2978") ? Date.now() < deadline : stryMutAct_9fa48("2977") ? Date.now() > deadline : stryMutAct_9fa48("2976") ? false : stryMutAct_9fa48("2975") ? true : (stryCov_9fa48("2975", "2976", "2977", "2978"), Date.now() >= deadline)) throw new CapabilityInvalidError(stryMutAct_9fa48("2979") ? "" : (stryCov_9fa48("2979"), 'capability state lock timeout'));
              await wait(2);
            }
          }
        }
      }
      try {
        if (stryMutAct_9fa48("2980")) {
          {}
        } else {
          stryCov_9fa48("2980");
          return await operation();
        }
      } finally {
        if (stryMutAct_9fa48("2981")) {
          {}
        } else {
          stryCov_9fa48("2981");
          await rm(this.#lockPath, stryMutAct_9fa48("2982") ? {} : (stryCov_9fa48("2982"), {
            recursive: stryMutAct_9fa48("2983") ? false : (stryCov_9fa48("2983"), true),
            force: stryMutAct_9fa48("2984") ? false : (stryCov_9fa48("2984"), true)
          }));
        }
      }
    }
  }
}
export function isUuid(value: unknown): value is string {
  if (stryMutAct_9fa48("2985")) {
    {}
  } else {
    stryCov_9fa48("2985");
    return stryMutAct_9fa48("2988") ? typeof value === 'string' || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value) : stryMutAct_9fa48("2987") ? false : stryMutAct_9fa48("2986") ? true : (stryCov_9fa48("2986", "2987", "2988"), (stryMutAct_9fa48("2990") ? typeof value !== 'string' : stryMutAct_9fa48("2989") ? true : (stryCov_9fa48("2989", "2990"), typeof value === (stryMutAct_9fa48("2991") ? "" : (stryCov_9fa48("2991"), 'string')))) && (stryMutAct_9fa48("3005") ? /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[^0-9a-f]{12}$/iu : stryMutAct_9fa48("3004") ? /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]$/iu : stryMutAct_9fa48("3003") ? /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][^0-9a-f]{3}-[0-9a-f]{12}$/iu : stryMutAct_9fa48("3002") ? /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]-[0-9a-f]{12}$/iu : stryMutAct_9fa48("3001") ? /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[^89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu : stryMutAct_9fa48("3000") ? /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][^0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu : stryMutAct_9fa48("2999") ? /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu : stryMutAct_9fa48("2998") ? /^[0-9a-f]{8}-[0-9a-f]{4}-[^1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu : stryMutAct_9fa48("2997") ? /^[0-9a-f]{8}-[^0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu : stryMutAct_9fa48("2996") ? /^[0-9a-f]{8}-[0-9a-f]-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu : stryMutAct_9fa48("2995") ? /^[^0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu : stryMutAct_9fa48("2994") ? /^[0-9a-f]-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu : stryMutAct_9fa48("2993") ? /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu : stryMutAct_9fa48("2992") ? /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu : (stryCov_9fa48("2992", "2993", "2994", "2995", "2996", "2997", "2998", "2999", "3000", "3001", "3002", "3003", "3004", "3005"), /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu)).test(value));
  }
}