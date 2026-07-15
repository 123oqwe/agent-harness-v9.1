# Model/API Gateway


![06-model-api-gateway.svg](diagrams/06-model-api-gateway.svg)

## Capability Registry (expanded for all domains)
text_reasoning, code, long_context, structured_output, tool_calling, vision_understanding, pdf_document_understanding, image_generation, image_editing, audio_understanding, speech_generation, video_understanding, video_generation, embedding, reranking, local_execution, data_region, data_retention, pricing, health_state

## Provider Adapter Must Implement
request_normalizer, structured_output_handler, tool_call_normalizer, response_parser, streaming_event_handler, error_mapper, usage_meter, rate_limiter, circuit_breaker, health_checker, data_policy_validator, fallback_compatibility_checker

## Model Switch Must Re-validate
- Context length
- Tool definitions serialization
- Data policy
- Structured output format
- Plan compatibility

## Multi-Model Workflow Examples
PDF Research: document model -> reasoning -> reranker -> writing -> verifier
Image Task: reasoning -> image gen -> vision verify


## Implementation Notes

### Provider Adapter Interface

```typescript
interface ProviderAdapter {
  normalizeRequest(messages: Message[], tools: ToolDef[], config: ModelConfig): NormalizedRequest;
  parseResponse(raw: any): ParsedResponse;
  normalizeToolCall(raw: any): NormalizedToolCall;
  streamEvents(raw: Stream): AsyncGenerator<StreamEvent>;
  mapError(error: any): MappedError;
  meterUsage(raw: any): UsageMetrics;
  checkHealth(): Promise<HealthStatus>;
  validateDataPolicy(policy: ProviderPolicy): boolean;
}
```

### Model Switch Re-validation Checklist
When switching from model A to model B:
1. Re-validate context length (B.max_context >= current_tokens)
2. Re-serialize tool definitions (B may use different tool format)
3. Re-validate data policy (B.provider must satisfy ProviderPolicy)
4. Re-compile structured output format (B may use different JSON mode)
5. Re-validate plan compatibility (B must support required capabilities)

### Fallback Chain
```
primary → fallback_1 → fallback_2 → local_model → cascade_failure_handler
```
- Cannot fallback back to primary (prevents loops)
- Each fallback re-runs the re-validation checklist
- Cascade failure: durable pause + notify user + retry every 5 min (agent-tunable)

### Multi-Model Workflow
Agent should implement as a DAG of model calls, not a sequence. Each node specifies which model capability is needed. The Gateway resolves to a specific provider+model.
