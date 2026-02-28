import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatToolResult, getNextStepHint, EVAL_SERVER_TOOL_NAMES, resolveEvalToolName } from '../dist/cli/eval-server.js';
import { GITNEXUS_TOOLS } from '../dist/mcp/tools.js';

test('Eval server formatter: mode_router kernel output is compact and actionable', () => {
  const text = formatToolResult('mode_router', {
    mode_router: {
      selected_mode: 'debug',
      route_trace: {
        requested_mode: 'auto',
        fallback_applied: false,
        candidates: [
          { mode: 'debug', score: 8, reasons: ['symptom-signal', 'failing-tests'] },
        ],
      },
      unified: {
        top_findings: ['Permission slug resolves but no role grants found.'],
        next_actions: ['Open top candidate with context().'],
      },
    },
  });

  assert.match(text, /Mode router selected: debug/);
  assert.match(text, /Route candidates:/);
  assert.match(text, /Unified findings:/);
  assert.match(getNextStepHint('mode_router'), /Next:/);
});

test('Eval server formatter: kernel heads produce readable summaries', () => {
  const queryText = formatToolResult('query_mode', {
    query: 'fetchAccountNotifications',
    query_mode: {
      query_plan: { intent: { kind: 'entity' }, retrieval: { mode: 'exact' } },
      slices: [{ label: 'notifications.slice', closure_score: 0.85, gap_signals: { high: 1, deterministic: 0 } }],
      symbols: [{ kind: 'Function', name: 'fetchAccountNotifications', filePath: 'src/api/notifications.ts' }],
      precedents: [],
      action_hints: { checks: ['Run context() on top symbol first.'] },
    },
  });
  assert.match(queryText, /Query kernel for:/);
  assert.match(queryText, /Top slices:/);

  const implementText = formatToolResult('implement_mode', {
    query: 'fetchAccountNotifications',
    implement_mode: {
      target: { slice_label: 'notifications.slice' },
      companion_files: [{ filePath: 'src/api/notifications.ts', score: 0.92 }],
      write_plan: [{ name: 'fetchAccountNotifications', filePath: 'src/api/notifications.ts' }],
      hypotheses: ['Top slice has deterministic closure gaps.'],
      post_edit_review: { tool: 'review_mode' },
    },
  });
  assert.match(implementText, /Implement kernel for:/);
  assert.match(implementText, /Post-edit handoff: review_mode/);

  const reviewText = formatToolResult('review_mode', {
    scope: 'unstaged',
    summary: { changed_files: 2, changed_symbols: 3 },
    review_kernel: {
      risk: { level: 'medium', score: 4 },
      top_findings: ['Cache invalidation gap detected.'],
      next_actions: ['Run impact() on changed symbols.'],
    },
    suggested_tests: [{ name: 'NotificationControllerTest::test_forbidden' }],
  });
  assert.match(reviewText, /Review kernel/);
  assert.match(reviewText, /Top findings:/);

  const debugText = formatToolResult('debug_mode', {
    query: 'fetchAccountNotifications',
    debug: {
      classification: { family: 'auth', confidence: 0.9 },
      candidates: [{ kind: 'permission_chain', score: 9, summary: 'Missing role grant closure' }],
      hypotheses: ['Permission slug resolves, but no role grants exist.'],
      next_actions: ['Open candidate evidence spans with context().'],
    },
  });
  assert.match(debugText, /Debug kernel for:/);
  assert.match(debugText, /Top broken loops:/);
});

test('Eval server tool registry: stays in parity with MCP tools and validates names', () => {
  const mcpToolNames = GITNEXUS_TOOLS.map(tool => tool.name).sort();
  const evalToolNames = [...EVAL_SERVER_TOOL_NAMES].sort();
  assert.deepEqual(evalToolNames, mcpToolNames);

  assert.equal(resolveEvalToolName(' mode_router '), 'mode_router');
  assert.throws(() => resolveEvalToolName(''), /Missing tool name/);
  assert.throws(() => resolveEvalToolName('not_a_tool'), /Unknown tool/);
});
