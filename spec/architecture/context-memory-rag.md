# Context, Memory & RAG


![05-context-topologies.svg](diagrams/05-context-topologies.svg)

## Context Window Layout (7 layers)
- system/policy: ~8K (cached, immutable)
- task: ~4K
- active plan: ~2K
- recent conversation: ~80K (cached prefix)
- retrieved evidence: ~20K (RAG, tool outputs)
- tool definitions: ~4K (cached)
- tool results: ~30K
- memory: ~5K
- reserved output: ~4K

Rule: Low-trust content (tool output, RAG, web) must be isolated from system/policy.

## Compaction (v9 correction)
Must preserve: goals, constraints, decisions, approvals, real-world side effects, open tasks, relationship commitments, provenance, risk state, file changes.
Security state NOT compressed by generic LLM summary - preserved exactly.
Key fact recall >= 0.95, constraint preservation = 1.0.

## Memory Types
episodic, semantic, procedural, preference, relationship, goal.
Each: conflict resolution, TTL, weight, deletion.
Model must NOT directly write chat conclusions as high-trust facts.

## RAG
5 subsystems: ingest, index, retrieve, rerank, pack.
ACL filter BEFORE retrieval. No cross-tenant vector cache.
