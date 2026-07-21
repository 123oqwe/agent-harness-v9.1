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
import { createHash } from 'node:crypto';
import type { ProviderAdapter as ProviderAdapterContract } from '../../spec/types/provider-adapter.js';
import type { ToolSpec as ContractToolSpec } from '../../spec/types/tool-spec.js';
type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | {
  [key: string]: JsonValue;
};
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}
export interface Message {
  readonly role: 'assistant' | 'system' | 'tool' | 'user';
  content: string;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly ToolCall[];
}
export interface Usage {
  input_tokens: number;
  output_tokens: number;
}
export interface ParsedResponse {
  readonly content: string;
  readonly tool_calls?: readonly ToolCall[];
  readonly stop_reason?: 'content_filter' | 'length' | 'stop' | 'tool_use';
  readonly usage?: Usage;
  readonly model?: string;
}
export type ProviderTool = Pick<ContractToolSpec, 'name'> & Partial<Omit<ContractToolSpec, 'name'>>;
export interface ProviderRequest {
  readonly messages: readonly Message[];
  readonly tools?: readonly ProviderTool[];
  readonly model?: string;
  readonly temperature?: number;
  readonly max_tokens?: number;
}
export type HealthStatus = 'healthy' | 'degraded' | 'down';
export interface DataPolicyResult {
  readonly allowed: boolean;
  readonly reason?: string;
}
export interface ProviderError {
  readonly kind: 'auth' | 'invalid_request' | 'rate_limited' | 'server' | 'timeout' | 'unknown';
  readonly retryable: boolean;
  readonly detail: string;
  readonly status?: number;
}
export type StreamEvent = {
  readonly type: 'text_delta';
  readonly text: string;
} | {
  readonly type: 'tool_call';
  readonly tool_call: ToolCall;
} | {
  readonly type: 'message_stop';
  readonly stop_reason: ParsedResponse['stop_reason'];
  readonly usage?: Usage;
};
export interface CallMetadata {
  readonly index: number;
  readonly timestamp: string;
  readonly messages: readonly Message[];
  readonly tools_requested: readonly string[];
  readonly response: ParsedResponse;
  readonly usage: Usage;
  readonly lookup_mode: 'map' | 'queue';
}
export class ProviderValidationError extends TypeError {
  constructor(message: string) {
    if (stryMutAct_9fa48("687")) {
      {}
    } else {
      stryCov_9fa48("687");
      super(message);
      this.name = stryMutAct_9fa48("688") ? "" : (stryCov_9fa48("688"), 'ProviderValidationError');
    }
  }
}
export class ProviderHttpError extends Error {
  readonly status: number;
  constructor(status: number, message = stryMutAct_9fa48("689") ? `` : (stryCov_9fa48("689"), `Provider returned HTTP ${status}`)) {
    if (stryMutAct_9fa48("690")) {
      {}
    } else {
      stryCov_9fa48("690");
      if (stryMutAct_9fa48("693") ? (!Number.isInteger(status) || status < 100) && status > 599 : stryMutAct_9fa48("692") ? false : stryMutAct_9fa48("691") ? true : (stryCov_9fa48("691", "692", "693"), (stryMutAct_9fa48("695") ? !Number.isInteger(status) && status < 100 : stryMutAct_9fa48("694") ? false : (stryCov_9fa48("694", "695"), (stryMutAct_9fa48("696") ? Number.isInteger(status) : (stryCov_9fa48("696"), !Number.isInteger(status))) || (stryMutAct_9fa48("699") ? status >= 100 : stryMutAct_9fa48("698") ? status <= 100 : stryMutAct_9fa48("697") ? false : (stryCov_9fa48("697", "698", "699"), status < 100)))) || (stryMutAct_9fa48("702") ? status <= 599 : stryMutAct_9fa48("701") ? status >= 599 : stryMutAct_9fa48("700") ? false : (stryCov_9fa48("700", "701", "702"), status > 599)))) {
        if (stryMutAct_9fa48("703")) {
          {}
        } else {
          stryCov_9fa48("703");
          throw new RangeError(stryMutAct_9fa48("704") ? "" : (stryCov_9fa48("704"), 'Provider HTTP status must be an integer from 100 through 599'));
        }
      }
      super(message);
      this.name = stryMutAct_9fa48("705") ? "" : (stryCov_9fa48("705"), 'ProviderHttpError');
      this.status = status;
    }
  }
}
export class ProviderTimeoutError extends Error {
  constructor(message = stryMutAct_9fa48("706") ? "" : (stryCov_9fa48("706"), 'Provider request timed out')) {
    if (stryMutAct_9fa48("707")) {
      {}
    } else {
      stryCov_9fa48("707");
      super(message);
      this.name = stryMutAct_9fa48("708") ? "" : (stryCov_9fa48("708"), 'ProviderTimeoutError');
    }
  }
}
export class ScriptedResponseExhaustedError extends Error {
  constructor(message = stryMutAct_9fa48("709") ? "" : (stryCov_9fa48("709"), 'Scripted response queue exhausted: no response remains')) {
    if (stryMutAct_9fa48("710")) {
      {}
    } else {
      stryCov_9fa48("710");
      super(message);
      this.name = stryMutAct_9fa48("711") ? "" : (stryCov_9fa48("711"), 'ScriptedResponseExhaustedError');
    }
  }
}
export class ScriptedResponseMissingError extends Error {
  readonly key: string;
  constructor(key: string) {
    if (stryMutAct_9fa48("712")) {
      {}
    } else {
      stryCov_9fa48("712");
      super(stryMutAct_9fa48("713") ? `` : (stryCov_9fa48("713"), `Scripted response missing for input hash ${key}`));
      this.name = stryMutAct_9fa48("714") ? "" : (stryCov_9fa48("714"), 'ScriptedResponseMissingError');
      this.key = key;
    }
  }
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (stryMutAct_9fa48("715")) {
    {}
  } else {
    stryCov_9fa48("715");
    if (stryMutAct_9fa48("718") ? (typeof value !== 'object' || value === null) && Array.isArray(value) : stryMutAct_9fa48("717") ? false : stryMutAct_9fa48("716") ? true : (stryCov_9fa48("716", "717", "718"), (stryMutAct_9fa48("720") ? typeof value !== 'object' && value === null : stryMutAct_9fa48("719") ? false : (stryCov_9fa48("719", "720"), (stryMutAct_9fa48("722") ? typeof value === 'object' : stryMutAct_9fa48("721") ? false : (stryCov_9fa48("721", "722"), typeof value !== (stryMutAct_9fa48("723") ? "" : (stryCov_9fa48("723"), 'object')))) || (stryMutAct_9fa48("725") ? value !== null : stryMutAct_9fa48("724") ? false : (stryCov_9fa48("724", "725"), value === null)))) || Array.isArray(value))) return stryMutAct_9fa48("726") ? true : (stryCov_9fa48("726"), false);
    const prototype = Object.getPrototypeOf(value) as unknown;
    return stryMutAct_9fa48("729") ? prototype === Object.prototype && prototype === null : stryMutAct_9fa48("728") ? false : stryMutAct_9fa48("727") ? true : (stryCov_9fa48("727", "728", "729"), (stryMutAct_9fa48("731") ? prototype !== Object.prototype : stryMutAct_9fa48("730") ? false : (stryCov_9fa48("730", "731"), prototype === Object.prototype)) || (stryMutAct_9fa48("733") ? prototype !== null : stryMutAct_9fa48("732") ? false : (stryCov_9fa48("732", "733"), prototype === null)));
  }
}
function cloneJson(value: unknown, location = stryMutAct_9fa48("734") ? "" : (stryCov_9fa48("734"), '$')): JsonValue {
  if (stryMutAct_9fa48("735")) {
    {}
  } else {
    stryCov_9fa48("735");
    if (stryMutAct_9fa48("738") ? (value === null || typeof value === 'boolean') && typeof value === 'string' : stryMutAct_9fa48("737") ? false : stryMutAct_9fa48("736") ? true : (stryCov_9fa48("736", "737", "738"), (stryMutAct_9fa48("740") ? value === null && typeof value === 'boolean' : stryMutAct_9fa48("739") ? false : (stryCov_9fa48("739", "740"), (stryMutAct_9fa48("742") ? value !== null : stryMutAct_9fa48("741") ? false : (stryCov_9fa48("741", "742"), value === null)) || (stryMutAct_9fa48("744") ? typeof value !== 'boolean' : stryMutAct_9fa48("743") ? false : (stryCov_9fa48("743", "744"), typeof value === (stryMutAct_9fa48("745") ? "" : (stryCov_9fa48("745"), 'boolean')))))) || (stryMutAct_9fa48("747") ? typeof value !== 'string' : stryMutAct_9fa48("746") ? false : (stryCov_9fa48("746", "747"), typeof value === (stryMutAct_9fa48("748") ? "" : (stryCov_9fa48("748"), 'string')))))) return value;
    if (stryMutAct_9fa48("751") ? typeof value !== 'number' : stryMutAct_9fa48("750") ? false : stryMutAct_9fa48("749") ? true : (stryCov_9fa48("749", "750", "751"), typeof value === (stryMutAct_9fa48("752") ? "" : (stryCov_9fa48("752"), 'number')))) {
      if (stryMutAct_9fa48("753")) {
        {}
      } else {
        stryCov_9fa48("753");
        if (stryMutAct_9fa48("756") ? false : stryMutAct_9fa48("755") ? true : stryMutAct_9fa48("754") ? Number.isFinite(value) : (stryCov_9fa48("754", "755", "756"), !Number.isFinite(value))) {
          if (stryMutAct_9fa48("757")) {
            {}
          } else {
            stryCov_9fa48("757");
            throw new ProviderValidationError(stryMutAct_9fa48("758") ? `` : (stryCov_9fa48("758"), `${location} must contain only finite JSON numbers`));
          }
        }
        return value;
      }
    }
    if (stryMutAct_9fa48("760") ? false : stryMutAct_9fa48("759") ? true : (stryCov_9fa48("759", "760"), Array.isArray(value))) {
      if (stryMutAct_9fa48("761")) {
        {}
      } else {
        stryCov_9fa48("761");
        return value.map(stryMutAct_9fa48("762") ? () => undefined : (stryCov_9fa48("762"), (entry, index) => cloneJson(entry, stryMutAct_9fa48("763") ? `` : (stryCov_9fa48("763"), `${location}[${index}]`))));
      }
    }
    if (stryMutAct_9fa48("765") ? false : stryMutAct_9fa48("764") ? true : (stryCov_9fa48("764", "765"), isPlainRecord(value))) {
      if (stryMutAct_9fa48("766")) {
        {}
      } else {
        stryCov_9fa48("766");
        return Object.fromEntries(Object.entries(value).map(stryMutAct_9fa48("767") ? () => undefined : (stryCov_9fa48("767"), ([key, entry]) => stryMutAct_9fa48("768") ? [] : (stryCov_9fa48("768"), [key, cloneJson(entry, stryMutAct_9fa48("769") ? `` : (stryCov_9fa48("769"), `${location}.${key}`))]))));
      }
    }
    throw new ProviderValidationError(stryMutAct_9fa48("770") ? `` : (stryCov_9fa48("770"), `${location} must be valid JSON data`));
  }
}
function deepFreeze<T>(value: T): T {
  if (stryMutAct_9fa48("771")) {
    {}
  } else {
    stryCov_9fa48("771");
    if (stryMutAct_9fa48("774") ? (typeof value !== 'object' || value === null) && Object.isFrozen(value) : stryMutAct_9fa48("773") ? false : stryMutAct_9fa48("772") ? true : (stryCov_9fa48("772", "773", "774"), (stryMutAct_9fa48("776") ? typeof value !== 'object' && value === null : stryMutAct_9fa48("775") ? false : (stryCov_9fa48("775", "776"), (stryMutAct_9fa48("778") ? typeof value === 'object' : stryMutAct_9fa48("777") ? false : (stryCov_9fa48("777", "778"), typeof value !== (stryMutAct_9fa48("779") ? "" : (stryCov_9fa48("779"), 'object')))) || (stryMutAct_9fa48("781") ? value !== null : stryMutAct_9fa48("780") ? false : (stryCov_9fa48("780", "781"), value === null)))) || Object.isFrozen(value))) return value;
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    return Object.freeze(value);
  }
}
function cloneAndFreeze<T>(value: T, location = stryMutAct_9fa48("782") ? "" : (stryCov_9fa48("782"), '$')): T {
  if (stryMutAct_9fa48("783")) {
    {}
  } else {
    stryCov_9fa48("783");
    return deepFreeze(cloneJson(value, location) as T);
  }
}
function assertKnownKeys(value: Record<string, unknown>, keys: readonly string[], location: string) {
  if (stryMutAct_9fa48("784")) {
    {}
  } else {
    stryCov_9fa48("784");
    const unknown = stryMutAct_9fa48("785") ? Object.keys(value) : (stryCov_9fa48("785"), Object.keys(value).filter(stryMutAct_9fa48("786") ? () => undefined : (stryCov_9fa48("786"), key => stryMutAct_9fa48("787") ? keys.includes(key) : (stryCov_9fa48("787"), !keys.includes(key)))));
    if (stryMutAct_9fa48("791") ? unknown.length <= 0 : stryMutAct_9fa48("790") ? unknown.length >= 0 : stryMutAct_9fa48("789") ? false : stryMutAct_9fa48("788") ? true : (stryCov_9fa48("788", "789", "790", "791"), unknown.length > 0)) {
      if (stryMutAct_9fa48("792")) {
        {}
      } else {
        stryCov_9fa48("792");
        throw new ProviderValidationError(stryMutAct_9fa48("793") ? `` : (stryCov_9fa48("793"), `${location} contains unknown field: ${unknown[0]}`));
      }
    }
  }
}
function nonEmptyString(value: unknown, location: string): string {
  if (stryMutAct_9fa48("794")) {
    {}
  } else {
    stryCov_9fa48("794");
    if (stryMutAct_9fa48("797") ? typeof value !== 'string' && value.trim().length === 0 : stryMutAct_9fa48("796") ? false : stryMutAct_9fa48("795") ? true : (stryCov_9fa48("795", "796", "797"), (stryMutAct_9fa48("799") ? typeof value === 'string' : stryMutAct_9fa48("798") ? false : (stryCov_9fa48("798", "799"), typeof value !== (stryMutAct_9fa48("800") ? "" : (stryCov_9fa48("800"), 'string')))) || (stryMutAct_9fa48("802") ? value.trim().length !== 0 : stryMutAct_9fa48("801") ? false : (stryCov_9fa48("801", "802"), (stryMutAct_9fa48("803") ? value.length : (stryCov_9fa48("803"), value.trim().length)) === 0)))) {
      if (stryMutAct_9fa48("804")) {
        {}
      } else {
        stryCov_9fa48("804");
        throw new ProviderValidationError(stryMutAct_9fa48("805") ? `` : (stryCov_9fa48("805"), `${location} must be a non-empty string`));
      }
    }
    return value;
  }
}
function normalizeUsage(raw: unknown, location = stryMutAct_9fa48("806") ? "" : (stryCov_9fa48("806"), 'usage')): Usage {
  if (stryMutAct_9fa48("807")) {
    {}
  } else {
    stryCov_9fa48("807");
    if (stryMutAct_9fa48("810") ? false : stryMutAct_9fa48("809") ? true : stryMutAct_9fa48("808") ? isPlainRecord(raw) : (stryCov_9fa48("808", "809", "810"), !isPlainRecord(raw))) throw new ProviderValidationError(stryMutAct_9fa48("811") ? `` : (stryCov_9fa48("811"), `${location} must be an object`));
    assertKnownKeys(raw, stryMutAct_9fa48("812") ? [] : (stryCov_9fa48("812"), [stryMutAct_9fa48("813") ? "" : (stryCov_9fa48("813"), 'input_tokens'), stryMutAct_9fa48("814") ? "" : (stryCov_9fa48("814"), 'output_tokens')]), location);
    const inputTokens = raw.input_tokens;
    const outputTokens = raw.output_tokens;
    for (const [field, value] of [['input_tokens', inputTokens], ['output_tokens', outputTokens]] as const) {
      if (stryMutAct_9fa48("815")) {
        {}
      } else {
        stryCov_9fa48("815");
        if (stryMutAct_9fa48("818") ? !Number.isSafeInteger(value) && value as number < 0 : stryMutAct_9fa48("817") ? false : stryMutAct_9fa48("816") ? true : (stryCov_9fa48("816", "817", "818"), (stryMutAct_9fa48("819") ? Number.isSafeInteger(value) : (stryCov_9fa48("819"), !Number.isSafeInteger(value))) || (stryMutAct_9fa48("822") ? value as number >= 0 : stryMutAct_9fa48("821") ? value as number <= 0 : stryMutAct_9fa48("820") ? false : (stryCov_9fa48("820", "821", "822"), value as number < 0)))) {
          if (stryMutAct_9fa48("823")) {
            {}
          } else {
            stryCov_9fa48("823");
            throw new ProviderValidationError(stryMutAct_9fa48("824") ? `` : (stryCov_9fa48("824"), `${location}.${field} must be a non-negative integer`));
          }
        }
      }
    }
    return deepFreeze(stryMutAct_9fa48("825") ? {} : (stryCov_9fa48("825"), {
      input_tokens: inputTokens as number,
      output_tokens: outputTokens as number
    }));
  }
}
function normalizeToolCallValue(raw: unknown, location = stryMutAct_9fa48("826") ? "" : (stryCov_9fa48("826"), 'tool_call')): ToolCall {
  if (stryMutAct_9fa48("827")) {
    {}
  } else {
    stryCov_9fa48("827");
    if (stryMutAct_9fa48("830") ? false : stryMutAct_9fa48("829") ? true : stryMutAct_9fa48("828") ? isPlainRecord(raw) : (stryCov_9fa48("828", "829", "830"), !isPlainRecord(raw))) throw new ProviderValidationError(stryMutAct_9fa48("831") ? `` : (stryCov_9fa48("831"), `${location} must be an object`));
    assertKnownKeys(raw, stryMutAct_9fa48("832") ? [] : (stryCov_9fa48("832"), [stryMutAct_9fa48("833") ? "" : (stryCov_9fa48("833"), 'arguments'), stryMutAct_9fa48("834") ? "" : (stryCov_9fa48("834"), 'id'), stryMutAct_9fa48("835") ? "" : (stryCov_9fa48("835"), 'name')]), location);
    const id = nonEmptyString(raw.id, stryMutAct_9fa48("836") ? `` : (stryCov_9fa48("836"), `${location}.id`));
    const name = nonEmptyString(raw.name, stryMutAct_9fa48("837") ? `` : (stryCov_9fa48("837"), `${location}.name`));
    if (stryMutAct_9fa48("840") ? false : stryMutAct_9fa48("839") ? true : stryMutAct_9fa48("838") ? isPlainRecord(raw.arguments) : (stryCov_9fa48("838", "839", "840"), !isPlainRecord(raw.arguments))) {
      if (stryMutAct_9fa48("841")) {
        {}
      } else {
        stryCov_9fa48("841");
        throw new ProviderValidationError(stryMutAct_9fa48("842") ? `` : (stryCov_9fa48("842"), `${location}.arguments must be an object`));
      }
    }
    return deepFreeze(stryMutAct_9fa48("843") ? {} : (stryCov_9fa48("843"), {
      id,
      name,
      arguments: cloneAndFreeze(raw.arguments, `${location}.arguments`) as Readonly<Record<string, unknown>>
    }));
  }
}
function normalizeMessage(raw: unknown, index: number): Message {
  if (stryMutAct_9fa48("844")) {
    {}
  } else {
    stryCov_9fa48("844");
    const location = stryMutAct_9fa48("845") ? `` : (stryCov_9fa48("845"), `messages[${index}]`);
    if (stryMutAct_9fa48("848") ? false : stryMutAct_9fa48("847") ? true : stryMutAct_9fa48("846") ? isPlainRecord(raw) : (stryCov_9fa48("846", "847", "848"), !isPlainRecord(raw))) throw new ProviderValidationError(stryMutAct_9fa48("849") ? `` : (stryCov_9fa48("849"), `${location} must be an object`));
    assertKnownKeys(raw, stryMutAct_9fa48("850") ? [] : (stryCov_9fa48("850"), [stryMutAct_9fa48("851") ? "" : (stryCov_9fa48("851"), 'content'), stryMutAct_9fa48("852") ? "" : (stryCov_9fa48("852"), 'role'), stryMutAct_9fa48("853") ? "" : (stryCov_9fa48("853"), 'tool_call_id'), stryMutAct_9fa48("854") ? "" : (stryCov_9fa48("854"), 'tool_calls')]), location);
    if (stryMutAct_9fa48("857") ? typeof raw.role !== 'string' && !['assistant', 'system', 'tool', 'user'].includes(raw.role) : stryMutAct_9fa48("856") ? false : stryMutAct_9fa48("855") ? true : (stryCov_9fa48("855", "856", "857"), (stryMutAct_9fa48("859") ? typeof raw.role === 'string' : stryMutAct_9fa48("858") ? false : (stryCov_9fa48("858", "859"), typeof raw.role !== (stryMutAct_9fa48("860") ? "" : (stryCov_9fa48("860"), 'string')))) || (stryMutAct_9fa48("861") ? ['assistant', 'system', 'tool', 'user'].includes(raw.role) : (stryCov_9fa48("861"), !(stryMutAct_9fa48("862") ? [] : (stryCov_9fa48("862"), [stryMutAct_9fa48("863") ? "" : (stryCov_9fa48("863"), 'assistant'), stryMutAct_9fa48("864") ? "" : (stryCov_9fa48("864"), 'system'), stryMutAct_9fa48("865") ? "" : (stryCov_9fa48("865"), 'tool'), stryMutAct_9fa48("866") ? "" : (stryCov_9fa48("866"), 'user')])).includes(raw.role))))) {
      if (stryMutAct_9fa48("867")) {
        {}
      } else {
        stryCov_9fa48("867");
        throw new ProviderValidationError(stryMutAct_9fa48("868") ? `` : (stryCov_9fa48("868"), `${location}.role is unsupported`));
      }
    }
    if (stryMutAct_9fa48("871") ? typeof raw.content === 'string' : stryMutAct_9fa48("870") ? false : stryMutAct_9fa48("869") ? true : (stryCov_9fa48("869", "870", "871"), typeof raw.content !== (stryMutAct_9fa48("872") ? "" : (stryCov_9fa48("872"), 'string')))) {
      if (stryMutAct_9fa48("873")) {
        {}
      } else {
        stryCov_9fa48("873");
        throw new ProviderValidationError(stryMutAct_9fa48("874") ? `` : (stryCov_9fa48("874"), `${location}.content must be a string`));
      }
    }
    const normalized: {
      role: Message['role'];
      content: string;
      tool_call_id?: string;
      tool_calls?: ToolCall[];
    } = stryMutAct_9fa48("875") ? {} : (stryCov_9fa48("875"), {
      role: raw.role as Message['role'],
      content: raw.content
    });
    if (stryMutAct_9fa48("878") ? raw.tool_call_id === undefined : stryMutAct_9fa48("877") ? false : stryMutAct_9fa48("876") ? true : (stryCov_9fa48("876", "877", "878"), raw.tool_call_id !== undefined)) {
      if (stryMutAct_9fa48("879")) {
        {}
      } else {
        stryCov_9fa48("879");
        normalized.tool_call_id = nonEmptyString(raw.tool_call_id, stryMutAct_9fa48("880") ? `` : (stryCov_9fa48("880"), `${location}.tool_call_id`));
      }
    }
    if (stryMutAct_9fa48("883") ? raw.tool_calls === undefined : stryMutAct_9fa48("882") ? false : stryMutAct_9fa48("881") ? true : (stryCov_9fa48("881", "882", "883"), raw.tool_calls !== undefined)) {
      if (stryMutAct_9fa48("884")) {
        {}
      } else {
        stryCov_9fa48("884");
        if (stryMutAct_9fa48("887") ? false : stryMutAct_9fa48("886") ? true : stryMutAct_9fa48("885") ? Array.isArray(raw.tool_calls) : (stryCov_9fa48("885", "886", "887"), !Array.isArray(raw.tool_calls))) {
          if (stryMutAct_9fa48("888")) {
            {}
          } else {
            stryCov_9fa48("888");
            throw new ProviderValidationError(stryMutAct_9fa48("889") ? `` : (stryCov_9fa48("889"), `${location}.tool_calls must be an array`));
          }
        }
        normalized.tool_calls = raw.tool_calls.map(stryMutAct_9fa48("890") ? () => undefined : (stryCov_9fa48("890"), (entry, toolIndex) => normalizeToolCallValue(entry, stryMutAct_9fa48("891") ? `` : (stryCov_9fa48("891"), `${location}.tool_calls[${toolIndex}]`))));
      }
    }
    return deepFreeze(normalized);
  }
}
function normalizeMessages(raw: unknown): readonly Message[] {
  if (stryMutAct_9fa48("892")) {
    {}
  } else {
    stryCov_9fa48("892");
    if (stryMutAct_9fa48("895") ? false : stryMutAct_9fa48("894") ? true : stryMutAct_9fa48("893") ? Array.isArray(raw) : (stryCov_9fa48("893", "894", "895"), !Array.isArray(raw))) throw new ProviderValidationError(stryMutAct_9fa48("896") ? "" : (stryCov_9fa48("896"), 'messages must be an array'));
    return deepFreeze(raw.map(stryMutAct_9fa48("897") ? () => undefined : (stryCov_9fa48("897"), (entry, index) => normalizeMessage(entry, index))));
  }
}
function canonicalJson(value: JsonValue): string {
  if (stryMutAct_9fa48("898")) {
    {}
  } else {
    stryCov_9fa48("898");
    if (stryMutAct_9fa48("901") ? value === null && typeof value !== 'object' : stryMutAct_9fa48("900") ? false : stryMutAct_9fa48("899") ? true : (stryCov_9fa48("899", "900", "901"), (stryMutAct_9fa48("903") ? value !== null : stryMutAct_9fa48("902") ? false : (stryCov_9fa48("902", "903"), value === null)) || (stryMutAct_9fa48("905") ? typeof value === 'object' : stryMutAct_9fa48("904") ? false : (stryCov_9fa48("904", "905"), typeof value !== (stryMutAct_9fa48("906") ? "" : (stryCov_9fa48("906"), 'object')))))) return JSON.stringify(value);
    if (stryMutAct_9fa48("908") ? false : stryMutAct_9fa48("907") ? true : (stryCov_9fa48("907", "908"), Array.isArray(value))) return stryMutAct_9fa48("909") ? `` : (stryCov_9fa48("909"), `[${value.map(stryMutAct_9fa48("910") ? () => undefined : (stryCov_9fa48("910"), entry => canonicalJson(entry))).join(stryMutAct_9fa48("911") ? "" : (stryCov_9fa48("911"), ','))}]`);
    return stryMutAct_9fa48("912") ? `` : (stryCov_9fa48("912"), `{${stryMutAct_9fa48("913") ? Object.keys(value).map(key => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(',') : (stryCov_9fa48("913"), Object.keys(value).sort().map(stryMutAct_9fa48("914") ? () => undefined : (stryCov_9fa48("914"), key => stryMutAct_9fa48("915") ? `` : (stryCov_9fa48("915"), `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`))).join(stryMutAct_9fa48("916") ? "" : (stryCov_9fa48("916"), ',')))}}`);
  }
}
export function hashMessages(messages: readonly Message[]): string {
  if (stryMutAct_9fa48("917")) {
    {}
  } else {
    stryCov_9fa48("917");
    const normalized = normalizeMessages(messages);
    const canonical = canonicalJson(cloneJson(normalized, stryMutAct_9fa48("918") ? "" : (stryCov_9fa48("918"), 'messages')));
    return createHash(stryMutAct_9fa48("919") ? "" : (stryCov_9fa48("919"), 'sha256')).update(canonical).digest(stryMutAct_9fa48("920") ? "" : (stryCov_9fa48("920"), 'hex'));
  }
}
export const scriptedProviderContract = deepFreeze((stryMutAct_9fa48("921") ? {} : (stryCov_9fa48("921"), {
  provider_type: stryMutAct_9fa48("922") ? "" : (stryCov_9fa48("922"), 'scripted_test'),
  normalize_request: stryMutAct_9fa48("923") ? false : (stryCov_9fa48("923"), true),
  parse_response: stryMutAct_9fa48("924") ? false : (stryCov_9fa48("924"), true),
  normalize_tool_call: stryMutAct_9fa48("925") ? false : (stryCov_9fa48("925"), true),
  stream_events: stryMutAct_9fa48("926") ? false : (stryCov_9fa48("926"), true),
  map_error: stryMutAct_9fa48("927") ? false : (stryCov_9fa48("927"), true),
  meter_usage: stryMutAct_9fa48("928") ? false : (stryCov_9fa48("928"), true),
  check_health: stryMutAct_9fa48("929") ? false : (stryCov_9fa48("929"), true),
  validate_data_policy: stryMutAct_9fa48("930") ? false : (stryCov_9fa48("930"), true)
})) satisfies ProviderAdapterContract);
export interface ScriptedTestProviderOptions {
  readonly queue?: readonly ParsedResponse[];
  readonly map?: Readonly<Record<string, ParsedResponse>>;
  readonly dataPolicy?: DataPolicyResult;
  readonly model?: string;
  readonly now?: () => Date;
}
export class ScriptedTestProvider {
  readonly provider_type = 'scripted_test' as const;
  private readonly queue: ParsedResponse[];
  private readonly responsesByHash: ReadonlyMap<string, ParsedResponse>;
  private readonly dataPolicy: DataPolicyResult;
  private readonly model: string;
  private readonly now: () => Date;
  private readonly calls: CallMetadata[] = stryMutAct_9fa48("931") ? ["Stryker was here"] : (stryCov_9fa48("931"), []);
  private callIndex = 0;
  constructor(options: ScriptedTestProviderOptions = {}) {
    if (stryMutAct_9fa48("932")) {
      {}
    } else {
      stryCov_9fa48("932");
      this.model = nonEmptyString(stryMutAct_9fa48("933") ? options.model && 'scripted-test' : (stryCov_9fa48("933"), options.model ?? (stryMutAct_9fa48("934") ? "" : (stryCov_9fa48("934"), 'scripted-test'))), stryMutAct_9fa48("935") ? "" : (stryCov_9fa48("935"), 'model'));
      this.now = stryMutAct_9fa48("936") ? options.now && (() => new Date()) : (stryCov_9fa48("936"), options.now ?? (stryMutAct_9fa48("937") ? () => undefined : (stryCov_9fa48("937"), () => new Date())));
      this.dataPolicy = this.normalizeDataPolicy((stryMutAct_9fa48("940") ? options.dataPolicy !== undefined : stryMutAct_9fa48("939") ? false : stryMutAct_9fa48("938") ? true : (stryCov_9fa48("938", "939", "940"), options.dataPolicy === undefined)) ? stryMutAct_9fa48("941") ? {} : (stryCov_9fa48("941"), {
        allowed: stryMutAct_9fa48("942") ? false : (stryCov_9fa48("942"), true)
      }) : options.dataPolicy);
      this.queue = (stryMutAct_9fa48("943") ? options.queue && [] : (stryCov_9fa48("943"), options.queue ?? (stryMutAct_9fa48("944") ? ["Stryker was here"] : (stryCov_9fa48("944"), [])))).map(stryMutAct_9fa48("945") ? () => undefined : (stryCov_9fa48("945"), entry => this.parseResponse(entry)));
      const mapEntries = Object.entries(stryMutAct_9fa48("946") ? options.map && {} : (stryCov_9fa48("946"), options.map ?? {})).map(([key, entry]) => {
        if (stryMutAct_9fa48("947")) {
          {}
        } else {
          stryCov_9fa48("947");
          if (stryMutAct_9fa48("950") ? false : stryMutAct_9fa48("949") ? true : stryMutAct_9fa48("948") ? /^[0-9a-f]{64}$/u.test(key) : (stryCov_9fa48("948", "949", "950"), !(stryMutAct_9fa48("954") ? /^[^0-9a-f]{64}$/u : stryMutAct_9fa48("953") ? /^[0-9a-f]$/u : stryMutAct_9fa48("952") ? /^[0-9a-f]{64}/u : stryMutAct_9fa48("951") ? /[0-9a-f]{64}$/u : (stryCov_9fa48("951", "952", "953", "954"), /^[0-9a-f]{64}$/u)).test(key))) {
            if (stryMutAct_9fa48("955")) {
              {}
            } else {
              stryCov_9fa48("955");
              throw new ProviderValidationError(stryMutAct_9fa48("956") ? "" : (stryCov_9fa48("956"), 'response map keys must be lowercase SHA-256 hashes'));
            }
          }
          return [key, this.parseResponse(entry)] as const;
        }
      });
      this.responsesByHash = new Map(mapEntries);
    }
  }
  resolve(request: ProviderRequest): ParsedResponse {
    if (stryMutAct_9fa48("957")) {
      {}
    } else {
      stryCov_9fa48("957");
      const normalizedRequest = this.normalizeRequest(request) as Readonly<{
        messages: readonly Message[];
        tools: readonly ProviderTool[];
      }>;
      const key = hashMessages(normalizedRequest.messages);
      let response: ParsedResponse | undefined;
      let lookupMode: 'map' | 'queue';
      if (stryMutAct_9fa48("959") ? false : stryMutAct_9fa48("958") ? true : (stryCov_9fa48("958", "959"), this.responsesByHash.has(key))) {
        if (stryMutAct_9fa48("960")) {
          {}
        } else {
          stryCov_9fa48("960");
          response = this.responsesByHash.get(key);
          lookupMode = stryMutAct_9fa48("961") ? "" : (stryCov_9fa48("961"), 'map');
        }
      } else if (stryMutAct_9fa48("965") ? this.queue.length <= 0 : stryMutAct_9fa48("964") ? this.queue.length >= 0 : stryMutAct_9fa48("963") ? false : stryMutAct_9fa48("962") ? true : (stryCov_9fa48("962", "963", "964", "965"), this.queue.length > 0)) {
        if (stryMutAct_9fa48("966")) {
          {}
        } else {
          stryCov_9fa48("966");
          response = this.queue.shift();
          lookupMode = stryMutAct_9fa48("967") ? "" : (stryCov_9fa48("967"), 'queue');
        }
      } else if (stryMutAct_9fa48("971") ? this.responsesByHash.size <= 0 : stryMutAct_9fa48("970") ? this.responsesByHash.size >= 0 : stryMutAct_9fa48("969") ? false : stryMutAct_9fa48("968") ? true : (stryCov_9fa48("968", "969", "970", "971"), this.responsesByHash.size > 0)) {
        if (stryMutAct_9fa48("972")) {
          {}
        } else {
          stryCov_9fa48("972");
          throw new ScriptedResponseMissingError(key);
        }
      } else {
        if (stryMutAct_9fa48("973")) {
          {}
        } else {
          stryCov_9fa48("973");
          throw new ScriptedResponseExhaustedError();
        }
      }
      if (stryMutAct_9fa48("976") ? false : stryMutAct_9fa48("975") ? true : stryMutAct_9fa48("974") ? response : (stryCov_9fa48("974", "975", "976"), !response)) throw new ScriptedResponseExhaustedError();
      const timestamp = this.now();
      if (stryMutAct_9fa48("979") ? !(timestamp instanceof Date) && !Number.isFinite(timestamp.getTime()) : stryMutAct_9fa48("978") ? false : stryMutAct_9fa48("977") ? true : (stryCov_9fa48("977", "978", "979"), (stryMutAct_9fa48("980") ? timestamp instanceof Date : (stryCov_9fa48("980"), !(timestamp instanceof Date))) || (stryMutAct_9fa48("981") ? Number.isFinite(timestamp.getTime()) : (stryCov_9fa48("981"), !Number.isFinite(timestamp.getTime()))))) {
        if (stryMutAct_9fa48("982")) {
          {}
        } else {
          stryCov_9fa48("982");
          throw new ProviderValidationError(stryMutAct_9fa48("983") ? "" : (stryCov_9fa48("983"), 'clock must return a valid Date'));
        }
      }
      const usage = this.meterUsage(response);
      const metadata = deepFreeze((stryMutAct_9fa48("984") ? {} : (stryCov_9fa48("984"), {
        index: this.callIndex,
        timestamp: timestamp.toISOString(),
        messages: normalizedRequest.messages,
        tools_requested: deepFreeze(normalizedRequest.tools.map(stryMutAct_9fa48("985") ? () => undefined : (stryCov_9fa48("985"), tool => tool.name))),
        response,
        usage,
        lookup_mode: lookupMode
      })) satisfies CallMetadata);
      stryMutAct_9fa48("986") ? this.callIndex -= 1 : (stryCov_9fa48("986"), this.callIndex += 1);
      this.calls.push(metadata);
      return response;
    }
  }
  normalizeRequest(request: ProviderRequest): unknown {
    if (stryMutAct_9fa48("987")) {
      {}
    } else {
      stryCov_9fa48("987");
      if (stryMutAct_9fa48("990") ? false : stryMutAct_9fa48("989") ? true : stryMutAct_9fa48("988") ? isPlainRecord(request) : (stryCov_9fa48("988", "989", "990"), !isPlainRecord(request))) throw new ProviderValidationError(stryMutAct_9fa48("991") ? "" : (stryCov_9fa48("991"), 'request must be an object'));
      assertKnownKeys(request, stryMutAct_9fa48("992") ? [] : (stryCov_9fa48("992"), [stryMutAct_9fa48("993") ? "" : (stryCov_9fa48("993"), 'max_tokens'), stryMutAct_9fa48("994") ? "" : (stryCov_9fa48("994"), 'messages'), stryMutAct_9fa48("995") ? "" : (stryCov_9fa48("995"), 'model'), stryMutAct_9fa48("996") ? "" : (stryCov_9fa48("996"), 'temperature'), stryMutAct_9fa48("997") ? "" : (stryCov_9fa48("997"), 'tools')]), stryMutAct_9fa48("998") ? "" : (stryCov_9fa48("998"), 'request'));
      const messages = normalizeMessages(request.messages);
      if (stryMutAct_9fa48("1001") ? request.tools !== undefined || !Array.isArray(request.tools) : stryMutAct_9fa48("1000") ? false : stryMutAct_9fa48("999") ? true : (stryCov_9fa48("999", "1000", "1001"), (stryMutAct_9fa48("1003") ? request.tools === undefined : stryMutAct_9fa48("1002") ? true : (stryCov_9fa48("1002", "1003"), request.tools !== undefined)) && (stryMutAct_9fa48("1004") ? Array.isArray(request.tools) : (stryCov_9fa48("1004"), !Array.isArray(request.tools))))) {
        if (stryMutAct_9fa48("1005")) {
          {}
        } else {
          stryCov_9fa48("1005");
          throw new ProviderValidationError(stryMutAct_9fa48("1006") ? "" : (stryCov_9fa48("1006"), 'request.tools must be an array'));
        }
      }
      const tools = (stryMutAct_9fa48("1007") ? request.tools && [] : (stryCov_9fa48("1007"), request.tools ?? (stryMutAct_9fa48("1008") ? ["Stryker was here"] : (stryCov_9fa48("1008"), [])))).map((tool, index) => {
        if (stryMutAct_9fa48("1009")) {
          {}
        } else {
          stryCov_9fa48("1009");
          if (stryMutAct_9fa48("1012") ? false : stryMutAct_9fa48("1011") ? true : stryMutAct_9fa48("1010") ? isPlainRecord(tool) : (stryCov_9fa48("1010", "1011", "1012"), !isPlainRecord(tool))) {
            if (stryMutAct_9fa48("1013")) {
              {}
            } else {
              stryCov_9fa48("1013");
              throw new ProviderValidationError(stryMutAct_9fa48("1014") ? `` : (stryCov_9fa48("1014"), `request.tools[${index}] must be an object`));
            }
          }
          nonEmptyString(tool.name, stryMutAct_9fa48("1015") ? `` : (stryCov_9fa48("1015"), `request.tools[${index}].name`));
          return cloneAndFreeze(tool, `request.tools[${index}]`) as ProviderTool;
        }
      });
      const model = nonEmptyString(stryMutAct_9fa48("1016") ? request.model && this.model : (stryCov_9fa48("1016"), request.model ?? this.model), stryMutAct_9fa48("1017") ? "" : (stryCov_9fa48("1017"), 'request.model'));
      const temperature = stryMutAct_9fa48("1018") ? request.temperature && 0 : (stryCov_9fa48("1018"), request.temperature ?? 0);
      if (stryMutAct_9fa48("1021") ? (!Number.isFinite(temperature) || temperature < 0) && temperature > 2 : stryMutAct_9fa48("1020") ? false : stryMutAct_9fa48("1019") ? true : (stryCov_9fa48("1019", "1020", "1021"), (stryMutAct_9fa48("1023") ? !Number.isFinite(temperature) && temperature < 0 : stryMutAct_9fa48("1022") ? false : (stryCov_9fa48("1022", "1023"), (stryMutAct_9fa48("1024") ? Number.isFinite(temperature) : (stryCov_9fa48("1024"), !Number.isFinite(temperature))) || (stryMutAct_9fa48("1027") ? temperature >= 0 : stryMutAct_9fa48("1026") ? temperature <= 0 : stryMutAct_9fa48("1025") ? false : (stryCov_9fa48("1025", "1026", "1027"), temperature < 0)))) || (stryMutAct_9fa48("1030") ? temperature <= 2 : stryMutAct_9fa48("1029") ? temperature >= 2 : stryMutAct_9fa48("1028") ? false : (stryCov_9fa48("1028", "1029", "1030"), temperature > 2)))) {
        if (stryMutAct_9fa48("1031")) {
          {}
        } else {
          stryCov_9fa48("1031");
          throw new ProviderValidationError(stryMutAct_9fa48("1032") ? "" : (stryCov_9fa48("1032"), 'request.temperature must be between 0 and 2'));
        }
      }
      if (stryMutAct_9fa48("1035") ? request.max_tokens !== undefined || !Number.isSafeInteger(request.max_tokens) || request.max_tokens <= 0 : stryMutAct_9fa48("1034") ? false : stryMutAct_9fa48("1033") ? true : (stryCov_9fa48("1033", "1034", "1035"), (stryMutAct_9fa48("1037") ? request.max_tokens === undefined : stryMutAct_9fa48("1036") ? true : (stryCov_9fa48("1036", "1037"), request.max_tokens !== undefined)) && (stryMutAct_9fa48("1039") ? !Number.isSafeInteger(request.max_tokens) && request.max_tokens <= 0 : stryMutAct_9fa48("1038") ? true : (stryCov_9fa48("1038", "1039"), (stryMutAct_9fa48("1040") ? Number.isSafeInteger(request.max_tokens) : (stryCov_9fa48("1040"), !Number.isSafeInteger(request.max_tokens))) || (stryMutAct_9fa48("1043") ? request.max_tokens > 0 : stryMutAct_9fa48("1042") ? request.max_tokens < 0 : stryMutAct_9fa48("1041") ? false : (stryCov_9fa48("1041", "1042", "1043"), request.max_tokens <= 0)))))) {
        if (stryMutAct_9fa48("1044")) {
          {}
        } else {
          stryCov_9fa48("1044");
          throw new ProviderValidationError(stryMutAct_9fa48("1045") ? "" : (stryCov_9fa48("1045"), 'request.max_tokens must be a positive integer'));
        }
      }
      return deepFreeze(stryMutAct_9fa48("1046") ? {} : (stryCov_9fa48("1046"), {
        model,
        messages,
        tools: deepFreeze(tools),
        temperature,
        max_tokens: stryMutAct_9fa48("1047") ? request.max_tokens && null : (stryCov_9fa48("1047"), request.max_tokens ?? null)
      }));
    }
  }
  parseResponse(raw: unknown): ParsedResponse {
    if (stryMutAct_9fa48("1048")) {
      {}
    } else {
      stryCov_9fa48("1048");
      if (stryMutAct_9fa48("1051") ? false : stryMutAct_9fa48("1050") ? true : stryMutAct_9fa48("1049") ? isPlainRecord(raw) : (stryCov_9fa48("1049", "1050", "1051"), !isPlainRecord(raw))) throw new ProviderValidationError(stryMutAct_9fa48("1052") ? "" : (stryCov_9fa48("1052"), 'response must be an object'));
      assertKnownKeys(raw, stryMutAct_9fa48("1053") ? [] : (stryCov_9fa48("1053"), [stryMutAct_9fa48("1054") ? "" : (stryCov_9fa48("1054"), 'content'), stryMutAct_9fa48("1055") ? "" : (stryCov_9fa48("1055"), 'model'), stryMutAct_9fa48("1056") ? "" : (stryCov_9fa48("1056"), 'stop_reason'), stryMutAct_9fa48("1057") ? "" : (stryCov_9fa48("1057"), 'tool_calls'), stryMutAct_9fa48("1058") ? "" : (stryCov_9fa48("1058"), 'usage')]), stryMutAct_9fa48("1059") ? "" : (stryCov_9fa48("1059"), 'response'));
      if (stryMutAct_9fa48("1062") ? typeof raw.content === 'string' : stryMutAct_9fa48("1061") ? false : stryMutAct_9fa48("1060") ? true : (stryCov_9fa48("1060", "1061", "1062"), typeof raw.content !== (stryMutAct_9fa48("1063") ? "" : (stryCov_9fa48("1063"), 'string')))) {
        if (stryMutAct_9fa48("1064")) {
          {}
        } else {
          stryCov_9fa48("1064");
          throw new ProviderValidationError(stryMutAct_9fa48("1065") ? "" : (stryCov_9fa48("1065"), 'response.content must be a string'));
        }
      }
      const stopReason = stryMutAct_9fa48("1066") ? raw.stop_reason && 'stop' : (stryCov_9fa48("1066"), raw.stop_reason ?? (stryMutAct_9fa48("1067") ? "" : (stryCov_9fa48("1067"), 'stop')));
      if (stryMutAct_9fa48("1070") ? typeof stopReason !== 'string' && !['content_filter', 'length', 'stop', 'tool_use'].includes(stopReason) : stryMutAct_9fa48("1069") ? false : stryMutAct_9fa48("1068") ? true : (stryCov_9fa48("1068", "1069", "1070"), (stryMutAct_9fa48("1072") ? typeof stopReason === 'string' : stryMutAct_9fa48("1071") ? false : (stryCov_9fa48("1071", "1072"), typeof stopReason !== (stryMutAct_9fa48("1073") ? "" : (stryCov_9fa48("1073"), 'string')))) || (stryMutAct_9fa48("1074") ? ['content_filter', 'length', 'stop', 'tool_use'].includes(stopReason) : (stryCov_9fa48("1074"), !(stryMutAct_9fa48("1075") ? [] : (stryCov_9fa48("1075"), [stryMutAct_9fa48("1076") ? "" : (stryCov_9fa48("1076"), 'content_filter'), stryMutAct_9fa48("1077") ? "" : (stryCov_9fa48("1077"), 'length'), stryMutAct_9fa48("1078") ? "" : (stryCov_9fa48("1078"), 'stop'), stryMutAct_9fa48("1079") ? "" : (stryCov_9fa48("1079"), 'tool_use')])).includes(stopReason))))) {
        if (stryMutAct_9fa48("1080")) {
          {}
        } else {
          stryCov_9fa48("1080");
          throw new ProviderValidationError(stryMutAct_9fa48("1081") ? "" : (stryCov_9fa48("1081"), 'response.stop_reason is unsupported'));
        }
      }
      if (stryMutAct_9fa48("1084") ? raw.tool_calls !== undefined || !Array.isArray(raw.tool_calls) : stryMutAct_9fa48("1083") ? false : stryMutAct_9fa48("1082") ? true : (stryCov_9fa48("1082", "1083", "1084"), (stryMutAct_9fa48("1086") ? raw.tool_calls === undefined : stryMutAct_9fa48("1085") ? true : (stryCov_9fa48("1085", "1086"), raw.tool_calls !== undefined)) && (stryMutAct_9fa48("1087") ? Array.isArray(raw.tool_calls) : (stryCov_9fa48("1087"), !Array.isArray(raw.tool_calls))))) {
        if (stryMutAct_9fa48("1088")) {
          {}
        } else {
          stryCov_9fa48("1088");
          throw new ProviderValidationError(stryMutAct_9fa48("1089") ? "" : (stryCov_9fa48("1089"), 'response.tool_calls must be an array'));
        }
      }
      const normalized: {
        content: string;
        tool_calls?: ToolCall[];
        stop_reason: NonNullable<ParsedResponse['stop_reason']>;
        usage?: Usage;
        model: string;
      } = stryMutAct_9fa48("1090") ? {} : (stryCov_9fa48("1090"), {
        content: raw.content,
        stop_reason: stopReason as NonNullable<ParsedResponse['stop_reason']>,
        model: nonEmptyString(stryMutAct_9fa48("1091") ? raw.model && this.model : (stryCov_9fa48("1091"), raw.model ?? this.model), stryMutAct_9fa48("1092") ? "" : (stryCov_9fa48("1092"), 'response.model'))
      });
      if (stryMutAct_9fa48("1095") ? raw.tool_calls === undefined : stryMutAct_9fa48("1094") ? false : stryMutAct_9fa48("1093") ? true : (stryCov_9fa48("1093", "1094", "1095"), raw.tool_calls !== undefined)) {
        if (stryMutAct_9fa48("1096")) {
          {}
        } else {
          stryCov_9fa48("1096");
          normalized.tool_calls = raw.tool_calls.map(stryMutAct_9fa48("1097") ? () => undefined : (stryCov_9fa48("1097"), (entry, index) => normalizeToolCallValue(entry, stryMutAct_9fa48("1098") ? `` : (stryCov_9fa48("1098"), `response.tool_calls[${index}]`))));
        }
      }
      if (stryMutAct_9fa48("1101") ? raw.usage === undefined : stryMutAct_9fa48("1100") ? false : stryMutAct_9fa48("1099") ? true : (stryCov_9fa48("1099", "1100", "1101"), raw.usage !== undefined)) normalized.usage = normalizeUsage(raw.usage);
      return deepFreeze(normalized);
    }
  }
  normalizeToolCall(raw: unknown): ToolCall {
    if (stryMutAct_9fa48("1102")) {
      {}
    } else {
      stryCov_9fa48("1102");
      return normalizeToolCallValue(raw);
    }
  }
  async *streamEvents(request: ProviderRequest): AsyncIterable<StreamEvent> {
    if (stryMutAct_9fa48("1103")) {
      {}
    } else {
      stryCov_9fa48("1103");
      const response = this.resolve(request);
      if (stryMutAct_9fa48("1107") ? response.content.length <= 0 : stryMutAct_9fa48("1106") ? response.content.length >= 0 : stryMutAct_9fa48("1105") ? false : stryMutAct_9fa48("1104") ? true : (stryCov_9fa48("1104", "1105", "1106", "1107"), response.content.length > 0)) yield stryMutAct_9fa48("1108") ? {} : (stryCov_9fa48("1108"), {
        type: stryMutAct_9fa48("1109") ? "" : (stryCov_9fa48("1109"), 'text_delta'),
        text: response.content
      });
      for (const toolCall of stryMutAct_9fa48("1110") ? response.tool_calls && [] : (stryCov_9fa48("1110"), response.tool_calls ?? (stryMutAct_9fa48("1111") ? ["Stryker was here"] : (stryCov_9fa48("1111"), [])))) {
        if (stryMutAct_9fa48("1112")) {
          {}
        } else {
          stryCov_9fa48("1112");
          yield stryMutAct_9fa48("1113") ? {} : (stryCov_9fa48("1113"), {
            type: stryMutAct_9fa48("1114") ? "" : (stryCov_9fa48("1114"), 'tool_call'),
            tool_call: toolCall
          });
        }
      }
      yield stryMutAct_9fa48("1115") ? {} : (stryCov_9fa48("1115"), {
        type: stryMutAct_9fa48("1116") ? "" : (stryCov_9fa48("1116"), 'message_stop'),
        stop_reason: stryMutAct_9fa48("1117") ? response.stop_reason && 'stop' : (stryCov_9fa48("1117"), response.stop_reason ?? (stryMutAct_9fa48("1118") ? "" : (stryCov_9fa48("1118"), 'stop'))),
        usage: this.meterUsage(response)
      });
    }
  }
  mapError(raw: unknown): ProviderError {
    if (stryMutAct_9fa48("1119")) {
      {}
    } else {
      stryCov_9fa48("1119");
      if (stryMutAct_9fa48("1122") ? (raw instanceof ProviderValidationError || raw instanceof ScriptedResponseExhaustedError) && raw instanceof ScriptedResponseMissingError : stryMutAct_9fa48("1121") ? false : stryMutAct_9fa48("1120") ? true : (stryCov_9fa48("1120", "1121", "1122"), (stryMutAct_9fa48("1124") ? raw instanceof ProviderValidationError && raw instanceof ScriptedResponseExhaustedError : stryMutAct_9fa48("1123") ? false : (stryCov_9fa48("1123", "1124"), raw instanceof ProviderValidationError || raw instanceof ScriptedResponseExhaustedError)) || raw instanceof ScriptedResponseMissingError)) {
        if (stryMutAct_9fa48("1125")) {
          {}
        } else {
          stryCov_9fa48("1125");
          return deepFreeze(stryMutAct_9fa48("1126") ? {} : (stryCov_9fa48("1126"), {
            kind: stryMutAct_9fa48("1127") ? "" : (stryCov_9fa48("1127"), 'invalid_request'),
            retryable: stryMutAct_9fa48("1128") ? true : (stryCov_9fa48("1128"), false),
            detail: raw.message
          }));
        }
      }
      if (stryMutAct_9fa48("1130") ? false : stryMutAct_9fa48("1129") ? true : (stryCov_9fa48("1129", "1130"), raw instanceof ProviderTimeoutError)) {
        if (stryMutAct_9fa48("1131")) {
          {}
        } else {
          stryCov_9fa48("1131");
          return deepFreeze(stryMutAct_9fa48("1132") ? {} : (stryCov_9fa48("1132"), {
            kind: stryMutAct_9fa48("1133") ? "" : (stryCov_9fa48("1133"), 'timeout'),
            retryable: stryMutAct_9fa48("1134") ? false : (stryCov_9fa48("1134"), true),
            detail: stryMutAct_9fa48("1135") ? "" : (stryCov_9fa48("1135"), 'Provider request timed out')
          }));
        }
      }
      if (stryMutAct_9fa48("1137") ? false : stryMutAct_9fa48("1136") ? true : (stryCov_9fa48("1136", "1137"), raw instanceof ProviderHttpError)) {
        if (stryMutAct_9fa48("1138")) {
          {}
        } else {
          stryCov_9fa48("1138");
          const status = raw.status;
          if (stryMutAct_9fa48("1141") ? status === 401 && status === 403 : stryMutAct_9fa48("1140") ? false : stryMutAct_9fa48("1139") ? true : (stryCov_9fa48("1139", "1140", "1141"), (stryMutAct_9fa48("1143") ? status !== 401 : stryMutAct_9fa48("1142") ? false : (stryCov_9fa48("1142", "1143"), status === 401)) || (stryMutAct_9fa48("1145") ? status !== 403 : stryMutAct_9fa48("1144") ? false : (stryCov_9fa48("1144", "1145"), status === 403)))) {
            if (stryMutAct_9fa48("1146")) {
              {}
            } else {
              stryCov_9fa48("1146");
              return deepFreeze(stryMutAct_9fa48("1147") ? {} : (stryCov_9fa48("1147"), {
                kind: stryMutAct_9fa48("1148") ? "" : (stryCov_9fa48("1148"), 'auth'),
                retryable: stryMutAct_9fa48("1149") ? true : (stryCov_9fa48("1149"), false),
                detail: stryMutAct_9fa48("1150") ? "" : (stryCov_9fa48("1150"), 'Provider authentication failed'),
                status
              }));
            }
          }
          if (stryMutAct_9fa48("1153") ? status !== 408 : stryMutAct_9fa48("1152") ? false : stryMutAct_9fa48("1151") ? true : (stryCov_9fa48("1151", "1152", "1153"), status === 408)) {
            if (stryMutAct_9fa48("1154")) {
              {}
            } else {
              stryCov_9fa48("1154");
              return deepFreeze(stryMutAct_9fa48("1155") ? {} : (stryCov_9fa48("1155"), {
                kind: stryMutAct_9fa48("1156") ? "" : (stryCov_9fa48("1156"), 'timeout'),
                retryable: stryMutAct_9fa48("1157") ? false : (stryCov_9fa48("1157"), true),
                detail: stryMutAct_9fa48("1158") ? "" : (stryCov_9fa48("1158"), 'Provider request timed out'),
                status
              }));
            }
          }
          if (stryMutAct_9fa48("1161") ? status !== 429 : stryMutAct_9fa48("1160") ? false : stryMutAct_9fa48("1159") ? true : (stryCov_9fa48("1159", "1160", "1161"), status === 429)) {
            if (stryMutAct_9fa48("1162")) {
              {}
            } else {
              stryCov_9fa48("1162");
              return deepFreeze(stryMutAct_9fa48("1163") ? {} : (stryCov_9fa48("1163"), {
                kind: stryMutAct_9fa48("1164") ? "" : (stryCov_9fa48("1164"), 'rate_limited'),
                retryable: stryMutAct_9fa48("1165") ? false : (stryCov_9fa48("1165"), true),
                detail: stryMutAct_9fa48("1166") ? "" : (stryCov_9fa48("1166"), 'Provider rate limit exceeded'),
                status
              }));
            }
          }
          if (stryMutAct_9fa48("1170") ? status < 500 : stryMutAct_9fa48("1169") ? status > 500 : stryMutAct_9fa48("1168") ? false : stryMutAct_9fa48("1167") ? true : (stryCov_9fa48("1167", "1168", "1169", "1170"), status >= 500)) {
            if (stryMutAct_9fa48("1171")) {
              {}
            } else {
              stryCov_9fa48("1171");
              return deepFreeze(stryMutAct_9fa48("1172") ? {} : (stryCov_9fa48("1172"), {
                kind: stryMutAct_9fa48("1173") ? "" : (stryCov_9fa48("1173"), 'server'),
                retryable: stryMutAct_9fa48("1174") ? false : (stryCov_9fa48("1174"), true),
                detail: stryMutAct_9fa48("1175") ? `` : (stryCov_9fa48("1175"), `Provider server error (${status})`),
                status
              }));
            }
          }
          if (stryMutAct_9fa48("1179") ? status < 400 : stryMutAct_9fa48("1178") ? status > 400 : stryMutAct_9fa48("1177") ? false : stryMutAct_9fa48("1176") ? true : (stryCov_9fa48("1176", "1177", "1178", "1179"), status >= 400)) {
            if (stryMutAct_9fa48("1180")) {
              {}
            } else {
              stryCov_9fa48("1180");
              return deepFreeze(stryMutAct_9fa48("1181") ? {} : (stryCov_9fa48("1181"), {
                kind: stryMutAct_9fa48("1182") ? "" : (stryCov_9fa48("1182"), 'invalid_request'),
                retryable: stryMutAct_9fa48("1183") ? true : (stryCov_9fa48("1183"), false),
                detail: stryMutAct_9fa48("1184") ? `` : (stryCov_9fa48("1184"), `Provider rejected request (${status})`),
                status
              }));
            }
          }
          return deepFreeze(stryMutAct_9fa48("1185") ? {} : (stryCov_9fa48("1185"), {
            kind: stryMutAct_9fa48("1186") ? "" : (stryCov_9fa48("1186"), 'unknown'),
            retryable: stryMutAct_9fa48("1187") ? true : (stryCov_9fa48("1187"), false),
            detail: stryMutAct_9fa48("1188") ? `` : (stryCov_9fa48("1188"), `Unexpected provider HTTP status (${status})`),
            status
          }));
        }
      }
      return deepFreeze(stryMutAct_9fa48("1189") ? {} : (stryCov_9fa48("1189"), {
        kind: stryMutAct_9fa48("1190") ? "" : (stryCov_9fa48("1190"), 'unknown'),
        retryable: stryMutAct_9fa48("1191") ? true : (stryCov_9fa48("1191"), false),
        detail: stryMutAct_9fa48("1192") ? "" : (stryCov_9fa48("1192"), 'Unknown provider failure')
      }));
    }
  }
  meterUsage(response: ParsedResponse): Usage {
    if (stryMutAct_9fa48("1193")) {
      {}
    } else {
      stryCov_9fa48("1193");
      return (stryMutAct_9fa48("1196") ? response.usage !== undefined : stryMutAct_9fa48("1195") ? false : stryMutAct_9fa48("1194") ? true : (stryCov_9fa48("1194", "1195", "1196"), response.usage === undefined)) ? deepFreeze(stryMutAct_9fa48("1197") ? {} : (stryCov_9fa48("1197"), {
        input_tokens: 0,
        output_tokens: 0
      })) : normalizeUsage(response.usage);
    }
  }
  checkHealth(): HealthStatus {
    if (stryMutAct_9fa48("1198")) {
      {}
    } else {
      stryCov_9fa48("1198");
      return stryMutAct_9fa48("1199") ? "" : (stryCov_9fa48("1199"), 'healthy');
    }
  }
  validateDataPolicy(_request: ProviderRequest): DataPolicyResult {
    if (stryMutAct_9fa48("1200")) {
      {}
    } else {
      stryCov_9fa48("1200");
      return this.dataPolicy;
    }
  }
  get callLog(): readonly CallMetadata[] {
    if (stryMutAct_9fa48("1201")) {
      {}
    } else {
      stryCov_9fa48("1201");
      return deepFreeze(stryMutAct_9fa48("1202") ? [] : (stryCov_9fa48("1202"), [...this.calls]));
    }
  }
  get callCount(): number {
    if (stryMutAct_9fa48("1203")) {
      {}
    } else {
      stryCov_9fa48("1203");
      return this.calls.length;
    }
  }
  get remainingQueueLength(): number {
    if (stryMutAct_9fa48("1204")) {
      {}
    } else {
      stryCov_9fa48("1204");
      return this.queue.length;
    }
  }
  private normalizeDataPolicy(raw: unknown): DataPolicyResult {
    if (stryMutAct_9fa48("1205")) {
      {}
    } else {
      stryCov_9fa48("1205");
      if (stryMutAct_9fa48("1208") ? false : stryMutAct_9fa48("1207") ? true : stryMutAct_9fa48("1206") ? isPlainRecord(raw) : (stryCov_9fa48("1206", "1207", "1208"), !isPlainRecord(raw))) throw new ProviderValidationError(stryMutAct_9fa48("1209") ? "" : (stryCov_9fa48("1209"), 'dataPolicy must be an object'));
      assertKnownKeys(raw, stryMutAct_9fa48("1210") ? [] : (stryCov_9fa48("1210"), [stryMutAct_9fa48("1211") ? "" : (stryCov_9fa48("1211"), 'allowed'), stryMutAct_9fa48("1212") ? "" : (stryCov_9fa48("1212"), 'reason')]), stryMutAct_9fa48("1213") ? "" : (stryCov_9fa48("1213"), 'dataPolicy'));
      if (stryMutAct_9fa48("1216") ? typeof raw.allowed === 'boolean' : stryMutAct_9fa48("1215") ? false : stryMutAct_9fa48("1214") ? true : (stryCov_9fa48("1214", "1215", "1216"), typeof raw.allowed !== (stryMutAct_9fa48("1217") ? "" : (stryCov_9fa48("1217"), 'boolean')))) {
        if (stryMutAct_9fa48("1218")) {
          {}
        } else {
          stryCov_9fa48("1218");
          throw new ProviderValidationError(stryMutAct_9fa48("1219") ? "" : (stryCov_9fa48("1219"), 'dataPolicy.allowed must be a boolean'));
        }
      }
      if (stryMutAct_9fa48("1222") ? raw.reason !== undefined || typeof raw.reason !== 'string' : stryMutAct_9fa48("1221") ? false : stryMutAct_9fa48("1220") ? true : (stryCov_9fa48("1220", "1221", "1222"), (stryMutAct_9fa48("1224") ? raw.reason === undefined : stryMutAct_9fa48("1223") ? true : (stryCov_9fa48("1223", "1224"), raw.reason !== undefined)) && (stryMutAct_9fa48("1226") ? typeof raw.reason === 'string' : stryMutAct_9fa48("1225") ? true : (stryCov_9fa48("1225", "1226"), typeof raw.reason !== (stryMutAct_9fa48("1227") ? "" : (stryCov_9fa48("1227"), 'string')))))) {
        if (stryMutAct_9fa48("1228")) {
          {}
        } else {
          stryCov_9fa48("1228");
          throw new ProviderValidationError(stryMutAct_9fa48("1229") ? "" : (stryCov_9fa48("1229"), 'dataPolicy.reason must be a string'));
        }
      }
      return deepFreeze((stryMutAct_9fa48("1232") ? raw.reason !== undefined : stryMutAct_9fa48("1231") ? false : stryMutAct_9fa48("1230") ? true : (stryCov_9fa48("1230", "1231", "1232"), raw.reason === undefined)) ? stryMutAct_9fa48("1233") ? {} : (stryCov_9fa48("1233"), {
        allowed: raw.allowed
      }) : stryMutAct_9fa48("1234") ? {} : (stryCov_9fa48("1234"), {
        allowed: raw.allowed,
        reason: raw.reason
      }));
    }
  }
}