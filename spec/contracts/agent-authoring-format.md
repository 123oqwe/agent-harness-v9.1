# Agent Authoring Format (G-PI1)

## Format
An agent is authored as a Markdown file with YAML frontmatter. The file compiles to an AgentGraph node (`agent-graph.schema.json`).

## File structure
```
---
agent_id: researcher-001
role: specialist
model_binding_ref: default-claude
budget_ceiling:
  token_limit: "100000"
  usd_micros: "500000"
isolation: worktree          # G-CC1
memory_scope: isolated       # G-CC1
effort: high                 # G-CC1
tool_grant_refs: [read_file, web_search, web_fetch]
disallowed_tool_refs: [execute_command_sandboxed]  # G-CC1
skill_binding_refs: [research-skill]
hooks_ref: null              # inherit parent
---
# Body = system prompt for this agent

You are a research specialist. Your job is to:
1. Search multiple sources
2. Cross-reference claims
3. Report conflicts
```

## Compilation
`compileAgent(md_path) -> AgentGraphNode`:
1. Parse YAML frontmatter → node fields (validate against `agent-graph.schema.json`)
2. Body markdown → system_prompt (stored in ModelBinding.system_prompt_ref)
3. Validate: required node fields present; tool_grant_refs valid; disallowed_tool_refs deny wins

## Directory
Agent md files in `agents/` (project-level) or `~/.harness/agents/` (global). Router discovers agents by scanning these directories.

## Relationship to SkillSpec
- SkillSpec defines a reusable capability (workflow + verification template).
- Agent md defines a specific agent instance (model + tools + system prompt).
- An agent references skills via `skill_binding_refs`. A skill is not an agent; an agent uses skills.
