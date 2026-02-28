import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { test } from 'node:test';
import {
  buildEpisodeOverlay,
  clearEpisodeGraphState,
  loadEpisodeGraphState,
  recordEpisodeObservation,
  summarizeEpisodeGraphState,
} from '../dist/mcp/local/episode-graph.js';

test('EpisodeGraph sidecar: records observations and produces query overlay', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-episode-'));

  const state1 = await recordEpisodeObservation(tempRoot, {
    tool: 'query',
    targetBranch: 'feature/episode-graph',
    taskId: 'OVERLORD-4',
    openedProcesses: [{ processId: 'proc_login', name: 'Login Flow' }],
    openedSymbols: [
      {
        symbolId: 'Function:apps/dashboard/src/auth.ts:login',
        name: 'login',
        kind: 'Function',
        filePath: 'apps/dashboard/src/auth.ts',
        startLine: 12,
        processId: 'proc_login',
      },
    ],
    openedSpans: [{ filePath: 'apps/dashboard/src/auth.ts', startLine: 12, endLine: 18 }],
    editFiles: ['apps/dashboard/src/auth.ts'],
    witnessPaths: ['AuthForm -> /api/login -> AuthController@login'],
    acceptedHypotheses: ['Missing query invalidation causes stale auth state'],
    failingTests: ['AuthFlowTest::test_login_invalidation'],
    errorStrings: ['TypeError: undefined is not a function'],
  });

  assert.equal(state1.target.branch, 'feature/episode-graph');
  assert.equal(state1.target.taskId, 'OVERLORD-4');
  assert.ok(state1.nodes.length >= 3);
  assert.ok(state1.edges.length >= 1);
  assert.ok(state1.hypotheses.some(item => item.status === 'accepted'));
  assert.ok(state1.failingTests.length >= 1);
  assert.ok(state1.errors.length >= 1);

  const state2 = await recordEpisodeObservation(tempRoot, {
    tool: 'context',
    openedSymbols: [
      {
        symbolId: 'Function:apps/dashboard/src/auth.ts:login',
        name: 'login',
        kind: 'Function',
        filePath: 'apps/dashboard/src/auth.ts',
        startLine: 12,
      },
    ],
    rejectedHypotheses: ['Bug is caused by auth middleware order'],
  });

  const loginNode = state2.nodes.find(node => node.symbolId === 'Function:apps/dashboard/src/auth.ts:login');
  assert.ok(loginNode);
  assert.ok(loginNode.count >= 2);
  assert.ok(state2.hypotheses.some(item => item.status === 'rejected'));

  const loaded = await loadEpisodeGraphState(tempRoot);
  const overlay = buildEpisodeOverlay(loaded);
  assert.ok(overlay.symbolBoosts.has('Function:apps/dashboard/src/auth.ts:login'));
  assert.ok(overlay.fileBoosts.has('apps/dashboard/src/auth.ts'));

  const summary = summarizeEpisodeGraphState(loaded, { limit: 5, includeEvents: true });
  assert.equal(summary.target.branch, 'feature/episode-graph');
  assert.equal(summary.target.taskId, 'OVERLORD-4');
  assert.ok(summary.recent_symbols.length >= 1);
  assert.ok(summary.edit_set.includes('apps/dashboard/src/auth.ts'));
  assert.ok(summary.recent_events.length >= 1);

  const cleared = await clearEpisodeGraphState(tempRoot);
  assert.equal(cleared.nodes.length, 0);
  assert.equal(cleared.edges.length, 0);
});
