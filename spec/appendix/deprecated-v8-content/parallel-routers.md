# Deprecated v8 Content

## Source File
Agent-Harness-v8-PRD.html

## Source Section
Section 14: Routing & Orchestration

## Original Text
8 independent routers executed with Promise.all

## Reason for Deprecation
Replaced with dependency-aware Router DAG

## Replacement Requirement IDs
AH-ROUTER-DAG-001

## Migration Notes
Sequential pipeline, not parallel. Each stage depends on previous.
