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
