/**
 * MCP Tool Definitions
 * 
 * Defines the tools that GitNexus exposes to external AI agents.
 * All tools support an optional `repo` parameter for multi-repo setups.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description?: string;
      default?: any;
      items?: { type: string };
      enum?: string[];
    }>;
    required: string[];
  };
}

export const GITNEXUS_TOOLS: ToolDefinition[] = [
  {
    name: 'list_repos',
    description: `List all indexed repositories available to GitNexus.

Returns each repo's name, path, indexed date, last commit, and stats.

WHEN TO USE: First step when multiple repos are indexed, or to discover available repos.
AFTER THIS: READ gitnexus://repo/{name}/context for the repo you want to work with.
Tip: {name} may be a URL-encoded absolute repo path. For worktrees/multi-repo, prefer the path-encoded URIs in gitnexus://repos (see mcp_uri_context).

When multiple repos are indexed, you MUST specify the "repo" parameter
on other tools (query, context, impact, etc.) to target the correct one.`,
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'episode_state',
    description: `Read the EpisodeGraph sidecar (working memory overlay) for a repository.

Returns a compact summary of recently opened symbols/spans, hypotheses, failing tests,
error strings, chosen precedents, edit-set files, witness paths, and target branch/task context.

WHEN TO USE: At the start or middle of long-running implementation/review/debug sessions to resume context quickly.
AFTER THIS: Use query()/context()/impact() with the surfaced anchors.`,
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entries per section (default: 10)', default: 10 },
        include_events: { type: 'boolean', description: 'Include recent tool-event timeline (default: true)', default: true },
        repo: { type: 'string', description: 'Repository id, name, or absolute path. Omit if only one repo is indexed. Recommended: absolute path for worktrees.' },
      },
      required: [],
    },
  },
  {
    name: 'episode_update',
    description: `Update the EpisodeGraph sidecar (working memory overlay) without mutating the durable Kuzu index.

Supports recording manual context such as accepted/rejected hypotheses, failing tests, errors,
witness paths, edit-set files, opened spans, and target branch/task metadata.

WHEN TO USE: During implementation/review/debug when you learn durable session facts.
AFTER THIS: Query again; EpisodeGraph overlay will be merged at retrieval time.`,
    inputSchema: {
      type: 'object',
      properties: {
        clear: { type: 'boolean', description: 'Reset/clear episode graph state for this repo (default: false)', default: false },
        target_branch: { type: 'string', description: 'Current target branch name (optional)' },
        task_id: { type: 'string', description: 'Current task/ticket identifier (optional)' },
        accepted_hypotheses: { type: 'array', description: 'Hypotheses marked accepted', items: { type: 'string' } },
        rejected_hypotheses: { type: 'array', description: 'Hypotheses marked rejected', items: { type: 'string' } },
        candidate_hypotheses: { type: 'array', description: 'Hypotheses still under investigation', items: { type: 'string' } },
        failing_tests: { type: 'array', description: 'Failing test identifiers/messages', items: { type: 'string' } },
        error_strings: { type: 'array', description: 'Error strings/stack signatures', items: { type: 'string' } },
        witness_paths: { type: 'array', description: 'Last proven witness paths or proof breadcrumbs', items: { type: 'string' } },
        edit_files: { type: 'array', description: 'Current edit-set file paths', items: { type: 'string' } },
        opened_spans: { type: 'array', description: 'Opened spans as file[:line[:end]] tokens', items: { type: 'string' } },
        limit: { type: 'number', description: 'Max entries per section in response (default: 10)', default: 10 },
        include_events: { type: 'boolean', description: 'Include recent tool-event timeline (default: true)', default: true },
        repo: { type: 'string', description: 'Repository id, name, or absolute path. Omit if only one repo is indexed. Recommended: absolute path for worktrees.' },
      },
      required: [],
    },
  },
  {
    name: 'evidence_spans',
    description: `Read EvidenceSpan snapshot entries (line-level proof/witness ranges) for a repository.

Returns primary/witness/proof spans for symbols and relationships so follow-up work can open exact lines instead of whole files.

WHEN TO USE: After query/context/review/debug when you need concrete line anchors and proof breadcrumbs.
AFTER THIS: Open the returned file:line spans, then continue with context()/impact() on exact symbols.`,
    inputSchema: {
      type: 'object',
      properties: {
        symbol_id: { type: 'string', description: 'Optional symbol/node ID to filter spans (exact node id).' },
        file_path: { type: 'string', description: 'Optional repo-relative file path to filter spans.' },
        include_nodes: { type: 'boolean', description: 'Include node-level span entries (default: true).', default: true },
        include_edges: { type: 'boolean', description: 'Include edge-level span entries (default: true).', default: true },
        limit: { type: 'number', description: 'Max node/edge entries per section (default: 20).', default: 20 },
        repo: { type: 'string', description: 'Repository id, name, or absolute path. Omit if only one repo is indexed. Recommended: absolute path for worktrees.' },
      },
      required: [],
    },
  },
  {
    name: 'summary_overlay',
    description: `Read structured hierarchical summary overlays for symbols/files/slices/communities/processes/archetypes.

Returns compact structured fields (responsibilities, inbound callers, downstream effects, auth/cache/shape contracts, companions, sibling precedents) without re-reading raw source.

WHEN TO USE: When you need high-signal overview context before deep code reads, or to compare related entities quickly.
AFTER THIS: Open evidence spans and context for the selected entity IDs.`,
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', description: 'Optional level filter: symbol|file|slice|community|process|archetype.', enum: ['symbol', 'file', 'slice', 'community', 'process', 'archetype'] },
        entity_id: { type: 'string', description: 'Optional entity ID filter (exact entity id or summary id).' },
        file_path: { type: 'string', description: 'Optional repo-relative file path filter.' },
        query: { type: 'string', description: 'Optional substring query across summary fields.' },
        limit: { type: 'number', description: 'Max entries per level (default: 20).', default: 20 },
        repo: { type: 'string', description: 'Repository id, name, or absolute path. Omit if only one repo is indexed. Recommended: absolute path for worktrees.' },
      },
      required: [],
    },
  },
  {
    name: 'closure_templates',
    description: `Read closure-template overlays derived from feature-slice families.

Returns per-family template expectations (required/optional slots, role coverage, exemplar slices) to compare slices against expected closure anatomy.

WHEN TO USE: During implement/review/debug when you need to verify a slice matches sibling closure patterns.
AFTER THIS: Use query/context/review_mode on exemplar slice IDs and evidence spans for exact lines.`,
    inputSchema: {
      type: 'object',
      properties: {
        slice_type: { type: 'string', description: 'Optional slice type filter (e.g. endpoint, permission, query_key).' },
        template_key: { type: 'string', description: 'Optional template key or template id filter.' },
        query: { type: 'string', description: 'Optional substring query across slots/roles/template fields.' },
        limit: { type: 'number', description: 'Max templates to return (default: 20).', default: 20 },
        repo: { type: 'string', description: 'Repository id, name, or absolute path. Omit if only one repo is indexed. Recommended: absolute path for worktrees.' },
      },
      required: [],
    },
  },
  {
    name: 'query',
    description: `Query the code knowledge graph for execution flows related to a concept.
Returns processes (call chains) ranked by relevance, each with its symbols and file locations.

WHEN TO USE: Understanding how code works together. Use this when you need execution flows and relationships, not just file matches. Complements grep/IDE search.
AFTER THIS: Use context() on a specific symbol for 360-degree view (callers, callees, categorized refs).

Returns results grouped by process (execution flow):
- processes: ranked execution flows with relevance priority
- process_symbols: all symbols in those flows with file locations
- definitions: standalone types/interfaces not in any process
- slice_cards: top feature slices (closure + gap signals + matched members)
- query_plan: retrieval diagnostics (intent, exact lookup, search-mode summary)

Hybrid ranking: BM25 keyword + semantic vector search, ranked by Reciprocal Rank Fusion.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language or keyword search query' },
        task_context: { type: 'string', description: 'What you are working on (e.g., "adding OAuth support"). Helps ranking.' },
        goal: { type: 'string', description: 'What you want to find (e.g., "existing auth validation logic"). Helps ranking.' },
        limit: { type: 'number', description: 'Max processes to return (default: 5)', default: 5 },
        max_symbols: { type: 'number', description: 'Max symbols per process (default: 10)', default: 10 },
        include_content: { type: 'boolean', description: 'Include full symbol source code (default: false)', default: false },
        include_slice_cards: { type: 'boolean', description: 'Include top FeatureSlice cards (default: true).', default: true },
        limit_slices: { type: 'number', description: 'Max slice cards to return (default: 2, max: 5).', default: 2 },
        include_evidence_spans: { type: 'boolean', description: 'Attach EvidenceSpan proof spans to slice cards (default: true).', default: true },
        limit_evidence: { type: 'number', description: 'Max evidence symbol spans across returned slice cards (default: 20).', default: 20 },
        path_prefixes: {
          type: 'array',
          description: 'Optional list of repo-relative (or absolute) path prefixes to scope results (e.g. ["apps/backend/", "apps/dashboard/"]).',
          items: { type: 'string' },
        },
        repo: { type: 'string', description: 'Repository id, name, or absolute path. Omit if only one repo is indexed. Recommended: absolute path for worktrees.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'query_mode',
    description: `Query-mode planner: symptom/intent-aware retrieval head that packages top slices, proof symbols, sibling precedents, and action hints.

Builds on query/precedents/action_plan to return:
- query intent + retrieval diagnostics
- top feature slices with closure/gap signals
- compact symbol/process anchors for follow-up
- optional sibling precedents and deterministic action hints

WHEN TO USE: First pass for “where should I look?” in implementation or investigation tasks.
AFTER THIS: Open anchors with context()/impact(), then use action_plan/review_mode as needed.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language or keyword search query.' },
        task_context: { type: 'string', description: 'Optional task context to help ranking.' },
        goal: { type: 'string', description: 'Optional goal to help ranking.' },
        path_prefixes: {
          type: 'array',
          description: 'Optional list of repo-relative (or absolute) path prefixes to scope query-mode analysis.',
          items: { type: 'string' },
        },
        limit_processes: { type: 'number', description: 'Max process summaries to return (default: 4).', default: 4 },
        max_symbols: { type: 'number', description: 'Max anchor symbols to return (default: 16).', default: 16 },
        limit_slices: { type: 'number', description: 'Max slice cards to return (default: 2).', default: 2 },
        limit_precedents: { type: 'number', description: 'Max precedents to include (default: 2).', default: 2 },
        limit_hops: { type: 'number', description: 'Max action-hint hops to include (default: 4).', default: 4 },
        include_precedents: { type: 'boolean', description: 'Include sibling precedents when available (default: true).', default: true },
        include_action_hints: { type: 'boolean', description: 'Include compact action-plan hints (default: true).', default: true },
        repo: { type: 'string', description: 'Repository id, name, or absolute path. Omit if only one repo is indexed. Recommended: absolute path for worktrees.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'mode_router',
    description: `Auto-routing planner that dispatches to query/implement/review/debug kernels based on explicit mode or intent signals.

Routes to one of:
- query_mode (exploration-first)
- implement_mode (edit-plan-first)
- review_mode (diff-risk-first)
- debug_mode (symptom-first)
- unified envelope (primary symbols/files, findings, hypotheses, next actions, handoff)
- route trace (candidate scores/reasons + selected mode + fallback signal)

WHEN TO USE: When you want one entrypoint that chooses the right planner mode.
AFTER THIS: Use the routed result payload directly (or force a specific mode if needed).`,
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', description: 'Routing mode: auto (default), query, implement, review, or debug.', enum: ['auto', 'query', 'implement', 'review', 'debug'], default: 'auto' },
        query: { type: 'string', description: 'Anchor query used by query/implement/debug modes.' },
        symptom: { type: 'string', description: 'Observed symptom summary for debug routing.' },
        failing_tests: { type: 'array', description: 'Optional failing test identifiers/messages.', items: { type: 'string' } },
        error_strings: { type: 'array', description: 'Optional error strings/stack snippets.', items: { type: 'string' } },
        task_context: { type: 'string', description: 'Optional task context to help ranking.' },
        goal: { type: 'string', description: 'Optional goal to help ranking.' },
        scope: { type: 'string', description: 'Review scope when mode resolves to review (default: unstaged).', enum: ['unstaged', 'staged', 'all', 'compare'], default: 'unstaged' },
        base_ref: { type: 'string', description: 'Base ref for compare review scope.' },
        include_precedents: { type: 'boolean', description: 'Include precedents in routed modes that support them (default: true).', default: true },
        path_prefixes: {
          type: 'array',
          description: 'Optional list of repo-relative (or absolute) path prefixes to scope routed analysis.',
          items: { type: 'string' },
        },
        repo: { type: 'string', description: 'Repository id, name, or absolute path. Omit if only one repo is indexed. Recommended: absolute path for worktrees.' },
      },
      required: [],
    },
  },
  {
    name: 'implement_mode',
    description: `Implementation-mode planner: packages target slice anatomy, companion files, write order, precedents, and post-edit review contract.

Builds on action_plan (+ optional query_mode head) to return:
- implement target (intent/archetype/slice)
- closure template + gap signals
- ranked companion files and ordered write anchors
- compact verification hints + post-edit review invocation

WHEN TO USE: Before making multi-file changes where you need a deterministic edit plan.
AFTER THIS: Edit in write-plan order, then run review_mode using post_edit_review params.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language or keyword search query.' },
        task_context: { type: 'string', description: 'Optional task context to help ranking.' },
        goal: { type: 'string', description: 'Optional implementation goal to help ranking.' },
        path_prefixes: {
          type: 'array',
          description: 'Optional list of repo-relative (or absolute) path prefixes to scope implementation planning.',
          items: { type: 'string' },
        },
        limit_files: { type: 'number', description: 'Max companion/action files to include (default: 10).', default: 10 },
        limit_checks: { type: 'number', description: 'Max verification checks to include (default: 10).', default: 10 },
        limit_write_order: { type: 'number', description: 'Max ordered write anchors to include (default: 10).', default: 10 },
        limit_precedents: { type: 'number', description: 'Max precedents to include (default: 3).', default: 3 },
        include_query_head: { type: 'boolean', description: 'Include compact query-mode head output (default: true).', default: true },
        include_review_contract: { type: 'boolean', description: 'Include post_edit_review handoff contract (default: true).', default: true },
        repo: { type: 'string', description: 'Repository id, name, or absolute path. Omit if only one repo is indexed. Recommended: absolute path for worktrees.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'action_plan',
    description: `Decision-ready summary for a goal/query.
Returns a compact file list + verification checklist derived from high-confidence graph signals.
Also includes an implement-oriented kernel plan (target archetype/slice, precedents, companion files, write order, and post-edit review invocation).

WHEN TO USE: When you want “what should I open/change/verify?” with minimal scrolling.
AFTER THIS: Use context() on the top-ranked anchors, then impact() on the change point.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language or keyword search query' },
        task_context: { type: 'string', description: 'What you are working on (optional). Helps ranking.' },
        goal: { type: 'string', description: 'What you want to find (optional). Helps ranking.' },
        limit_files: { type: 'number', description: 'Max files to return (default: 10)', default: 10 },
        limit_checks: { type: 'number', description: 'Max verification bullets to return (default: 10)', default: 10 },
        path_prefixes: {
          type: 'array',
          description: 'Optional list of repo-relative (or absolute) path prefixes to scope results (e.g. ["apps/backend/", "apps/dashboard/"]).',
          items: { type: 'string' },
        },
        repo: { type: 'string', description: 'Repository id, name, or absolute path. Omit if only one repo is indexed. Recommended: absolute path for worktrees.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'archetypes',
    description: `Derive "flow signatures" (archetypes) from execution flows, and return exemplar processes.

WHEN TO USE: When architecting or implementing and you want to mirror existing patterns ("more than a map").
Also useful in review to verify new code fits an existing archetype rather than inventing a new shape.

This is a derived view (no schema changes). It groups Process traces into common signatures using
path-based layer tags plus explicit high-confidence http-* edges.

AFTER THIS: Use query/context on exemplar entry/terminal symbols, then impact on the planned change point.`,
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max signatures to return (default: 25)', default: 25 },
        examples: { type: 'number', description: 'Examples per signature (default: 3)', default: 3 },
        min_http_confidence: { type: 'number', description: 'Minimum confidence for HTTP wiring edges (default: 0.9)', default: 0.9 },
        path_prefixes: {
          type: 'array',
          description: 'Optional list of repo-relative (or absolute) path prefixes to scope results (e.g. ["apps/backend/", "apps/dashboard/"]).',
          items: { type: 'string' },
        },
        repo: { type: 'string', description: 'Repository id, name, or absolute path. Omit if only one repo is indexed. Recommended: absolute path for worktrees.' },
      },
      required: [],
    },
  },
  {
    name: 'precedents',
    description: `Precedent/template finder: find existing callsites with similar control-flow/anatomy.

This is a derived view (no schema changes). It:
1) Finds anchor FeatureSlice(s) from the query/anchor symbol (fallback: process + HTTP hop anchors)
2) Ranks sibling slices by closure-slot/role overlap (plus cochange signal when available)
3) Returns compact exemplar callsites you can mirror (slice-first, then hop/process fallback).

WHEN TO USE: When implementing a feature and you want to copy the established anatomy instead of inventing a new shape.
Also useful in review: verify new code fits an existing archetype.

AFTER THIS: Open the anchor + exemplar files and mirror their structure; then use impact() on the change point.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language or keyword search query' },
        anchor_uid: { type: 'string', description: 'Optional explicit anchor symbol UID (preferred when the query does not map cleanly to Process flows).' },
        limit: { type: 'number', description: 'Max anchor processes to consider (default: 2)', default: 2 },
        examples: { type: 'number', description: 'Examples per anchor signature (default: 3)', default: 3 },
        min_http_confidence: { type: 'number', description: 'Minimum confidence for HTTP wiring edges (default: 0.9)', default: 0.9 },
        path_prefixes: {
          type: 'array',
          description: 'Optional list of repo-relative (or absolute) path prefixes to scope results (e.g. ["apps/backend/", "apps/dashboard/"]).',
          items: { type: 'string' },
        },
        repo: { type: 'string', description: 'Repository id, name, or absolute path. Omit if only one repo is indexed. Recommended: absolute path for worktrees.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'ui_contract',
    description: `Generate a UI behavior contract card for a TS/TSX/JSX file.

This is a derived view (no schema changes). It extracts interaction entry points
(onClick/onSubmit/onOpenChange/etc) and summarizes side-effects (mutations, query invalidations,
navigation, toasts, and common state-setter calls), plus controlled open-state surfaces and
pending/disabled UX gates (disabled/isPending/isLoading/etc). It also summarizes query contracts
(queryKey + key refetch/staleness options) when present.

Optionally enriches with backend endpoint hops by following high-confidence http-* edges reachable
from symbols defined in the file (surface → API wrapper → controller).

WHEN TO USE: “Why did this close/refetch/navigate/disable?” without spelunking a dozen files.
AFTER THIS: Use context()/impact() on the high-signal symbols the contract points to.`,
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'File path (relative to repo root, or absolute path inside the repo).' },
        base_ref: { type: 'string', description: 'Optional git ref/commit to diff the contract against (e.g. "main").' },
        include_endpoints: { type: 'boolean', description: 'Include endpoint/controller hops via http-* edges (default: true).', default: true },
        min_http_confidence: { type: 'number', description: 'Minimum confidence for http-* edge enrichment (default: 0.9).', default: 0.9 },
        path_prefixes: {
          type: 'array',
          description: 'Optional list of repo-relative (or absolute) path prefixes to scope endpoint/controller enrichment (e.g. ["apps/backend/", "apps/dashboard/"]).',
          items: { type: 'string' },
        },
        repo: { type: 'string', description: 'Repository id, name, or absolute path. Omit if only one repo is indexed. Recommended: absolute path for worktrees.' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'cypher',
    description: `Execute a read-only Cypher query against the code knowledge graph.

WHEN TO USE: Complex structural queries that search/explore can't answer. READ gitnexus://repo/{name}/schema first for the full schema.
SAFETY: Write operations (CREATE/MERGE/DELETE/SET/etc.) are blocked in this tool.
AFTER THIS: Use context() on result symbols for deeper context.

SCHEMA:
- Nodes: File, Folder, Function, Class, Interface, Method, CodeElement, Community, Process, FeatureSlice, Gap, ContractShape, ContractField, CacheKey, DBTable, DBColumn, ValueNode, TestCase
- Multi-language nodes (use backticks): \`Struct\`, \`Enum\`, \`Trait\`, \`Impl\`, etc.
- All edges via single CodeRelation table with 'type' property
- Edge types: CONTAINS, CO_CHANGES_WITH, DEFINES, CALLS, IMPORTS, EXTENDS, IMPLEMENTS, MEMBER_OF, STEP_IN_PROCESS, VALIDATES_FIELD, SERIALIZES_FIELD, READS_FIELD, WRITES_FIELD, DERIVES_FROM, DERIVES_FROM_COLUMN, INVALIDATES_KEY, TESTS_SHAPE
- Edge properties: type (STRING), confidence (DOUBLE), reason (STRING), step (INT32), certaintyTier (STRING), provenanceFamily (STRING), absenceSemantics (STRING), witnessPathIds (STRING)

EXAMPLES:
• Find callers of a function:
  MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b:Function {name: "validateUser"}) RETURN a.name, a.filePath

• Find community members:
  MATCH (f)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community) WHERE c.heuristicLabel = "Auth" RETURN f.name

• Trace a process:
  MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process) WHERE p.heuristicLabel = "UserLogin" RETURN s.name, r.step ORDER BY r.step

TIPS:
- All relationships use single CodeRelation table — filter with {type: 'CALLS'} etc.
- Community = auto-detected functional area (Leiden algorithm)
- Process = execution flow trace from entry point to terminal
- Use heuristicLabel (not label) for human-readable community/process/slice/gap names`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Cypher query to execute' },
        repo: { type: 'string', description: 'Repository id, name, or absolute path. Omit if only one repo is indexed. Recommended: absolute path for worktrees.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'context',
    description: `360-degree view of a single code symbol.
Shows categorized incoming/outgoing references (calls, imports, extends, implements), process participation, and file location.
Each reference includes edge metadata: confidence + reason (when available).

WHEN TO USE: After query() to understand a specific symbol in depth. When you need to know all callers, callees, and what execution flows a symbol participates in.
AFTER THIS: Use impact() if planning changes, or READ gitnexus://repo/{name}/process/{processName} for full execution trace.

Handles disambiguation: if multiple symbols share the same name, returns candidates for you to pick from. Use uid param for zero-ambiguity lookup from prior results.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Symbol name (e.g., "validateUser", "AuthService")' },
        uid: { type: 'string', description: 'Direct symbol UID from prior tool results (zero-ambiguity lookup)' },
        file_path: { type: 'string', description: 'File path to disambiguate common names' },
        include_content: { type: 'boolean', description: 'Include full symbol source code (default: false)', default: false },
        repo: { type: 'string', description: 'Repository id, name, or absolute path. Omit if only one repo is indexed. Recommended: absolute path for worktrees.' },
      },
      required: [],
    },
  },
  {
    name: 'detect_changes',
    description: `Analyze uncommitted git changes and find affected execution flows.
Maps git diff hunks to indexed symbols, then traces which processes are impacted.

WHEN TO USE: Before committing — to understand what your changes affect. Pre-commit review, PR preparation.
AFTER THIS: Review affected processes. Use context() on high-risk symbols. READ gitnexus://repo/{name}/process/{name} for full traces.

Returns: changed symbols, affected processes, and a risk summary.`,
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'What to analyze: "unstaged" (default), "staged", "all", or "compare"', enum: ['unstaged', 'staged', 'all', 'compare'], default: 'unstaged' },
        base_ref: { type: 'string', description: 'Branch/commit for "compare" scope (e.g., "main")' },
        repo: { type: 'string', description: 'Repository id, name, or absolute path. Omit if only one repo is indexed. Recommended: absolute path for worktrees.' },
      },
      required: [],
    },
  },
  {
    name: 'review_mode',
    description: `Diff-aware review mode: summarize changes vs a base ref (or local working tree) with graph-backed context.

Builds on detect_changes-style diffing, then surfaces:
- changed files + changed symbols (by diff hunk → symbol span)
- upstream callers + suggested tests (confidence-first)
- contract signals (UI contract diffs, Laravel route targets, controller auth checks)
- semantic relation-family deltas (auth/shape/cache/test/event/template) + slice-linked gap signals
- runtime hotspot overlays from runtime-observations snapshots (when available)
- proof pack evidence spans for changed symbols and sampled semantic edges
- slice stencil deltas (changed slices, closure-template fit, missing slots/roles, sibling precedents)
- review kernel summary (risk level, top findings, hypotheses, and next actions)

WHEN TO USE: PR review, behavior/contract audits, “what should I verify?” after a change.
AFTER THIS: Use context()/impact() on the highest-risk changed symbols or route/controller anchors.`,
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'What to analyze: "unstaged" (default), "staged", "all", or "compare"', enum: ['unstaged', 'staged', 'all', 'compare'], default: 'unstaged' },
        base_ref: { type: 'string', description: 'Base ref/commit for "compare" scope (e.g., "origin/main"). Required when scope="compare".' },
        path_prefixes: {
          type: 'array',
          description: 'Optional list of repo-relative (or absolute) path prefixes to scope the review (e.g. ["apps/backend/", "apps/dashboard/"]).',
          items: { type: 'string' },
        },
        limit_symbols: { type: 'number', description: 'Max changed symbols to analyze (default: 60)', default: 60 },
        limit_callers: { type: 'number', description: 'Max upstream callers per symbol (default: 10)', default: 10 },
        limit_tests: { type: 'number', description: 'Max suggested tests (default: 10)', default: 10 },
        min_confidence: { type: 'number', description: 'Minimum confidence for edges (default: 0.9)', default: 0.9 },
        include_ui_contracts: { type: 'boolean', description: 'Include UI contract diffs for changed TS/TSX/JSX files (default: true)', default: true },
        max_ui_contract_files: { type: 'number', description: 'Max UI contract files to analyze (default: 5)', default: 5 },
        include_evidence_spans: { type: 'boolean', description: 'Include proof-pack evidence spans from the EvidenceSpan sidecar (default: true)', default: true },
        limit_evidence: { type: 'number', description: 'Max proof-pack symbol/edge evidence entries (default: 40)', default: 40 },
        include_slice_stencil: { type: 'boolean', description: 'Include slice-stencil comparison output (default: true)', default: true },
        limit_slice_stencil: { type: 'number', description: 'Max changed slices to include in stencil output (default: 8)', default: 8 },
        include_runtime_probe_requests: { type: 'boolean', description: 'Include auto-generated micro runtime-probe requests when review uncertainty is high (default: true)', default: true },
        repo: { type: 'string', description: 'Repository id, name, or absolute path. Omit if only one repo is indexed. Recommended: absolute path for worktrees.' },
      },
      required: [],
    },
  },
  {
    name: 'debug_mode',
    description: `Symptom-first debug planner: localize likely broken loops using graph anchors, slice closure signals, and sibling precedent diffs.

Builds on query/action_plan/precedents to surface:
- symptom classification (auth/cache/shape/routing/event/performance)
- anchored loop candidates (HTTP chain, cache coverage, slice closure gaps)
- ranked findings with confidence/symptom fit
- runtime-informed candidates (request latency, DB lock waits, payload cardinality)
- sibling slice diff (when available) and concrete next actions

WHEN TO USE: “Why is this failing?” investigations (stale UI, 403, null/field mismatch, routing misses, queue/event drift).
AFTER THIS: Open top candidate anchors with context()/impact(), patch, then run review_mode.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Anchor query (symbol/endpoint/feature) to seed debug search.' },
        symptom: { type: 'string', description: 'Observed symptom summary (e.g., "403 on account notifications").' },
        failing_tests: { type: 'array', description: 'Optional failing test identifiers/messages.', items: { type: 'string' } },
        error_strings: { type: 'array', description: 'Optional error strings/stack snippets.', items: { type: 'string' } },
        task_context: { type: 'string', description: 'Optional task context to help ranking.' },
        goal: { type: 'string', description: 'Optional investigation goal to help ranking.' },
        path_prefixes: {
          type: 'array',
          description: 'Optional list of repo-relative (or absolute) path prefixes to scope debug analysis.',
          items: { type: 'string' },
        },
        runtime_observations: {
          type: 'object',
          description: 'Optional runtime evidence bundle (request spans, DB query timings/lock waits, payload shape snapshots) used to boost root-cause ranking. If omitted, debug_mode auto-loads .gitnexus/runtime-observations*.{json,ndjson} when available.',
        },
        limit_candidates: { type: 'number', description: 'Max ranked broken-loop candidates to return (default: 8).', default: 8 },
        limit_hops: { type: 'number', description: 'Max anchored HTTP hops to include (default: 6).', default: 6 },
        include_precedents: { type: 'boolean', description: 'Include sibling precedent diff when available (default: true).', default: true },
        repo: { type: 'string', description: 'Repository id, name, or absolute path. Omit if only one repo is indexed. Recommended: absolute path for worktrees.' },
      },
      required: [],
    },
  },
  {
    name: 'rename',
    description: `Multi-file coordinated rename using the knowledge graph + text search.
Finds all references via graph (high confidence) and regex text search (lower confidence). Preview by default.

WHEN TO USE: Renaming a function, class, method, or variable across the codebase. Safer than find-and-replace.
AFTER THIS: Run detect_changes() to verify no unexpected side effects.

Each edit is tagged with confidence:
- "graph": found via knowledge graph relationships (high confidence, safe to accept)
- "text_search": found via regex text search (lower confidence, review carefully)`,
    inputSchema: {
      type: 'object',
      properties: {
        symbol_name: { type: 'string', description: 'Current symbol name to rename' },
        symbol_uid: { type: 'string', description: 'Direct symbol UID from prior tool results (zero-ambiguity)' },
        new_name: { type: 'string', description: 'The new name for the symbol' },
        file_path: { type: 'string', description: 'File path to disambiguate common names' },
        dry_run: { type: 'boolean', description: 'Preview edits without modifying files (default: true)', default: true },
        repo: { type: 'string', description: 'Repository id, name, or absolute path. Omit if only one repo is indexed. Recommended: absolute path for worktrees.' },
      },
      required: ['new_name'],
    },
  },
  {
    name: 'impact',
    description: `Analyze the blast radius of changing a code symbol.
Returns all symbols affected by modifying the target, grouped by depth with edge types, confidence, and reason (when available).

WHEN TO USE: Before making code changes — especially refactoring, renaming, or modifying shared code. Shows what would break.
AFTER THIS: Review d=1 items (WILL BREAK). READ gitnexus://repo/{name}/processes to check affected execution flows.

Depth groups:
- d=1: WILL BREAK (direct callers/importers)
- d=2: LIKELY AFFECTED (indirect)
- d=3: MAY NEED TESTING (transitive)

EdgeType: CALLS, IMPORTS, EXTENDS, IMPLEMENTS
Confidence: 1.0 = certain, <0.8 = fuzzy match`,
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Name of function, class, or file to analyze (legacy name param)' },
        name: { type: 'string', description: 'Symbol name (preferred; same as target)' },
        uid: { type: 'string', description: 'Direct symbol UID from prior tool results (zero-ambiguity lookup)' },
        file_path: { type: 'string', description: 'File path to disambiguate common names' },
        direction: { type: 'string', description: 'upstream (what depends on this) or downstream (what this depends on)' },
        maxDepth: { type: 'number', description: 'Max relationship depth (default: 3)', default: 3 },
        relationTypes: { type: 'array', items: { type: 'string' }, description: 'Filter: CALLS, IMPORTS, EXTENDS, IMPLEMENTS (default: usage-based)' },
        includeTests: { type: 'boolean', description: 'Include test files (default: false)' },
        minConfidence: { type: 'number', description: 'Minimum confidence 0-1 (default: 0.7)' },
        repo: { type: 'string', description: 'Repository id, name, or absolute path. Omit if only one repo is indexed. Recommended: absolute path for worktrees.' },
      },
      required: ['direction'],
    },
  },
];
