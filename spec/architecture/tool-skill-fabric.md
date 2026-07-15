# Tool & Skill Fabric


![09-tool-skill-catalog.svg](diagrams/09-tool-skill-catalog.svg)

## ToolSpec (v9 expanded from v8 ToolDefinition)
Every tool must have: schemas, effects, risk_feature_extractor, preconditions, postconditions, timeout, cancellation, retry, idempotency, sandbox, network, credentials, data_egress, receipt, verification, reconciliation, compensation, tests, maturity, certification.

Only production_certified tools enter production Registry.

## Phase 1 Tools (9, reduced from v8's 20)
read_file, list_directory, search_files, write_file, edit_file, execute_command_sandboxed, parse_document, create_artifact, ask_user

run_tests is a controlled execute_command profile, NOT a separate tool.

## Tool Transport (4 types)
Native (in-process), CLI Wrapper (subprocess), MCP (JSON-RPC), HTTP API

## SkillSpec
Must include: input/output schema, required context, required tools, allowed effect classes, workflow template, verification template, failure policy, risk ceiling, eval suite.
Skill can only SUGGEST tool grants. Policy decides.

## Generated Tools
ALWAYS: untrusted, sandbox-only, no secrets, no external writes, network denied by default, manual publication required. Success count does NOT auto-promote to trusted.


## Implementation Notes

### ToolSpec Implementation

```typescript
interface ToolImplementation {
  spec: ToolSpec;
  execute(input: ToolInput, ctx: ExecutionContext): Promise<ToolOutput>;
}
```

### Phase 1 Tools (9, reduced from v8's 20)

| Tool | Transport | Effect | Risk | Source File |
|------|-----------|--------|------|-------------|
| read_file | native | read_only | T0 | harness/tools/read_file.ts |
| list_directory | native | read_only | T0 | harness/tools/list_directory.ts |
| search_files | native | read_only | T0 | harness/tools/search_files.ts |
| write_file | native | idempotent_write | T1 | harness/tools/write_file.ts |
| edit_file | native | idempotent_write | T1 | harness/tools/edit_file.ts |
| execute_command_sandboxed | cli_wrapper | non_idempotent | T2 | harness/tools/execute_command.ts |
| parse_document | native | read_only | T0 | harness/ingestion/parse_document.ts |
| create_artifact | native | idempotent_write | T1 | harness/tools/create_artifact.ts |
| ask_user | native | pure | T0 | harness/tools/ask_user.ts |

`run_tests` is a controlled `execute_command` profile, not a separate tool.

### Generated Tools
Always: untrusted, sandbox-only, no secrets, no external write, network denied by default.
Trust pipeline: untrusted → verified (10+ uses, 80% success) → trusted (50+ uses, 90% success, human review) → builtin.
Agent should NOT auto-promote. Success count does not equal trust.
