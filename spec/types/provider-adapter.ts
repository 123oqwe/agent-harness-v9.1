 /* eslint-disable */
 /**
  * Generated from spec/contracts/provider-adapter.schema.json
  * Do not modify by hand. Modify the JSON Schema and regenerate.
  */
 
 export type ProviderType = "openai" | "anthropic" | "google" | "local" | "scripted_test";
 
 /**
  * Contract for model provider adapters.
  * Real providers and ScriptedTestProvider must implement this interface.
  */
 export interface ProviderAdapter {
   provider_type: ProviderType;
   normalize_request: boolean;
   parse_response: boolean;
   normalize_tool_call: boolean;
   stream_events: boolean;
   map_error: boolean;
   meter_usage: boolean;
   check_health: boolean;
   validate_data_policy: boolean;
   fallback_compatibility_checker?: boolean;
   rate_limiter?: boolean;
   circuit_breaker?: boolean;
 }
