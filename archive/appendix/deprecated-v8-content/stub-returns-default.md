# Deprecated v8 Content

## Source File
Agent-Harness-v8-PRD.html

## Source Section
Part 0: Implementation Directive

## Original Text
stub = function exists, returns default, doesn't call logic

## Reason for Deprecation
Replaced with NotImplementedError + active-path stub scan

## Replacement Requirement IDs
N/A (specification-level change)

## Migration Notes
Stub must throw with requirement_id. Active path must have 0 stubs.
