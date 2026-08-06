/* eslint-disable */
/** AUTO-GENERATED from spec/contracts/provider-adapter.schema.json. Do not modify by hand. */

/**
 * Contract for model provider adapters. Real providers and ScriptedTestProvider must implement this interface.
 */
export interface ProviderAdapter {
  provider_type: "openai" | "anthropic" | "google" | "local" | "scripted_test" | "deepseek" | "qwen" | "doubao" | "ollama" | "vllm";
  /**
   * Transforms internal request to provider-specific format
   */
  normalize_request: boolean;
  /**
   * Parses provider response into internal ParsedResponse
   */
  parse_response: boolean;
  /**
   * Normalizes tool call format across providers
   */
  normalize_tool_call: boolean;
  /**
   * Handles streaming event protocol
   */
  stream_events: boolean;
  /**
   * Maps provider errors to internal error taxonomy
   */
  map_error: boolean;
  /**
   * Tracks token usage and cost
   */
  meter_usage: boolean;
  /**
   * Returns provider health status
   */
  check_health: boolean;
  /**
   * Validates request against data policy (region, retention)
   */
  validate_data_policy: boolean;
  /**
   * Checks if fallback provider is compatible
   */
  fallback_compatibility_checker?: boolean;
  /**
   * Rate limiting support
   */
  rate_limiter?: boolean;
  /**
   * Circuit breaker support
   */
  circuit_breaker?: boolean;
}
