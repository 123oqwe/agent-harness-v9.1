#!/usr/bin/env node

/**
 * Deterministic generator for evals/routing/dataset.json (AH-ROUTER-EVAL-001).
 *
 * The dataset is committed so the eval always scores the frozen corpus. This
 * script exists only to make regeneration reproducible — it must stay
 * deterministic (no Date.now, no Math.random). The annotations encode the
 * DESIRED routing behavior (allowed/forbidden routes, hard constraints,
 * preferred order); the eval in evals/routing/eval.ts scores the real
 * router/pipeline.ts against them.
 *
 * Route vocabulary (emitted by the deterministic Router DAG):
 *   static_dag/single         — execution_mode=static_dag, 1 agent
 *   routing_slip/single       — execution_mode=routing_slip, 1 agent
 *   workflow_script/multi     — execution_mode=workflow_script, N>=2 agents
 *
 * Hard-constraint tokens (interpreted by the eval):
 *   single_agent / multi_agent
 *   execution_static_dag | execution_routing_slip | execution_workflow_script
 *   no_routing_slip / no_workflow_script
 *   budget_usd_micros_le_1000000
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DET = { criterion: "completed without error", verification_method: "deterministic" };
const detCriteria = (count) =>
  Array.from({ length: count }, (_, i) => ({
    criterion: `criterion ${i + 1} completed`,
    verification_method: "deterministic",
  }));

const BUDGET_CONSTRAINT = [{ type: "budget", value: "250000" }];

// Shared per-category annotation defaults.
const SINGLE_CODE = {
  allowed_routes: ["static_dag/single", "routing_slip/single"],
  forbidden_routes: ["workflow_script/multi"],
  hard_constraints: ["single_agent", "no_workflow_script", "budget_usd_micros_le_1000000"],
  preferred_order: ["static_dag/single"],
  single_agent_sufficient: true,
};
const OPEN_ENDED = {
  allowed_routes: ["routing_slip/single"],
  forbidden_routes: ["workflow_script/multi"],
  hard_constraints: ["single_agent", "no_workflow_script", "execution_routing_slip"],
  preferred_order: ["routing_slip/single"],
  single_agent_sufficient: true,
};
const MULTI_AGENT = {
  allowed_routes: ["workflow_script/multi"],
  forbidden_routes: ["static_dag/single", "routing_slip/single"],
  hard_constraints: ["multi_agent", "execution_workflow_script"],
  preferred_order: ["workflow_script/multi"],
  single_agent_sufficient: false,
};
const PROHIBITION = {
  allowed_routes: ["static_dag/single", "routing_slip/single"],
  forbidden_routes: ["workflow_script/multi"],
  hard_constraints: ["single_agent", "no_workflow_script"],
  preferred_order: ["static_dag/single"],
  single_agent_sufficient: true,
};
const REGRET = {
  allowed_routes: ["routing_slip/single", "static_dag/single"],
  forbidden_routes: ["workflow_script/multi"],
  hard_constraints: ["single_agent", "no_workflow_script"],
  preferred_order: ["routing_slip/single", "static_dag/single"],
  single_agent_sufficient: true,
};

const tasks = [];
let n = 0;
const nextId = () => `routing-${String(++n).padStart(4, "0")}`;

function add(category, meta, goals, overrides = {}) {
  for (const goal of goals) {
    const budget = meta.hard_constraints.includes("budget_usd_micros_le_1000000");
    tasks.push({
      id: nextId(),
      category,
      goal,
      success_criteria: overrides.success_criteria ?? [DET],
      constraints: budget ? BUDGET_CONSTRAINT : [],
      allowed_routes: overrides.allowed_routes ?? meta.allowed_routes,
      forbidden_routes: overrides.forbidden_routes ?? meta.forbidden_routes,
      hard_constraints: overrides.hard_constraints ?? meta.hard_constraints,
      preferred_order: overrides.preferred_order ?? meta.preferred_order,
      single_agent_sufficient: overrides.single_agent_sufficient ?? meta.single_agent_sufficient,
    });
  }
}

// ---- C1: simple single-agent code tasks (static_dag/single) ----------------
add("simple_single_agent_code", SINGLE_CODE, [
  "Write a function that parses the CSV export and returns a list of records",
  "Implement a function that validates an email address and returns a boolean",
  "Write a utility that sorts the orders array by total descending",
  "Implement a rolling-average calculator for the time series data",
  "Write a function that deduplicates the user list by id",
  "Implement a retry wrapper for the fetch call with exponential backoff",
  "Write a helper that formats a duration in milliseconds as HH:MM:SS",
  "Implement a debounce function with a configurable wait window",
  "Write a function that converts snake_case keys to camelCase",
  "Implement a deep-merge for two plain objects",
  "Write a memoized selector for the state store",
  "Implement a rate limiter that enforces a max calls per second",
  "Write a function that normalizes phone numbers to E.164",
  "Implement a slug generator from an arbitrary title string",
  "Write a CSV row parser that handles quoted fields",
  "Implement a binary search over a sorted number array",
  "Write a function that computes the edit distance between two strings",
  "Implement a chunk function that splits an array into fixed-size groups",
  "Write a validator that checks a password against strength rules",
  "Implement a URL query-string parser returning a plain object",
  "Write a function that flattens a nested object into dot paths",
  "Implement an LRU cache with a capacity limit",
  "Write a shuffle function that returns a deterministic permutation",
  "Implement a JSON-safe clone that drops cyclic references",
  "Write a function that resolves relative import paths",
  "Implement a tokenizer for a simple arithmetic grammar",
  "Write a function that computes a rolling window median",
  "Implement an event emitter with once semantics",
  "Write a function that merges two sorted linked lists",
  "Implement a priority queue backed by a binary heap",
  "Write a function that extracts the top-N keywords from text",
  "Implement a min-max normalizer for a numeric array",
  "Write a function that validates an IBAN string",
  "Implement a state machine transition validator",
  "Write a function that computes the Levenshtein distance",
  "Implement a rate-window counter using a ring buffer",
  "Write a function that interpolates missing values in a series",
  "Implement a set-difference helper for two keyed collections",
  "Write a function that parses an ISO-8601 duration string",
  "Implement a graph adjacency builder from an edge list",
  "Write a function that computes connected components of a graph",
  "Implement a topological sort for a dependency map",
  "Write a function that batches an async workload with a concurrency cap",
  "Implement a semaphore with acquire and release",
  "Write a function that detects a cycle in a singly linked list",
  "Implement a trie with insert, search, and prefix-match",
  "Write a function that computes a 64-bit FNV-1a hash",
  "Implement a token-bucket rate limiter",
  "Write a function that validates a credit-card number via Luhn",
  "Implement a diff function over two string arrays",
  "Write a function that resolves a promise with a timeout",
  "Implement a pub-sub bus with topic filtering",
  "Write a function that computes the longest common subsequence",
  "Implement a circular queue with fixed capacity",
  "Write a function that sanitizes HTML input by stripping tags",
  "Implement an incrementing id generator with reset support",
  "Write a function that converts a number to a compact unit string",
  "Implement a group-by helper that buckets by a key function",
  "Write a function that validates a JWT structure without verification",
  "Implement a coalescing cache that fetches on first miss",
]);

// ---- C2: single read/analyze tasks (static_dag/single) ----------------------
add("simple_single_agent_read", SINGLE_CODE, [
  "Read src/utils.ts and summarize the exported helpers",
  "Search the repository for all callers of the deprecated API",
  "Read the deployment logs and identify the failing service",
  "Analyze the profiling output and list the top five hotspots",
  "Read data/orders.csv and count the orders per region",
  "Search the codebase for every TODO and group them by module",
  "Read the error log and extract the unique stack traces",
  "Analyze the test coverage report and list uncovered branches",
  "Read the release notes and summarize the breaking changes",
  "Search for all usage of the shared cache and report call sites",
  "Read the schema file and list tables that lack an index",
  "Analyze the API response and extract the pagination metadata",
  "Read the configuration file and summarize the feature flags",
  "Search the monorepo for duplicate package names",
  "Read the migration script and list the tables it alters",
  "Analyze the bundle report and rank the largest dependencies",
  "Read the incident timeline and summarize the root cause",
  "Search the docs for outdated references to the old API",
  "Read the trace file and identify the slowest span",
  "Analyze the query plan and flag any sequential scans",
  "Read the checklist and list the incomplete items",
  "Search the issue tracker export for unassigned P0 bugs",
  "Read the changelog and extract the security fixes",
  "Analyze the socket trace and list connections that leaked",
  "Read the generated types and report the unused exports",
  "Search the test files for assertions that are never run",
  "Read the pricing table and compute the median plan cost",
  "Analyze the metrics file and flag values outside the threshold",
  "Read the auth policy and summarize the required scopes",
  "Search the service directory for hard-coded credentials",
  "Read the audit log and count the failed login attempts",
  "Analyze the latency histogram and report the p99",
  "Read the dependency manifest and list vulnerable versions",
  "Search the templates for unescaped interpolations",
  "Read the inventory file and compute the total stock value",
  "Analyze the event stream and group records by source",
  "Read the build log and extract the first failing step",
  "Search the scripts directory for shell-glob footguns",
  "Read the database dump and count orphaned rows",
  "Analyze the access log and list the top client IPs",
]);

// ---- C3: single writing tasks (static_dag/single) ---------------------------
add("single_agent_writing", SINGLE_CODE, [
  "Rewrite the README introduction more concisely",
  "Draft a release announcement for the new API version",
  "Polish the onboarding email so it is shorter",
  "Rewrite the error messages in the config validator",
  "Draft a changelog entry for the bugfix release",
  "Copyedit the technical design doc for clarity",
  "Rewrite the CLI help text so flags are easier to scan",
  "Draft a support response template for billing issues",
  "Polish the migration guide into plain language",
  "Rewrite the function docstrings to a single-line style",
  "Draft a quarterly summary of the product roadmap",
  "Copyedit the incident postmortem for public release",
  "Rewrite the landing-page hero copy to be more direct",
  "Draft a deprecation notice for the legacy endpoint",
  "Polish the security policy into a one-page summary",
  "Rewrite the test names to describe behavior",
  "Draft an internal memo about the ownership transfer",
  "Copyedit the architecture overview and tighten the prose",
  "Rewrite the alert messages so they state the next action",
  "Draft a reply to a customer asking about data retention",
  "Polish the contribution guide and shorten it",
  "Rewrite the status page descriptions for accuracy",
  "Draft a decision record for the cache choice",
  "Copyedit the release checklist into a sequence",
  "Rewrite the operator manual introduction",
  "Draft a training blurb for the new dashboard",
  "Polish the API reference preface for a broader audience",
  "Rewrite the feature flags page and cut the jargon",
  "Draft a thank-you note for the beta testers",
  "Copyedit the outage summary into five sentences",
]);

// ---- C4: open-ended research (routing_slip/single) --------------------------
add("open_ended_research", OPEN_ENDED, [
  "Research the competitive landscape and explore pricing strategies",
  "Explore the codebase to discover all configuration entry points",
  "Research vector databases and explore their trade-offs for our stack",
  "Investigate open problems in the queueing layer and explore options",
  "Research LLM evaluation methods and explore which fit our use case",
  "Explore the incident archive and discover recurring failure patterns",
  "Research idempotency patterns and explore their failure modes",
  "Explore the telemetry schemas and discover the least-documented fields",
  "Research on-call rotation models and explore the options for a small team",
  "Explore the migration history and discover why the schema drifted",
  "Research offline-first sync strategies and explore the alternatives",
  "Explore the dependency graph and discover unused transitive packages",
  "Research feature-flag rollout strategies and explore the trade-offs",
  "Explore the error taxonomy and discover the unhandled categories",
  "Research cost-optimization levers for the GPU pool and explore each",
  "Explore the search index and discover which fields are never queried",
  "Research session-replay tools and explore the privacy constraints",
  "Explore the backup inventory and discover coverage gaps",
  "Research monotonic-clock portability and explore the pitfalls",
  "Explore the auth flows and discover the least-tested path",
  "Research license compatibility and explore the constraint surface",
  "Explore the dashboard queries and discover the heaviest ones",
  "Research cache-invalidation strategies and explore the edge cases",
  "Explore the audit schema and discover the missing dimensions",
  "Research graceful-shutdown patterns and explore the ordering rules",
  "Explore the CLI surface and discover the undocumented flags",
  "Research streaming replication and explore the failure windows",
  "Explore the config matrix and discover the invalid combinations",
  "Research secret-rotation schedules and explore the blast radii",
  "Explore the access-control model and discover the over-permissive roles",
]);

// ---- C5: multi-agent fan-out (workflow_script/multi) ------------------------
add("multi_agent_fanout", MULTI_AGENT, [
  "Fan out to run the regression suite across all 14 browser profiles in parallel",
  "Spin up multiple agents to migrate each of the 18 modules concurrently",
  "Run the price audit across all 24 regions in parallel and aggregate the results",
  "Fan out a security review over every package in the monorepo in parallel",
  "Dispatch multiple agents to translate the docs into 16 languages concurrently",
  "Fan out to benchmark each of the 20 query patterns in parallel",
  "Run the contract tests against all 12 provider stubs concurrently",
  "Fan out a performance profile across the 30 endpoints in parallel",
  "Dispatch agents to update each of the 15 config files concurrently",
  "Fan out the data-quality checks across all 22 shards in parallel",
  "Run the accessibility audit over all 26 pages concurrently",
  "Fan out to regenerate the fixtures for the 18 services in parallel",
  "Dispatch multiple agents to review the 40 pull-request diffs concurrently",
  "Fan out the license scan across all 28 vendored modules in parallel",
  "Run the schema drift check against all 16 databases concurrently",
  "Fan out a dependency audit over the 32 leaf packages in parallel",
  "Dispatch agents to backfill the 19 time partitions concurrently",
  "Fan out the alert triage across all 25 monitor groups in parallel",
  "Run the golden-file comparison over the 21 snapshot suites concurrently",
  "Fan out to extract metrics from each of the 17 log streams in parallel",
]);

// ---- C6: large-scope workflow (workflow_script/multi via 12+ criteria) -------
add(
  "large_scope_workflow",
  MULTI_AGENT,
  [
    "Process the annual dataset and produce the full report",
    "Run the end-to-end certification pass and collect results",
    "Execute the complete migration rehearsal and summarize outcomes",
    "Produce the quarterly compliance review across all controls",
    "Run the full performance baseline and aggregate the metrics",
  ],
  { success_criteria: detCriteria(12) },
);
add(
  "large_scope_workflow",
  MULTI_AGENT,
  [
    "Complete the platform-wide load test and assemble the findings",
    "Run the multi-environment deploy rehearsal and log every step",
    "Produce the capacity plan for the next growth cycle",
    "Execute the full schema rebuild and verify each table",
    "Run the complete trace analysis and summarize the bottlenecks",
  ],
  { success_criteria: detCriteria(13) },
);

// ---- C7: prohibition single-agent traps (static_dag/single after strip) -----
add("prohibition_single_agent", PROHIBITION, [
  "Do not use multiple agents or parallel execution. Refactor the auth module to use dependency injection",
  "Never fan out this work. Fix the retry bug in the worker pool",
  "Do not spin up multiple agents. Optimize the hot loop in the indexer",
  "Never use parallel execution for this. Patch the quota check in the gateway",
  "Do not use multiple agents. Port the config loader to the new format",
  "Never fan out this small change. Add the missing null guard in the parser",
  "Do not dispatch agents for this. Update the cache eviction policy",
  "Never parallelize this. Correct the timestamp handling in the logger",
  "Do not use multiple agents. Replace the deprecated date calls in the scheduler",
  "Never fan out. Fix the ordering bug in the merge step",
]);

// ---- C8: regret set — allowed but suboptimal route (routing_slip preferred) -
add("regret_allowed_suboptimal", REGRET, [
  "Investigate the root cause of the login timeout and propose a fix",
  "Investigate why the nightly job overshoots its budget and propose a remedy",
  "Investigate the source of the stray nulls in the import pipeline and propose a patch",
  "Investigate the dropped websocket frames and propose a corrective change",
  "Investigate the configuration drift and propose a re-application plan",
  "Investigate the throttling in the rate limiter and propose a calibration",
]);

if (tasks.length < 200) {
  throw new Error(`dataset too small: ${tasks.length} < 200`);
}

const dataset = {
  schema: "routing-dataset/v1",
  generator: "scripts/generate-routing-dataset.mjs",
  task_count: tasks.length,
  route_vocabulary: {
    "static_dag/single": "execution_mode=static_dag, 1 agent",
    "routing_slip/single": "execution_mode=routing_slip, 1 agent",
    "workflow_script/multi": "execution_mode=workflow_script, >=2 agents",
  },
  hard_constraint_tokens: [
    "single_agent",
    "multi_agent",
    "execution_static_dag",
    "execution_routing_slip",
    "execution_workflow_script",
    "no_routing_slip",
    "no_workflow_script",
    "budget_usd_micros_le_1000000",
  ],
  tasks,
};

const outPath = join(root, "evals", "routing", "dataset.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(dataset, null, 2)}\n`);
console.log(`wrote ${tasks.length} tasks to ${outPath}`);
