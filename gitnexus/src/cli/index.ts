#!/usr/bin/env node
import { Command } from 'commander';
import { analyzeCommand } from './analyze.js';
import { serveCommand } from './serve.js';
import { listCommand } from './list.js';
import { statusCommand } from './status.js';
import { mcpCommand } from './mcp.js';
import { cleanCommand } from './clean.js';
import { setupCommand } from './setup.js';
import { augmentCommand } from './augment.js';
import { wikiCommand } from './wiki.js';
import { archetypesCommand } from './archetypes.js';
import { runtimeIngestCommand } from './runtime-ingest.js';
import {
  queryCommand,
  queryModeCommand,
  implementModeCommand,
  reviewModeCommand,
  debugModeCommand,
  modeRouterCommand,
  contextCommand,
  impactCommand,
  cypherCommand,
  precedentsCommand,
} from './tool.js';
import { evalServerCommand } from './eval-server.js';
const program = new Command();

program
  .name('gitnexus')
  .description('GitNexus local CLI and MCP server')
  .version('1.2.0');

program
  .command('setup')
  .description('One-time setup: configure MCP for Cursor, Claude Code, OpenCode')
  .action(setupCommand);

program
  .command('analyze [path]')
  .description('Index a repository (full analysis)')
  .option('-f, --force', 'Force full re-index even if up to date')
  .option('--skip-embeddings', 'Skip embedding generation (faster)')
  .option('--incremental-max-changes <n>', 'Override incremental change limit (0 disables incremental)', (value) => parseInt(value, 10))
  .option('--incremental-derived <mode>', 'Incremental derived refresh mode: full|adaptive|fast', 'adaptive')
  .option('--incremental-recompute-processes', 'Recompute execution flows (Process nodes) after incremental update')
  .option('--incremental-recompute-communities', 'Recompute communities/clusters (Community nodes) after incremental update')
  .option('--precision-overlay <mode>', 'Precision overlay mode: auto|scip|shadow|lsp-probe|off', 'auto')
  .option('--precision-overlay-path <path>', 'Precision overlay JSON path (default: .gitnexus/precision-overlay.json)')
  .option('--precision-overlay-force', 'Force refresh precision producer cache for this run')
  .option('--graph-expectation-path <path>', 'Graph expectation DSL JSON path (default: .gitnexus/graph-expectations.json)')
  .option('--no-registry', 'Do not update global registry (~/.gitnexus/registry.json)')
  .option('--no-hooks', 'Do not register Claude Code hooks')
  .option('--write-context', 'Write GitNexus context into AGENTS.md/CLAUDE.md (and install .claude skills)')
  .option('--update-gitignore', 'Add .gitnexus to the repo .gitignore')
  .action(analyzeCommand);

program
  .command('runtime-ingest [input]')
  .description('Ingest runtime trace evidence into .gitnexus/runtime-observations.json')
  .option('--repo <path>', 'Target repo path (defaults to current directory)')
  .option(
    '--input <path>',
    'Additional runtime payload file (json/ndjson, repeatable)',
    (value, previous: string[]) => (Array.isArray(previous) ? [...previous, value] : [value]),
    []
  )
  .option('--output <path>', 'Output snapshot file path (default: <repo>/.gitnexus/runtime-observations.json)')
  .option('--replace', 'Replace existing snapshot instead of merge')
  .option('--print', 'Print normalized snapshot payload after write')
  .option(
    '--request-span <json>',
    'Inline request span JSON object (repeatable)',
    (value, previous: string[]) => (Array.isArray(previous) ? [...previous, value] : [value]),
    []
  )
  .option(
    '--db-query <json>',
    'Inline DB query JSON object (repeatable)',
    (value, previous: string[]) => (Array.isArray(previous) ? [...previous, value] : [value]),
    []
  )
  .option(
    '--payload-shape <json>',
    'Inline payload shape JSON object (repeatable)',
    (value, previous: string[]) => (Array.isArray(previous) ? [...previous, value] : [value]),
    []
  )
  .action((inputPath, options) => runtimeIngestCommand(inputPath, {
    repo: options.repo,
    input: options.input,
    output: options.output,
    replace: options.replace,
    print: options.print,
    requestSpan: options.requestSpan,
    dbQuery: options.dbQuery,
    payloadShape: options.payloadShape,
  }));

program
  .command('serve')
  .description('Start local HTTP server for web UI connection')
  .option('-p, --port <port>', 'Port number', '4747')
  .action(serveCommand);

program
  .command('mcp')
  .description('Start MCP server (stdio) — serves all indexed repos')
  .action(mcpCommand);

program
  .command('list')
  .description('List all indexed repositories')
  .action(listCommand);

program
  .command('status')
  .description('Show index status for current repo')
  .action(statusCommand);

program
  .command('clean')
  .description('Delete GitNexus index for current repo')
  .option('-f, --force', 'Skip confirmation prompt')
  .option('--all', 'Clean all indexed repos')
  .action(cleanCommand);

program
  .command('wiki [path]')
  .description('Generate repository wiki from knowledge graph')
  .option('-f, --force', 'Force full regeneration even if up to date')
  .option('--model <model>', 'LLM model name (default: minimax/minimax-m2.5)')
  .option('--base-url <url>', 'LLM API base URL (default: OpenAI)')
  .option('--api-key <key>', 'LLM API key (saved to ~/.gitnexus/config.json)')
  .option('--concurrency <n>', 'Parallel LLM calls (default: 3)', '3')
  .option('--gist', 'Publish wiki as a public GitHub Gist after generation')
  .action(wikiCommand);

program
  .command('augment <pattern>')
  .description('Augment a search pattern with knowledge graph context (used by hooks)')
  .action(augmentCommand);

program
  .command('archetypes')
  .description('Derive flow signatures + exemplar processes (archetype heat map)')
  .option('-r, --repo <name>', 'Target repository (omit if only one indexed)')
  .option('-l, --limit <n>', 'Max signatures to return (default: 25)', '25')
  .option('-e, --examples <n>', 'Examples per signature (default: 3)', '3')
  .option(
    '--path-prefix <prefix>',
    'Restrict results to processes that touch files under this path prefix (repeatable)',
    (value, previous: string[]) => (Array.isArray(previous) ? [...previous, value] : [value]),
    []
  )
  .option('--min-http-confidence <n>', 'Minimum confidence for HTTP wiring edges (default: 0.9)', '0.9')
  .action(archetypesCommand);

// ─── Direct Tool Commands (no MCP overhead) ────────────────────────
// These invoke LocalBackend directly for use in eval, scripts, and CI.

program
  .command('query <search_query>')
  .description('Search the knowledge graph for execution flows related to a concept')
  .option('-r, --repo <name>', 'Target repository (omit if only one indexed)')
  .option('-c, --context <text>', 'Task context to improve ranking')
  .option('-g, --goal <text>', 'What you want to find')
  .option('-l, --limit <n>', 'Max processes to return (default: 5)')
  .option(
    '--path-prefix <prefix>',
    'Restrict results to files under this path prefix (repeatable)',
    (value, previous: string[]) => (Array.isArray(previous) ? [...previous, value] : [value]),
    []
  )
  .option('--content', 'Include full symbol source code')
  .action(queryCommand);

program
  .command('query-mode <search_query>')
  .description('Kernel query head: top slices, symbols, precedents, and action hints')
  .option('-r, --repo <name>', 'Target repository (omit if only one indexed)')
  .option('-c, --context <text>', 'Task context to improve ranking')
  .option('-g, --goal <text>', 'What you want to find')
  .option('-l, --limit <n>', 'Max processes to return (default: 5)')
  .option('--limit-slices <n>', 'Max slice cards to include (default: 2)')
  .option('--limit-symbols <n>', 'Max symbols to include (default: 12)')
  .option('--limit-precedents <n>', 'Max precedents to include (default: 2)')
  .option('--limit-hops <n>', 'Max action-hint hops to include (default: 4)')
  .option('--no-precedents', 'Disable precedent lookup in query_mode')
  .option('--no-action-hints', 'Disable action-hint synthesis in query_mode')
  .option(
    '--path-prefix <prefix>',
    'Restrict results to files under this path prefix (repeatable)',
    (value, previous: string[]) => (Array.isArray(previous) ? [...previous, value] : [value]),
    []
  )
  .action((searchQuery, options) => queryModeCommand(searchQuery, {
    repo: options.repo,
    context: options.context,
    goal: options.goal,
    limit: options.limit,
    limitSlices: options.limitSlices,
    limitSymbols: options.limitSymbols,
    limitPrecedents: options.limitPrecedents,
    limitHops: options.limitHops,
    includePrecedents: options.precedents,
    includeActionHints: options.actionHints,
    pathPrefix: options.pathPrefix,
  }));

program
  .command('implement-mode <search_query>')
  .description('Kernel implement head: target slice, companions, write anchors, review handoff')
  .option('-r, --repo <name>', 'Target repository (omit if only one indexed)')
  .option('-c, --context <text>', 'Task context to improve ranking')
  .option('-g, --goal <text>', 'What you want to find')
  .option('-l, --limit <n>', 'Max query-head processes to return (default: 5)')
  .option('--limit-companions <n>', 'Max companion files to include (default: 12)')
  .option('--limit-write-anchors <n>', 'Max ordered write anchors (default: 12)')
  .option('--limit-precedents <n>', 'Max precedents to include (default: 3)')
  .option('--limit-hops <n>', 'Max action-hint hops to include (default: 4)')
  .option('--no-precedents', 'Disable precedent lookup in implement_mode')
  .option('--no-action-hints', 'Disable action-hint synthesis in implement_mode')
  .option(
    '--path-prefix <prefix>',
    'Restrict results to files under this path prefix (repeatable)',
    (value, previous: string[]) => (Array.isArray(previous) ? [...previous, value] : [value]),
    []
  )
  .action((searchQuery, options) => implementModeCommand(searchQuery, {
    repo: options.repo,
    context: options.context,
    goal: options.goal,
    limit: options.limit,
    limitCompanions: options.limitCompanions,
    limitWriteAnchors: options.limitWriteAnchors,
    limitPrecedents: options.limitPrecedents,
    limitHops: options.limitHops,
    includePrecedents: options.precedents,
    includeActionHints: options.actionHints,
    pathPrefix: options.pathPrefix,
  }));

program
  .command('review-mode')
  .description('Kernel review head: semantic diffs, risks, proof-pack, and test suggestions')
  .option('-r, --repo <name>', 'Target repository (omit if only one indexed)')
  .option('--scope <scope>', 'Review scope: unstaged|staged|all|compare (default: unstaged)')
  .option('--base-ref <ref>', 'Base ref/commit for compare scope (e.g. origin/main)')
  .option('--limit-symbols <n>', 'Max changed symbols to analyze (default: 60)')
  .option('--limit-callers <n>', 'Max upstream callers per symbol (default: 10)')
  .option('--limit-tests <n>', 'Max suggested tests (default: 10)')
  .option('--min-confidence <n>', 'Minimum confidence for edges (default: 0.9)')
  .option('--no-ui-contracts', 'Disable UI contract diffs')
  .option('--max-ui-contract-files <n>', 'Max UI contract files to analyze (default: 5)')
  .option('--no-evidence-spans', 'Disable proof-pack evidence spans')
  .option('--limit-evidence <n>', 'Max proof-pack symbol/edge evidence entries (default: 40)')
  .option('--no-slice-stencil', 'Disable slice-stencil comparison output')
  .option('--limit-slice-stencil <n>', 'Max changed slices in stencil output (default: 8)')
  .option(
    '--path-prefix <prefix>',
    'Restrict review to files under this path prefix (repeatable)',
    (value, previous: string[]) => (Array.isArray(previous) ? [...previous, value] : [value]),
    []
  )
  .action(options => reviewModeCommand({
    repo: options.repo,
    scope: options.scope,
    baseRef: options.baseRef,
    limitSymbols: options.limitSymbols,
    limitCallers: options.limitCallers,
    limitTests: options.limitTests,
    minConfidence: options.minConfidence,
    includeUiContracts: options.uiContracts,
    maxUiContractFiles: options.maxUiContractFiles,
    includeEvidenceSpans: options.evidenceSpans,
    limitEvidence: options.limitEvidence,
    includeSliceStencil: options.sliceStencil,
    limitSliceStencil: options.limitSliceStencil,
    pathPrefix: options.pathPrefix,
  }));

program
  .command('debug-mode [search_query]')
  .description('Kernel debug head: symptom-first loop localization and ranked hypotheses')
  .option('-r, --repo <name>', 'Target repository (omit if only one indexed)')
  .option('--query <text>', 'Anchor query used to seed debug search')
  .option('--symptom <text>', 'Observed symptom summary (recommended)')
  .option('-c, --context <text>', 'Task context to improve ranking')
  .option('-g, --goal <text>', 'Investigation goal to improve ranking')
  .option('--limit-candidates <n>', 'Max ranked broken-loop candidates (default: 8)')
  .option('--limit-hops <n>', 'Max anchored HTTP hops to include (default: 6)')
  .option('--no-precedents', 'Disable sibling precedent diff')
  .option(
    '--failing-test <id>',
    'Failing test identifier/message (repeatable)',
    (value, previous: string[]) => (Array.isArray(previous) ? [...previous, value] : [value]),
    []
  )
  .option(
    '--error-string <text>',
    'Error string or stack snippet (repeatable)',
    (value, previous: string[]) => (Array.isArray(previous) ? [...previous, value] : [value]),
    []
  )
  .option(
    '--path-prefix <prefix>',
    'Restrict debug analysis to files under this path prefix (repeatable)',
    (value, previous: string[]) => (Array.isArray(previous) ? [...previous, value] : [value]),
    []
  )
  .action((searchQuery, options) => debugModeCommand(searchQuery, {
    repo: options.repo,
    query: options.query,
    symptom: options.symptom,
    context: options.context,
    goal: options.goal,
    limitCandidates: options.limitCandidates,
    limitHops: options.limitHops,
    includePrecedents: options.precedents,
    failingTest: options.failingTest,
    errorString: options.errorString,
    pathPrefix: options.pathPrefix,
  }));

program
  .command('mode-router [search_query]')
  .description('Auto-route into query/implement/review/debug kernel heads')
  .option('-r, --repo <name>', 'Target repository (omit if only one indexed)')
  .option('--mode <mode>', 'Route mode: auto|query|implement|review|debug (default: auto)', 'auto')
  .option('--query <text>', 'Anchor query used by query/implement/debug routes')
  .option('--symptom <text>', 'Observed symptom summary for debug routing')
  .option('-c, --context <text>', 'Task context to improve ranking')
  .option('-g, --goal <text>', 'Routing goal to improve ranking')
  .option('--scope <scope>', 'Review scope when route resolves to review (default: unstaged)')
  .option('--base-ref <ref>', 'Base ref for compare review scope')
  .option(
    '--failing-test <id>',
    'Failing test identifier/message (repeatable)',
    (value, previous: string[]) => (Array.isArray(previous) ? [...previous, value] : [value]),
    []
  )
  .option(
    '--error-string <text>',
    'Error string or stack snippet (repeatable)',
    (value, previous: string[]) => (Array.isArray(previous) ? [...previous, value] : [value]),
    []
  )
  .option(
    '--path-prefix <prefix>',
    'Restrict routing context to files under this path prefix (repeatable)',
    (value, previous: string[]) => (Array.isArray(previous) ? [...previous, value] : [value]),
    []
  )
  .action((searchQuery, options) => modeRouterCommand(searchQuery, {
    repo: options.repo,
    mode: options.mode,
    query: options.query,
    symptom: options.symptom,
    context: options.context,
    goal: options.goal,
    scope: options.scope,
    baseRef: options.baseRef,
    failingTest: options.failingTest,
    errorString: options.errorString,
    pathPrefix: options.pathPrefix,
  }));

program
  .command('precedents <search_query>')
  .description('Precedent/template finder: exemplars with similar anatomy')
  .option('-r, --repo <name>', 'Target repository (omit if only one indexed)')
  .option('-u, --uid <uid>', 'Explicit anchor symbol UID (optional)')
  .option('-l, --limit <n>', 'Max anchor processes to consider (default: 2)', '2')
  .option('-e, --examples <n>', 'Examples per anchor signature (default: 3)', '3')
  .option(
    '--path-prefix <prefix>',
    'Restrict results to precedents that touch files under this path prefix (repeatable)',
    (value, previous: string[]) => (Array.isArray(previous) ? [...previous, value] : [value]),
    []
  )
  .option('--min-http-confidence <n>', 'Minimum confidence for HTTP wiring edges (default: 0.9)', '0.9')
  .action((searchQuery, options) => precedentsCommand(searchQuery, {
    repo: options.repo,
    uid: options.uid,
    limit: options.limit,
    examples: options.examples,
    pathPrefixes: options.pathPrefix,
    minHttpConfidence: options.minHttpConfidence,
  }));

program
  .command('context [name]')
  .description('360-degree view of a code symbol: callers, callees, processes')
  .option('-r, --repo <name>', 'Target repository')
  .option('-u, --uid <uid>', 'Direct symbol UID (zero-ambiguity lookup)')
  .option('-f, --file <path>', 'File path to disambiguate common names')
  .option('--content', 'Include full symbol source code')
  .action(contextCommand);

program
  .command('impact [target]')
  .description('Blast radius analysis: what breaks if you change a symbol')
  .option('-d, --direction <dir>', 'upstream (dependants) or downstream (dependencies)', 'upstream')
  .option('-r, --repo <name>', 'Target repository')
  .option('-u, --uid <uid>', 'Direct symbol UID (zero-ambiguity lookup)')
  .option('-f, --file <path>', 'File path to disambiguate common names')
  .option('--depth <n>', 'Max relationship depth (default: 3)')
  .option('--include-tests', 'Include test files in results')
  .action(impactCommand);

program
  .command('cypher <query>')
  .description('Execute raw Cypher query against the knowledge graph')
  .option('-r, --repo <name>', 'Target repository')
  .action(cypherCommand);

// ─── Eval Server (persistent daemon for SWE-bench) ─────────────────

program
  .command('eval-server')
  .description('Start lightweight HTTP server for fast tool calls during evaluation')
  .option('-p, --port <port>', 'Port number', '4848')
  .option('--idle-timeout <seconds>', 'Auto-shutdown after N seconds idle (0 = disabled)', '0')
  .action(evalServerCommand);

program.parse(process.argv);
