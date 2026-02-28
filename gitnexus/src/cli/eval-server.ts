/**
 * Eval Server — Lightweight HTTP server for SWE-bench evaluation
 * 
 * Keeps KuzuDB warm in memory so tool calls from the agent are near-instant.
 * Designed to run inside Docker containers during SWE-bench evaluation.
 * 
 * KEY DESIGN: Returns LLM-friendly text, not raw JSON.
 * Raw JSON wastes tokens and is hard for models to parse. The text formatter
 * converts structured results into compact, readable output that models
 * can immediately act on. Next-step hints guide the agent through a
 * productive tool-chaining workflow (query → context → impact → fix).
 * 
 * Architecture:
 *   Agent bash cmd → curl localhost:PORT/tool/query → eval-server → LocalBackend → format → text
 * 
 * Usage:
 *   gitnexus eval-server                    # default port 4848
 *   gitnexus eval-server --port 4848        # explicit port
 *   gitnexus eval-server --idle-timeout 300 # auto-shutdown after 300s idle
 * 
 * API:
 *   POST /tool/:name   — Call a tool. Body is JSON arguments. Returns formatted text.
 *   GET  /health       — Health check. Returns {"status":"ok","repos":[...]}
 *   POST /shutdown     — Graceful shutdown.
 */

import http from 'http';
import { LocalBackend } from '../mcp/local/local-backend.js';
import { GITNEXUS_TOOLS } from '../mcp/tools.js';
import { safeStringify } from '../lib/safe-json.js';

export interface EvalServerOptions {
  port?: string;
  idleTimeout?: string;
}

export const EVAL_SERVER_TOOL_NAMES = Array.from(
  new Set(GITNEXUS_TOOLS.map(tool => tool.name)),
);

const EVAL_SERVER_TOOL_NAME_SET = new Set(EVAL_SERVER_TOOL_NAMES);

export function resolveEvalToolName(toolName: string): string {
  const name = String(toolName || '').trim();
  if (!name) {
    throw new Error('Missing tool name');
  }
  if (!EVAL_SERVER_TOOL_NAME_SET.has(name)) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return name;
}

// ─── Text Formatters ──────────────────────────────────────────────────
// Convert structured JSON results into compact, LLM-friendly text.
// Design: minimize tokens, maximize actionability.

function formatQueryResult(result: any): string {
  if (result.error) return `Error: ${result.error}`;

  const lines: string[] = [];
  const processes = result.processes || [];
  const symbols = result.process_symbols || [];
  const defs = result.definitions || [];

  if (processes.length === 0 && defs.length === 0) {
    return 'No matching execution flows found. Try a different search term or use grep.';
  }

  lines.push(`Found ${processes.length} execution flow(s):\n`);

  for (let i = 0; i < processes.length; i++) {
    const p = processes[i];
    lines.push(`${i + 1}. ${p.summary} (${p.step_count} steps, ${p.symbol_count} symbols)`);

    // Show symbols belonging to this process
    const procSymbols = symbols.filter((s: any) => s.process_id === p.id);
    for (const s of procSymbols.slice(0, 6)) {
      const loc = s.startLine ? `:${s.startLine}` : '';
      lines.push(`   ${s.type} ${s.name} → ${s.filePath}${loc}`);
    }
    if (procSymbols.length > 6) {
      lines.push(`   ... and ${procSymbols.length - 6} more`);
    }
    lines.push('');
  }

  if (defs.length > 0) {
    lines.push(`Standalone definitions:`);
    for (const d of defs.slice(0, 8)) {
      lines.push(`  ${d.type || 'Symbol'} ${d.name} → ${d.filePath || '?'}`);
    }
    if (defs.length > 8) lines.push(`  ... and ${defs.length - 8} more`);
  }

  return lines.join('\n').trim();
}

function formatContextResult(result: any): string {
  if (result.error) return `Error: ${result.error}`;

  if (result.status === 'ambiguous') {
    const lines = [`Multiple symbols named '${result.candidates?.[0]?.name || '?'}'. Disambiguate with file path:\n`];
    for (const c of result.candidates || []) {
      lines.push(`  ${c.kind} ${c.name} → ${c.filePath}:${c.line || '?'}  (uid: ${c.uid})`);
    }
    lines.push(`\nRe-run: gitnexus-context "${result.candidates?.[0]?.name}" "<file_path>"`);
    return lines.join('\n');
  }

  const sym = result.symbol;
  if (!sym) return 'Symbol not found.';

  const lines: string[] = [];
  const loc = sym.startLine ? `:${sym.startLine}-${sym.endLine}` : '';
  lines.push(`${sym.kind} ${sym.name} → ${sym.filePath}${loc}`);
  lines.push('');

  // Incoming refs (who calls/imports/extends this)
  const incoming = result.incoming || {};
  const incomingCount = Object.values(incoming).reduce((sum: number, arr: any) => sum + arr.length, 0) as number;
  if (incomingCount > 0) {
    lines.push(`Called/imported by (${incomingCount}):`);
    for (const [relType, refs] of Object.entries(incoming)) {
      for (const ref of (refs as any[]).slice(0, 10)) {
        lines.push(`  ← [${relType}] ${ref.kind} ${ref.name} → ${ref.filePath}`);
      }
    }
    lines.push('');
  }

  // Outgoing refs (what this calls/imports)
  const outgoing = result.outgoing || {};
  const outgoingCount = Object.values(outgoing).reduce((sum: number, arr: any) => sum + arr.length, 0) as number;
  if (outgoingCount > 0) {
    lines.push(`Calls/imports (${outgoingCount}):`);
    for (const [relType, refs] of Object.entries(outgoing)) {
      for (const ref of (refs as any[]).slice(0, 10)) {
        lines.push(`  → [${relType}] ${ref.kind} ${ref.name} → ${ref.filePath}`);
      }
    }
    lines.push('');
  }

  // Processes
  const procs = result.processes || [];
  if (procs.length > 0) {
    lines.push(`Participates in ${procs.length} execution flow(s):`);
    for (const p of procs) {
      lines.push(`  • ${p.name} (step ${p.step_index}/${p.step_count})`);
    }
  }

  if (sym.content) {
    lines.push('');
    lines.push(`Source:`);
    lines.push(sym.content);
  }

  return lines.join('\n').trim();
}

function formatImpactResult(result: any): string {
  if (result.error) return `Error: ${result.error}`;

  const target = result.target;
  const direction = result.direction;
  const byDepth = result.byDepth || {};
  const total = result.impactedCount || 0;

  if (total === 0) {
    return `${target?.name || '?'}: No ${direction} dependencies found. This symbol appears isolated.`;
  }

  const lines: string[] = [];
  const dirLabel = direction === 'upstream' ? 'depends on this (will break if changed)' : 'this depends on';
  lines.push(`Blast radius for ${target?.kind || ''} ${target?.name} (${direction}): ${total} symbol(s) ${dirLabel}\n`);

  const depthLabels: Record<number, string> = {
    1: 'WILL BREAK (direct)',
    2: 'LIKELY AFFECTED (indirect)',
    3: 'MAY NEED TESTING (transitive)',
  };

  for (const depth of [1, 2, 3]) {
    const items = byDepth[depth];
    if (!items || items.length === 0) continue;

    lines.push(`d=${depth}: ${depthLabels[depth] || ''} (${items.length})`);
    for (const item of items.slice(0, 12)) {
      const conf = item.confidence < 1 ? ` (conf: ${item.confidence})` : '';
      lines.push(`  ${item.type} ${item.name} → ${item.filePath} [${item.relationType}]${conf}`);
    }
    if (items.length > 12) {
      lines.push(`  ... and ${items.length - 12} more`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

function formatCypherResult(result: any): string {
  if (result.error) return `Error: ${result.error}`;

  if (Array.isArray(result)) {
    if (result.length === 0) return 'Query returned 0 rows.';
    // Format as simple table
    const keys = Object.keys(result[0]);
    const lines: string[] = [`${result.length} row(s):\n`];
    for (const row of result.slice(0, 30)) {
      const parts = keys.map(k => `${k}: ${row[k]}`);
      lines.push(`  ${parts.join(' | ')}`);
    }
    if (result.length > 30) {
      lines.push(`  ... ${result.length - 30} more rows`);
    }
    return lines.join('\n');
  }

  return typeof result === 'string' ? result : safeStringify(result, 2);
}

function formatDetectChangesResult(result: any): string {
  if (result.error) return `Error: ${result.error}`;

  const summary = result.summary || {};
  const lines: string[] = [];

  if (summary.changed_count === 0) {
    return 'No changes detected.';
  }

  lines.push(`Changes: ${summary.changed_files || 0} files, ${summary.changed_count || 0} symbols`);
  lines.push(`Affected processes: ${summary.affected_count || 0}`);
  lines.push(`Risk level: ${summary.risk_level || 'unknown'}\n`);

  const changed = result.changed_symbols || [];
  if (changed.length > 0) {
    lines.push(`Changed symbols:`);
    for (const s of changed.slice(0, 15)) {
      lines.push(`  ${s.type} ${s.name} → ${s.filePath}`);
    }
    if (changed.length > 15) lines.push(`  ... and ${changed.length - 15} more`);
    lines.push('');
  }

  const affected = result.affected_processes || [];
  if (affected.length > 0) {
    lines.push(`Affected execution flows:`);
    for (const p of affected.slice(0, 10)) {
      const steps = (p.changed_steps || []).map((s: any) => s.symbol).join(', ');
      lines.push(`  • ${p.name} (${p.step_count} steps) — changed: ${steps}`);
    }
  }

  return lines.join('\n').trim();
}

function formatQueryModeResult(result: any): string {
  if (result.error) return `Error: ${result.error}`;

  const payload = result.query_mode || {};
  const plan = payload.query_plan || {};
  const slices = Array.isArray(payload.slices) ? payload.slices : [];
  const symbols = Array.isArray(payload.symbols) ? payload.symbols : [];
  const precedents = Array.isArray(payload.precedents) ? payload.precedents : [];
  const checks = Array.isArray(payload?.action_hints?.checks) ? payload.action_hints.checks : [];

  const lines: string[] = [];
  lines.push(`Query kernel for: ${result.query || '(no query)'}`);
  lines.push(`Intent: ${plan?.intent?.kind || 'unknown'} | Retrieval: ${plan?.retrieval?.mode || 'hybrid'}`);
  lines.push(`Slices: ${slices.length} | Symbols: ${symbols.length} | Precedents: ${precedents.length}`);
  lines.push('');

  if (slices.length > 0) {
    lines.push('Top slices:');
    for (const slice of slices.slice(0, 3)) {
      const label = slice?.label || slice?.uid || 'slice';
      const closure = Number(slice?.closure_score ?? 0);
      const gaps = Number(slice?.gap_signals?.high || 0) + Number(slice?.gap_signals?.deterministic || 0);
      lines.push(`  • ${label} (closure=${closure.toFixed(2)}, severe_gaps=${gaps})`);
    }
    lines.push('');
  }

  if (symbols.length > 0) {
    lines.push('Top symbols:');
    for (const symbol of symbols.slice(0, 8)) {
      lines.push(`  • ${symbol?.kind || symbol?.type || 'Symbol'} ${symbol?.name || '?'} → ${symbol?.filePath || '?'}`);
    }
    lines.push('');
  }

  if (checks.length > 0) {
    lines.push('Action checks:');
    for (const check of checks.slice(0, 6)) lines.push(`  • ${check}`);
  }

  return lines.join('\n').trim();
}

function formatImplementModeResult(result: any): string {
  if (result.error) return `Error: ${result.error}`;

  const payload = result.implement_mode || {};
  const target = payload.target || {};
  const companionFiles = Array.isArray(payload.companion_files) ? payload.companion_files : [];
  const writePlan = Array.isArray(payload.write_plan) ? payload.write_plan : [];
  const hypotheses = Array.isArray(payload.hypotheses) ? payload.hypotheses : [];
  const reviewHandoff = payload.post_edit_review || null;

  const lines: string[] = [];
  lines.push(`Implement kernel for: ${result.query || '(no query)'}`);
  lines.push(`Target: ${target?.slice_label || target?.anchor_name || target?.slice_uid || 'unknown'}`);
  lines.push(`Companions: ${companionFiles.length} | Write anchors: ${writePlan.length}`);
  lines.push('');

  if (companionFiles.length > 0) {
    lines.push('Companion files:');
    for (const item of companionFiles.slice(0, 8)) {
      lines.push(`  • ${item?.filePath || '?'} (score=${Number(item?.score ?? 0).toFixed(2)})`);
    }
    lines.push('');
  }

  if (writePlan.length > 0) {
    lines.push('Write order:');
    for (const anchor of writePlan.slice(0, 8)) {
      lines.push(`  • ${anchor?.name || anchor?.uid || '?'} → ${anchor?.filePath || '?'}`);
    }
    lines.push('');
  }

  if (hypotheses.length > 0) {
    lines.push('Hypotheses:');
    for (const hypothesis of hypotheses.slice(0, 5)) lines.push(`  • ${hypothesis}`);
    lines.push('');
  }

  if (reviewHandoff?.tool) {
    lines.push(`Post-edit handoff: ${reviewHandoff.tool}`);
  }

  return lines.join('\n').trim();
}

function formatReviewModeResult(result: any): string {
  if (result.error) return `Error: ${result.error}`;

  const summary = result.summary || {};
  const kernel = result.review_kernel || {};
  const findings = Array.isArray(kernel.top_findings) ? kernel.top_findings : [];
  const nextActions = Array.isArray(kernel.next_actions) ? kernel.next_actions : [];
  const suggestedTests = Array.isArray(result.suggested_tests) ? result.suggested_tests : [];

  const lines: string[] = [];
  lines.push(`Review kernel (${result.scope || 'unstaged'})`);
  lines.push(`Changed files: ${summary.changed_files || 0} | Changed symbols: ${summary.changed_symbols || 0}`);
  lines.push(`Risk: ${kernel?.risk?.level || 'unknown'} (score=${Number(kernel?.risk?.score || 0).toFixed(2)})`);
  lines.push('');

  if (findings.length > 0) {
    lines.push('Top findings:');
    for (const finding of findings.slice(0, 6)) lines.push(`  • ${finding}`);
    lines.push('');
  }

  if (suggestedTests.length > 0) {
    lines.push('Suggested tests:');
    for (const testCase of suggestedTests.slice(0, 6)) lines.push(`  • ${testCase?.name || testCase?.test || '?'}`);
    lines.push('');
  }

  if (nextActions.length > 0) {
    lines.push('Next actions:');
    for (const action of nextActions.slice(0, 6)) lines.push(`  • ${action}`);
  }

  return lines.join('\n').trim();
}

function formatDebugModeResult(result: any): string {
  if (result.error) return `Error: ${result.error}`;

  const payload = result.debug || {};
  const classification = payload.classification || {};
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const hypotheses = Array.isArray(payload.hypotheses) ? payload.hypotheses : [];
  const nextActions = Array.isArray(payload.next_actions) ? payload.next_actions : [];

  const lines: string[] = [];
  lines.push(`Debug kernel for: ${result.query || '(no query)'}`);
  lines.push(`Symptom family: ${classification.family || 'unknown'} | confidence=${Number(classification.confidence || 0).toFixed(2)}`);
  lines.push(`Candidates: ${candidates.length}`);
  lines.push('');

  if (candidates.length > 0) {
    lines.push('Top broken loops:');
    for (const candidate of candidates.slice(0, 6)) {
      lines.push(`  • [${candidate?.kind || 'candidate'}] score=${Number(candidate?.score || 0).toFixed(2)} — ${candidate?.summary || ''}`);
    }
    lines.push('');
  }

  if (hypotheses.length > 0) {
    lines.push('Hypotheses:');
    for (const hypothesis of hypotheses.slice(0, 6)) lines.push(`  • ${hypothesis}`);
    lines.push('');
  }

  if (nextActions.length > 0) {
    lines.push('Next actions:');
    for (const action of nextActions.slice(0, 6)) lines.push(`  • ${action}`);
  }

  return lines.join('\n').trim();
}

function formatModeRouterResult(result: any): string {
  if (result.error) return `Error: ${result.error}`;

  const payload = result.mode_router || {};
  const trace = payload.route_trace || {};
  const unified = payload.unified || {};
  const candidates = Array.isArray(trace.candidates) ? trace.candidates : [];
  const findings = Array.isArray(unified.top_findings) ? unified.top_findings : [];
  const nextActions = Array.isArray(unified.next_actions) ? unified.next_actions : [];

  const lines: string[] = [];
  lines.push(`Mode router selected: ${payload.selected_mode || 'unknown'}`);
  lines.push(`Requested mode: ${trace.requested_mode || 'auto'} | Fallback applied: ${trace.fallback_applied === true ? 'yes' : 'no'}`);
  lines.push('');

  if (candidates.length > 0) {
    lines.push('Route candidates:');
    for (const candidate of candidates.slice(0, 4)) {
      const reasons = Array.isArray(candidate?.reasons) ? candidate.reasons.slice(0, 2).join('; ') : '';
      lines.push(`  • ${candidate?.mode || '?'} score=${Number(candidate?.score || 0).toFixed(2)}${reasons ? ` — ${reasons}` : ''}`);
    }
    lines.push('');
  }

  if (findings.length > 0) {
    lines.push('Unified findings:');
    for (const finding of findings.slice(0, 6)) lines.push(`  • ${finding}`);
    lines.push('');
  }

  if (nextActions.length > 0) {
    lines.push('Unified next actions:');
    for (const action of nextActions.slice(0, 6)) lines.push(`  • ${action}`);
  }

  return lines.join('\n').trim();
}

function formatListReposResult(result: any): string {
  if (!Array.isArray(result) || result.length === 0) {
    return 'No indexed repositories.';
  }

  const lines = ['Indexed repositories:\n'];
  for (const r of result) {
    const stats = r.stats || {};
    lines.push(`  ${r.name} — ${stats.nodes || '?'} symbols, ${stats.edges || '?'} relationships, ${stats.processes || '?'} flows`);
    lines.push(`    Path: ${r.path}`);
    lines.push(`    Indexed: ${r.indexedAt}`);
  }
  return lines.join('\n');
}

/**
 * Format a tool result as compact, LLM-friendly text.
 */
export function formatToolResult(toolName: string, result: any): string {
  switch (toolName) {
    case 'query': return formatQueryResult(result);
    case 'query_mode': return formatQueryModeResult(result);
    case 'implement_mode': return formatImplementModeResult(result);
    case 'review_mode': return formatReviewModeResult(result);
    case 'debug_mode': return formatDebugModeResult(result);
    case 'mode_router': return formatModeRouterResult(result);
    case 'context': return formatContextResult(result);
    case 'impact': return formatImpactResult(result);
    case 'cypher': return formatCypherResult(result);
    case 'detect_changes': return formatDetectChangesResult(result);
    case 'list_repos': return formatListReposResult(result);
    default: return typeof result === 'string' ? result : safeStringify(result, 2);
  }
}

// ─── Next-Step Hints ──────────────────────────────────────────────────
// Guide the agent to the logical next tool call.
// Critical for tool chaining: query → context → impact → fix.

export function getNextStepHint(toolName: string): string {
  switch (toolName) {
    case 'query':
      return '\n---\nNext: Pick a symbol above and run gitnexus-context "<name>" to see all its callers, callees, and execution flows.';

    case 'query_mode':
      return '\n---\nNext: Move to implement_mode with the same query, then apply edits in write_plan order.';

    case 'implement_mode':
      return '\n---\nNext: Apply the first write anchor, then run review_mode(scope=unstaged) to validate semantic deltas.';

    case 'review_mode':
      return '\n---\nNext: Open top changed symbols with context(), then use impact() on high-risk anchors before patching.';

    case 'debug_mode':
      return '\n---\nNext: Open top broken-loop anchors with context()/impact(), patch the highest-confidence issue, then run review_mode.';

    case 'mode_router':
      return '\n---\nNext: Follow the selected mode output; if confidence is low, force an explicit mode and compare.';

    case 'context':
      return '\n---\nNext: To check what breaks if you change this, run gitnexus-impact "<name>" upstream';

    case 'impact':
      return '\n---\nNext: Review d=1 items first (WILL BREAK). Read the source with cat to understand the code, then make your fix.';

    case 'cypher':
      return '\n---\nNext: To explore a result symbol in depth, run gitnexus-context "<name>"';

    case 'detect_changes':
      return '\n---\nNext: Run gitnexus-context "<symbol>" on high-risk changed symbols to check their callers.';

    default:
      return '';
  }
}

// ─── Server ───────────────────────────────────────────────────────────

export async function evalServerCommand(options?: EvalServerOptions): Promise<void> {
  const port = parseInt(options?.port || '4848');
  const idleTimeoutSec = parseInt(options?.idleTimeout || '0');

  const backend = new LocalBackend();
  const ok = await backend.init();

  if (!ok) {
    console.error('GitNexus eval-server: No indexed repositories found. Run: gitnexus analyze');
    process.exit(1);
  }

  const repos = backend.listRepos();
  console.error(`GitNexus eval-server: ${repos.length} repo(s) loaded: ${repos.map(r => r.name).join(', ')}`);

  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function resetIdleTimer() {
    if (idleTimeoutSec <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      console.error('GitNexus eval-server: Idle timeout reached, shutting down');
      await backend.disconnect();
      process.exit(0);
    }, idleTimeoutSec * 1000);
  }

  const server = http.createServer(async (req, res) => {
    resetIdleTimer();

    try {
      // Health check
      if (req.method === 'GET' && req.url === '/health') {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ok', repos: repos.map(r => r.name) }));
        return;
      }

      if (req.method === 'GET' && req.url === '/tools') {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ tools: EVAL_SERVER_TOOL_NAMES }));
        return;
      }

      // Shutdown
      if (req.method === 'POST' && req.url === '/shutdown') {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'shutting_down' }));
        setTimeout(async () => {
          await backend.disconnect();
          server.close();
          process.exit(0);
        }, 100);
        return;
      }

      // Tool calls: POST /tool/:name
      const toolMatch = req.url?.match(/^\/tool\/(\w+)$/);
      if (req.method === 'POST' && toolMatch) {
        let toolName = '';
        try {
          toolName = resolveEvalToolName(toolMatch[1]);
        } catch (err: any) {
          res.setHeader('Content-Type', 'text/plain');
          res.writeHead(400);
          res.end(`Error: ${String(err?.message || err || 'Invalid tool name')}`);
          return;
        }

        const body = await readBody(req);
        let args: Record<string, any> = {};
        if (body.trim()) {
          try {
            args = JSON.parse(body);
          } catch {
            res.setHeader('Content-Type', 'text/plain');
            res.writeHead(400);
            res.end('Error: Invalid JSON body');
            return;
          }
        }

        // Call tool, format result as text, append next-step hint
        const result = await backend.callTool(toolName, args);
        const formatted = formatToolResult(toolName, result);
        const hint = getNextStepHint(toolName);

        res.setHeader('Content-Type', 'text/plain');
        res.writeHead(200);
        res.end(formatted + hint);
        return;
      }

      // 404
      res.setHeader('Content-Type', 'text/plain');
      res.writeHead(404);
      res.end('Not found. Use POST /tool/:name, GET /tools, or GET /health');

    } catch (err: any) {
      res.setHeader('Content-Type', 'text/plain');
      res.writeHead(500);
      res.end(`Error: ${err.message || 'Internal error'}`);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.error(`GitNexus eval-server: listening on http://127.0.0.1:${port}`);
    console.error(`  POST /tool/query    — search execution flows`);
    console.error(`  POST /tool/query_mode — query kernel head`);
    console.error(`  POST /tool/implement_mode — implement kernel head`);
    console.error(`  POST /tool/review_mode — review kernel head`);
    console.error(`  POST /tool/debug_mode — debug kernel head`);
    console.error(`  POST /tool/mode_router — auto-router kernel head`);
    console.error(`  POST /tool/context  — 360-degree symbol view`);
    console.error(`  POST /tool/impact   — blast radius analysis`);
    console.error(`  POST /tool/cypher   — raw Cypher query`);
    console.error(`  GET  /tools         — list available tools`);
    console.error(`  GET  /health        — health check`);
    console.error(`  POST /shutdown      — graceful shutdown`);
    if (idleTimeoutSec > 0) {
      console.error(`  Auto-shutdown after ${idleTimeoutSec}s idle`);
    }
    try {
      process.stdout.write(`GITNEXUS_EVAL_SERVER_READY:${port}\n`);
    } catch {
      // stdout may not be available
    }
  });

  resetIdleTimer();

  const shutdown = async () => {
    console.error('GitNexus eval-server: shutting down...');
    await backend.disconnect();
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
