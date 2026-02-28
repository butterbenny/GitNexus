/**
 * Direct CLI Tool Commands
 * 
 * Exposes GitNexus tools (query/context/impact/cypher + kernel heads) as direct CLI commands.
 * Bypasses MCP entirely — invokes LocalBackend directly for minimal overhead.
 * 
 * Usage:
 *   gitnexus query "authentication flow"
 *   gitnexus context --name "validateUser"
 *   gitnexus impact --target "AuthService" --direction upstream
 *   gitnexus cypher "MATCH (n:Function) RETURN n.name LIMIT 10"
 *   gitnexus mode-router "auth flow" --mode auto
 * 
 * Note: Output goes to stderr because KuzuDB's native module captures stdout
 * at the OS level during init. This is consistent with augment.ts.
 */

import { LocalBackend } from '../mcp/local/local-backend.js';
import { safeStringify } from '../lib/safe-json.js';

let _backend: LocalBackend | null = null;

async function getBackend(): Promise<LocalBackend> {
  if (_backend) return _backend;
  _backend = new LocalBackend();
  const ok = await _backend.init();
  if (!ok) {
    console.error('GitNexus: No indexed repositories found. Run: gitnexus analyze');
    process.exit(1);
  }
  return _backend;
}

function output(data: any): void {
  const text = typeof data === 'string' ? data : safeStringify(data, 2);
  // stderr because KuzuDB captures stdout at OS level
  process.stderr.write(text + '\n');
}

function parseInteger(value?: string): number | undefined {
  return value ? parseInt(value) : undefined;
}

function parseFloatValue(value?: string): number | undefined {
  return value ? parseFloat(value) : undefined;
}

function normalizeList(value?: string[]): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const normalized = value
    .map(item => String(item || '').trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

export async function queryCommand(queryText: string, options?: {
  repo?: string;
  context?: string;
  goal?: string;
  limit?: string;
  pathPrefix?: string[];
  content?: boolean;
}): Promise<void> {
  if (!queryText?.trim()) {
    console.error('Usage: gitnexus query <search_query>');
    process.exit(1);
  }

  const backend = await getBackend();
  const result = await backend.callTool('query', {
    query: queryText,
    task_context: options?.context,
    goal: options?.goal,
    limit: parseInteger(options?.limit),
    include_content: options?.content ?? false,
    path_prefixes: normalizeList(options?.pathPrefix),
    repo: options?.repo,
  });
  output(result);
}

export async function contextCommand(name: string, options?: {
  repo?: string;
  file?: string;
  uid?: string;
  content?: boolean;
}): Promise<void> {
  if (!name?.trim() && !options?.uid) {
    console.error('Usage: gitnexus context <symbol_name> [--uid <uid>] [--file <path>]');
    process.exit(1);
  }

  const backend = await getBackend();
  const result = await backend.callTool('context', {
    name: name || undefined,
    uid: options?.uid,
    file_path: options?.file,
    include_content: options?.content ?? false,
    repo: options?.repo,
  });
  output(result);
}

export async function impactCommand(target: string | undefined, options?: {
  direction?: string;
  repo?: string;
  uid?: string;
  file?: string;
  depth?: string;
  includeTests?: boolean;
}): Promise<void> {
  const name = target?.trim() || '';
  if (!name && !options?.uid) {
    console.error('Usage: gitnexus impact [symbol_name] [--uid <uid>] [--file <path>] [--direction upstream|downstream]');
    process.exit(1);
  }

  const backend = await getBackend();
  const result = await backend.callTool('impact', {
    target: name || undefined,
    name: name || undefined,
    uid: options?.uid,
    file_path: options?.file,
    direction: options?.direction || 'upstream',
    maxDepth: parseInteger(options?.depth),
    includeTests: options?.includeTests ?? false,
    repo: options?.repo,
  });
  output(result);
}

export async function cypherCommand(query: string, options?: {
  repo?: string;
}): Promise<void> {
  if (!query?.trim()) {
    console.error('Usage: gitnexus cypher <cypher_query>');
    process.exit(1);
  }

  const backend = await getBackend();
  const result = await backend.callTool('cypher', {
    query,
    repo: options?.repo,
  });
  output(result);
}

export async function precedentsCommand(queryText: string, options?: {
  repo?: string;
  uid?: string;
  limit?: string;
  examples?: string;
  pathPrefixes?: string[];
  minHttpConfidence?: string;
}): Promise<void> {
  if (!queryText?.trim()) {
    console.error('Usage: gitnexus precedents <search_query>');
    process.exit(1);
  }

  const backend = await getBackend();
  const result = await backend.callTool('precedents', {
    query: queryText,
    anchor_uid: options?.uid,
    limit: parseInteger(options?.limit),
    examples: parseInteger(options?.examples),
    path_prefixes: normalizeList(options?.pathPrefixes),
    min_http_confidence: parseFloatValue(options?.minHttpConfidence),
    repo: options?.repo,
  });
  output(result);
}

export async function queryModeCommand(queryText: string, options?: {
  repo?: string;
  context?: string;
  goal?: string;
  limit?: string;
  limitSlices?: string;
  limitSymbols?: string;
  limitPrecedents?: string;
  limitHops?: string;
  pathPrefix?: string[];
  includePrecedents?: boolean;
  includeActionHints?: boolean;
}): Promise<void> {
  if (!queryText?.trim()) {
    console.error('Usage: gitnexus query-mode <search_query>');
    process.exit(1);
  }

  const backend = await getBackend();
  const result = await backend.callTool('query_mode', {
    query: queryText,
    task_context: options?.context,
    goal: options?.goal,
    limit: parseInteger(options?.limit),
    limit_slices: parseInteger(options?.limitSlices),
    limit_symbols: parseInteger(options?.limitSymbols),
    limit_precedents: parseInteger(options?.limitPrecedents),
    limit_hops: parseInteger(options?.limitHops),
    path_prefixes: normalizeList(options?.pathPrefix),
    include_precedents: options?.includePrecedents,
    include_action_hints: options?.includeActionHints,
    repo: options?.repo,
  });
  output(result);
}

export async function implementModeCommand(queryText: string, options?: {
  repo?: string;
  context?: string;
  goal?: string;
  limit?: string;
  limitCompanions?: string;
  limitWriteAnchors?: string;
  limitPrecedents?: string;
  limitHops?: string;
  pathPrefix?: string[];
  includePrecedents?: boolean;
  includeActionHints?: boolean;
}): Promise<void> {
  if (!queryText?.trim()) {
    console.error('Usage: gitnexus implement-mode <search_query>');
    process.exit(1);
  }

  const backend = await getBackend();
  const result = await backend.callTool('implement_mode', {
    query: queryText,
    task_context: options?.context,
    goal: options?.goal,
    limit: parseInteger(options?.limit),
    limit_companions: parseInteger(options?.limitCompanions),
    limit_write_anchors: parseInteger(options?.limitWriteAnchors),
    limit_precedents: parseInteger(options?.limitPrecedents),
    limit_hops: parseInteger(options?.limitHops),
    path_prefixes: normalizeList(options?.pathPrefix),
    include_precedents: options?.includePrecedents,
    include_action_hints: options?.includeActionHints,
    repo: options?.repo,
  });
  output(result);
}

export async function reviewModeCommand(options?: {
  repo?: string;
  scope?: string;
  baseRef?: string;
  pathPrefix?: string[];
  limitSymbols?: string;
  limitCallers?: string;
  limitTests?: string;
  minConfidence?: string;
  includeUiContracts?: boolean;
  maxUiContractFiles?: string;
  includeEvidenceSpans?: boolean;
  limitEvidence?: string;
  includeSliceStencil?: boolean;
  limitSliceStencil?: string;
}): Promise<void> {
  const backend = await getBackend();
  const result = await backend.callTool('review_mode', {
    scope: options?.scope,
    base_ref: options?.baseRef,
    path_prefixes: normalizeList(options?.pathPrefix),
    limit_symbols: parseInteger(options?.limitSymbols),
    limit_callers: parseInteger(options?.limitCallers),
    limit_tests: parseInteger(options?.limitTests),
    min_confidence: parseFloatValue(options?.minConfidence),
    include_ui_contracts: options?.includeUiContracts,
    max_ui_contract_files: parseInteger(options?.maxUiContractFiles),
    include_evidence_spans: options?.includeEvidenceSpans,
    limit_evidence: parseInteger(options?.limitEvidence),
    include_slice_stencil: options?.includeSliceStencil,
    limit_slice_stencil: parseInteger(options?.limitSliceStencil),
    repo: options?.repo,
  });
  output(result);
}

export async function debugModeCommand(queryText: string | undefined, options?: {
  repo?: string;
  query?: string;
  symptom?: string;
  context?: string;
  goal?: string;
  pathPrefix?: string[];
  limitCandidates?: string;
  limitHops?: string;
  includePrecedents?: boolean;
  failingTest?: string[];
  errorString?: string[];
}): Promise<void> {
  const query = String(queryText || options?.query || '').trim() || undefined;
  const symptom = String(options?.symptom || '').trim() || undefined;
  if (!query && !symptom) {
    console.error('Usage: gitnexus debug-mode [search_query] --symptom <text>');
    process.exit(1);
  }

  const backend = await getBackend();
  const result = await backend.callTool('debug_mode', {
    query,
    symptom,
    task_context: options?.context,
    goal: options?.goal,
    path_prefixes: normalizeList(options?.pathPrefix),
    limit_candidates: parseInteger(options?.limitCandidates),
    limit_hops: parseInteger(options?.limitHops),
    include_precedents: options?.includePrecedents,
    failing_tests: normalizeList(options?.failingTest),
    error_strings: normalizeList(options?.errorString),
    repo: options?.repo,
  });
  output(result);
}

export async function modeRouterCommand(queryText: string | undefined, options?: {
  repo?: string;
  mode?: string;
  query?: string;
  symptom?: string;
  context?: string;
  goal?: string;
  scope?: string;
  baseRef?: string;
  pathPrefix?: string[];
  failingTest?: string[];
  errorString?: string[];
}): Promise<void> {
  const query = String(queryText || options?.query || '').trim() || undefined;
  const backend = await getBackend();
  const result = await backend.callTool('mode_router', {
    mode: options?.mode,
    query,
    symptom: String(options?.symptom || '').trim() || undefined,
    task_context: options?.context,
    goal: options?.goal,
    scope: options?.scope,
    base_ref: options?.baseRef,
    path_prefixes: normalizeList(options?.pathPrefix),
    failing_tests: normalizeList(options?.failingTest),
    error_strings: normalizeList(options?.errorString),
    repo: options?.repo,
  });
  output(result);
}
